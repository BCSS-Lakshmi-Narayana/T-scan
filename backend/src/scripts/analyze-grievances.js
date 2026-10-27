/**
 * Run the sentiment-service pipeline over the latest N grievances and print
 * what it produced, so a pipeline change can be eyeballed against real posts.
 *
 *   node src/scripts/analyze-grievances.js --tenant t-scan
 *   node src/scripts/analyze-grievances.js --tenant t-scan --limit 50 --reset
 *   node src/scripts/analyze-grievances.js --tenant t-scan --platform facebook --out report.json
 *
 * Flags:
 *   --tenant <slug|id>   required; the tenant whose grievances are analysed
 *   --limit <n>          how many of the newest grievances to take (default 50)
 *   --reset              re-analyse even grievances already marked done
 *   --clear              wipe the stored analysis first, so nothing from an
 *                        earlier run can survive (implies --reset)
 *   --district <name>    restrict to one district (repeatable)
 *   --platform <x|facebook|whatsapp>
 *   --out <file>         also write the full result rows as JSON
 *   --dry-run            select and report only; send nothing to the service
 *
 * This drives the real pipeline — store.claim, the grievance target's prepare /
 * persist, and processBatch — rather than a parallel copy, so what it prints is
 * what the running backend would have written.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const connectDB = require('../config/db');
const { runWithTenant } = require('../config/tenantContext');
const { forTenant, dbNameFor } = require('../config/tenantConnections');

// Models self-register on the tenant connection; load them all as the app does.
for (const f of fs.readdirSync(path.join(__dirname, '..', 'models'))) {
  if (f.endsWith('.js')) { try { require(`../models/${f}`); } catch (_) { /* not a model */ } }
}
const Tenant = require('../models/Tenant');
const Grievance = require('../models/Grievance');

const store = require('../services/sentiment/sentiment.store');
const { grievance: target } = require('../services/sentiment/sentiment.targets');
const { processBatch } = require('../services/sentiment/sentiment.pipeline');
const tenantContextService = require('../services/pipeline/tenantContextService');
const http = require('../services/sentiment/sentiment.http');

/* ─── args ─── */
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const optAll = (name) => argv.reduce(
  (acc, a, i) => (a === `--${name}` && argv[i + 1] && !argv[i + 1].startsWith('--') ? [...acc, argv[i + 1]] : acc),
  [],
);

const tenantArg = opt('tenant');
const limit = Math.max(1, Number(opt('limit', 50)) || 50);
const clear = flag('clear');
const reset = flag('reset') || clear;
const dryRun = flag('dry-run');
const districts = optAll('district');
const platform = opt('platform');
const outFile = opt('out');

/* ─── display helpers ─── */
const clip = (s, n) => {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}~`;
};
const pad = (s, n) => String(s === null || s === undefined ? '' : s).padEnd(n).slice(0, n);
const RULE = (n = 150) => '-'.repeat(n);

const SENTIMENT_MARK = { positive: '+', negative: '-', neutral: '=' };
const tally = (rows, pick) => rows.reduce((m, r) => {
  const k = pick(r) || 'none';
  m[k] = (m[k] || 0) + 1;
  return m;
}, {});
const fmtTally = (t) => Object.entries(t).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ') || 'none';

/* ─── main ─── */
const main = async () => {
  if (!tenantArg) {
    console.error('Missing --tenant <slug>. Example:');
    console.error('  node src/scripts/analyze-grievances.js --tenant t-scan --limit 50 --reset');
    process.exit(1);
  }

  await connectDB();
  const tenant = await Tenant.findOne({ $or: [{ slug: tenantArg }, { id: tenantArg }] })
    .select('id slug name type db_name').lean();
  if (!tenant) {
    console.error(`No tenant matched "${tenantArg}".`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`tenant   : ${tenant.slug} (${tenant.id}) -> ${dbNameFor(tenant)}`);
  console.log(`service  : ${process.env.SENTIMENT_SERVICE_URL || '(SENTIMENT_SERVICE_URL unset)'}`);

  // Fail early and clearly rather than letting 50 posts burn their attempts.
  if (!dryRun) {
    try {
      const health = await http.getHealth();
      console.log(`health   : ${health?.status || 'ok'}${health?.model ? ` · model=${health.model}` : ''}`);
    } catch (err) {
      console.error(`\nSentiment service is not reachable: ${err.message}`);
      console.error('Start it first, or re-run with --dry-run to inspect the selection only.');
      await mongoose.disconnect();
      process.exit(1);
    }
  }

  await runWithTenant({ tenant, tenantId: tenant.id, connection: forTenant(tenant) }, async () => {
    /* 1. Select the newest N grievances the pipeline would consider. */
    const selector = { tenant_id: tenant.id, is_active: true };
    if (districts.length) selector.districts = { $in: districts };
    if (platform) selector.platform = platform;

    const picked = await Grievance.find(selector)
      .select('id analysis_status post_date created_at')
      .sort({ post_date: -1, created_at: -1, id: -1 })
      .limit(limit)
      .lean();

    if (!picked.length) {
      console.log('\nNo grievances matched that selection.');
      return;
    }
    const ids = picked.map((d) => d.id);
    console.log(`selected : ${ids.length} grievance(s)  ${fmtTally(tally(picked, (r) => r.analysis_status || 'no-status'))}`);
    if (districts.length) console.log(`district : ${districts.join(', ')}`);
    if (platform) console.log(`platform : ${platform}`);

    if (dryRun) {
      console.log('\n--dry-run: nothing sent to the service.');
      return;
    }

    /* 2. Requeue. --reset re-analyses everything picked; otherwise only what is
          not already done is touched, so a plain re-run is cheap. */
    const requeue = reset
      ? { tenant_id: tenant.id, id: { $in: ids } }
      : { tenant_id: tenant.id, id: { $in: ids }, analysis_status: { $ne: 'done' } };
    // --clear removes the whole analysis subdocument, so what comes back is
    // produced entirely by this run rather than merged over an older one.
    if (clear) {
      const wiped = await Grievance.collection.updateMany(
        { tenant_id: tenant.id, id: { $in: ids } },
        { $unset: { analysis: '' } },
      );
      console.log(`cleared  : ${wiped.modifiedCount} stored analysis block(s)`);
    }

    const res = await Grievance.collection.updateMany(requeue, {
      $set: { analysis_status: 'pending', analysis_attempts: 0, analysis_retries: 0, analysis_error: null },
      $unset: { analysis_claim_token: '', analysis_claimed_at: '', analysis_next_attempt_at: '' },
    });
    console.log(`requeued : ${res.modifiedCount} (${reset ? 'reset: all picked' : 'only not-yet-done'})\n`);

    /* 3. Drive the real pipeline, restricted to exactly these ids. */
    const ctx = await tenantContextService.getContext(tenant.id);
    if (!ctx) throw new Error('tenant context unavailable');

    const t = { claimed: 0, done: 0, skipped: 0, retried: 0, failedAttempts: 0, lost: 0, reaped: 0 };
    const startedAt = Date.now();
    const scopeToPicked = { ...(target.claimFilter || {}), id: { $in: ids } };
    // Bounded so a service outage ends the run instead of spinning on backoff.
    const MAX_ROUNDS = Math.max(4, Math.ceil(ids.length / 10) + 4);

    for (let round = 0; round < MAX_ROUNDS; round++) {
      let claimedThisRound = 0;
      let stop = false;

      for (const lane of ['routine', 'bulk']) {
        const { token, docs } = await store.claim(Grievance, tenant.id, {
          lane,
          limit: 20,
          select: target.select,
          extraFilter: scopeToPicked,
        });
        if (!docs.length) continue;
        claimedThisRound += docs.length;
        t.claimed += docs.length;
        process.stdout.write(`  round ${round + 1} ${pad(lane, 8)} claimed ${pad(docs.length, 3)} ... `);

        const { backpressure } = await processBatch(target, tenant.id, token, docs, lane, ctx, t);
        console.log(`done=${t.done} skipped=${t.skipped} retried=${t.retried}`);
        if (backpressure) {
          console.log('  service is busy or down - stopping; the requeued posts keep their backoff.');
          stop = true;
          break;
        }
      }
      if (stop || claimedThisRound === 0) break;
    }
    const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);

    /* 4. Read back and report. */
    const rows = await Grievance.find({ tenant_id: tenant.id, id: { $in: ids } })
      .select('id platform posted_by post_date created_at districts content analysis analysis_status analysis_error analysis_attempts')
      .lean();
    const order = new Map(ids.map((id, i) => [id, i]));
    rows.sort((a, b) => order.get(a.id) - order.get(b.id));

    console.log(`\n${RULE()}`);
    console.log(
      pad('#', 4) + pad('PLATFORM', 10) + pad('HANDLE', 20) + pad('SENT', 6)
      + pad('RISK', 10) + pad('CATEGORY', 18) + pad('STATUS', 10) + 'TEXT',
    );
    console.log(RULE());

    rows.forEach((r, i) => {
      const a = r.analysis || {};
      const sent = a.sentiment
        ? `${SENTIMENT_MARK[a.sentiment] || ' '}${String(a.sentiment)[0].toUpperCase()}`
        : '-';
      const risk = a.risk_level ? `${a.risk_level}/${a.risk_score === undefined || a.risk_score === null ? '?' : a.risk_score}` : '-';
      const text = r.content?.full_text || r.content?.text || '';
      console.log(
        pad(i + 1, 4)
        + pad(r.platform || '-', 10)
        + pad(`@${String(r.posted_by?.handle || '-').replace(/^@/, '')}`, 20)
        + pad(sent, 6)
        + pad(risk, 10)
        + pad(clip(a.category, 17), 18)
        + pad(r.analysis_status || '-', 10)
        + clip(text, 60),
      );
    });

    console.log(`${RULE()}\n`);
    console.log(`run       : claimed=${t.claimed} done=${t.done} skipped=${t.skipped} retried=${t.retried} lost-claims=${t.lost} in ${elapsedS}s`);
    console.log(`status    : ${fmtTally(tally(rows, (r) => r.analysis_status))}`);
    console.log(`sentiment : ${fmtTally(tally(rows.filter((r) => r.analysis?.sentiment), (r) => r.analysis.sentiment))}`);
    console.log(`risk      : ${fmtTally(tally(rows.filter((r) => r.analysis?.risk_level), (r) => r.analysis.risk_level))}`);
    console.log(`category  : ${fmtTally(tally(rows.filter((r) => r.analysis?.category), (r) => r.analysis.category))}`);

    const unfinished = rows.filter((r) => r.analysis_status !== 'done');
    if (unfinished.length) {
      console.log(`\nnot analysed (${unfinished.length}):`);
      for (const r of unfinished) {
        console.log(`  ${pad(r.analysis_status, 10)} attempts=${r.analysis_attempts || 0}  ${r.id}  ${clip(r.analysis_error || '-', 70)}`);
      }
    }

    if (outFile) {
      const full = rows.map((r) => ({
        id: r.id,
        platform: r.platform,
        handle: r.posted_by?.handle || null,
        post_date: r.post_date,
        districts: r.districts || [],
        text: r.content?.full_text || r.content?.text || '',
        analysis_status: r.analysis_status,
        analysis_error: r.analysis_error || null,
        analysis: r.analysis || null,
      }));
      fs.writeFileSync(path.resolve(outFile), JSON.stringify(full, null, 2), 'utf8');
      console.log(`\nwrote ${full.length} row(s) to ${path.resolve(outFile)}`);
    }
  });

  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error('\nFailed:', err.message);
  console.error(err.stack);
  try { await mongoose.disconnect(); } catch (_) { /* already down */ }
  process.exit(1);
});
