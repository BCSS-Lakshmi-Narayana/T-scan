/**
 * Live end-to-end test of the sentiment pipeline across tenants and districts.
 *
 *   node src/scripts/e2e-sentiment-multitenant.js          # run, verify, clean up
 *   node src/scripts/e2e-sentiment-multitenant.js --keep   # leave test data for inspection
 *
 * Uses the REAL sentiment service (SENTIMENT_SERVICE_URL) and REAL per-tenant
 * databases. Creates two throwaway police tenants (status 'suspended', so no
 * backend scheduler touches them), each with its own districts, policies,
 * keywords, district threshold overrides, sources, posts and comments. Runs both tenants' pipelines concurrently, then district-officer
 * investigations and a district-scoped rescan, and verifies the stored results.
 * Never touches real tenants.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const connectDB = require('../config/db');
const { runWithTenant } = require('../config/tenantContext');
const { forTenant, dbNameFor } = require('../config/tenantConnections');

for (const f of fs.readdirSync(path.join(__dirname, '..', 'models'))) {
  if (f.endsWith('.js')) { try { require(`../models/${f}`); } catch (_) { /* not a model */ } }
}
const Tenant = require('../models/Tenant');
const Settings = require('../models/Settings');
const PolicyMapping = require('../models/PolicyMapping');
const Keyword = require('../models/Keyword');
const Source = require('../models/Source');
const Content = require('../models/Content');
const Comment = require('../models/Comment');
const Analysis = require('../models/Analysis');
const Alert = require('../models/Alert');
const mappingService = require('../services/mappingService');
const sentiment = require('../services/sentiment');
const { rescanContent } = require('../services/monitorService');

const KEEP = process.argv.includes('--keep');
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS) || 40 * 60 * 1000;
const STAMP = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Scenario ───────────────────────────────────────────────────────────────

const TENANTS = [
  {
    key: 'A',
    slug: `e2e-sent-a-${STAMP}`,
    state: 'Telangana',
    districts: ['Hyderabad', 'Warangal'],
    // District officer in Warangal lowered their thresholds.
    districtThresholds: { Warangal: { high: 30, medium: 10 } },
    policies: [
      { category_id: 'Communal_Violence_A', definition: 'Incites violence between religious or caste communities.', severity_level: 'High',
        districts: [], legal_sections: [{ id: 'BNS_196', code: '196', title: 'Promoting enmity' }], platform_policies: { x: [{ id: 'VIOLENT_SPEECH', name: 'Violent Speech' }] } },
      { category_id: 'Public_Order_A', definition: 'Calls to block roads, bandhs, or gather to confront police.', severity_level: 'Medium',
        districts: [], legal_sections: [{ id: 'BNS_189', code: '189', title: 'Unlawful assembly' }], platform_policies: {} },
      { category_id: 'Hyderabad_Traffic_Local', definition: 'Hyderabad-only: traffic and civic nuisance complaints.', severity_level: 'Low',
        districts: ['Hyderabad'], legal_sections: [], platform_policies: {} },
    ],
    keywords: [
      { keyword: 'rally', category: 'other', weight: 90, districts: ['Hyderabad'] },
      { keyword: 'burn', category: 'violence', weight: 95, districts: [] },
    ],
    posts: {
      Hyderabad: [
        'Traffic jam near Ameerpet again today, completely stuck for an hour',
        'Beautiful sunset at Hussain Sagar this evening',
        'Everyone come to the rally tomorrow and teach the police a lesson, block every road',
        'Great cricket match at Uppal stadium, fantastic atmosphere',
        'Thanks to the traffic police for clearing the junction so quickly',
        'We will burn their shops if they come to our area again',
        'ప్రభుత్వం ప్రకటించిన కొత్త పథకం చాలా బాగుంది',
        'Power cut in Kukatpally for six hours, no response from officials',
        'sab log kal rally mein aao, police ko sabak sikhana hai',
        'New metro timings announced for weekends',
        'The food at this new restaurant in Banjara Hills is amazing',
        'Water logging near Mehdipatnam after heavy rain',
        'Join the peaceful candle rally for road safety awareness this Sunday',
        'Those people should be driven out of this city, they do not belong here',
        'Hyderabad biryani festival starts this weekend',
        'Potholes on the flyover are causing accidents daily',
        'Students celebrating results outside the college',
        'Local market prices have gone up again this week',
      ],
      Warangal: [
        'Kakatiya festival celebrations were wonderful this year',
        'Road near the bus stand is completely broken, officials ignore complaints',
        'Gather at the collectorate at 10am, we will not leave until demands are met',
        'Farmers are protesting peacefully about crop prices',
        'Heavy rains flooded the low lying colonies',
      ],
    },
    events: [
      'Massive crowd expected at the assembly session protest tomorrow',
      'Assembly session debate on the new budget was productive',
      'Call to surround the assembly and stop the session by force',
      'Live updates from the monsoon session of the assembly',
    ],
    comments: ['This is completely unacceptable', 'Great work by the officers', 'They should all be arrested immediately'],
  },
  {
    key: 'B',
    slug: `e2e-sent-b-${STAMP}`,
    state: 'Andhra Pradesh',
    districts: ['Vijayawada', 'Guntur'],
    districtThresholds: {},
    policies: [
      { category_id: 'Financial_Fraud_B', definition: 'Investment scams, fake schemes, and money fraud.', severity_level: 'High',
        districts: [], legal_sections: [{ id: 'BNS_318', code: '318', title: 'Cheating' }], platform_policies: { facebook: [{ id: 'FRAUD', name: 'Fraud and Deception' }] } },
      { category_id: 'Guntur_Sand_Mining_Local', definition: 'Guntur-only: illegal sand mining reports.', severity_level: 'Medium',
        districts: ['Guntur'], legal_sections: [], platform_policies: {} },
    ],
    keywords: [
      { keyword: 'scam', category: 'other', weight: 85, districts: [] },
    ],
    posts: {
      Vijayawada: [
        'Invest 10000 today and get 1 lakh in a week, guaranteed returns, DM now',
        'Prakasam barrage looks beautiful with all gates open',
        'This investment scheme is a total scam, they took my savings',
        'Durga temple festival arrangements are very good this year',
        'Traffic diversions near Benz circle for flyover work',
        'Beware of fake loan apps calling and threatening people',
        'Great service at the new government hospital',
        'Cyber crime police arrested a gang running fake job offers',
      ],
      Guntur: [
        'Illegal sand mining trucks running all night near the river',
        'Chilli market prices are good this season for farmers',
        'Someone is threatening shopkeepers for money in the old town',
        'College sports day was a great event',
      ],
    },
    events: [],
    comments: [],
  },
];

// ── Results ────────────────────────────────────────────────────────────────

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const scope = (t) => ({ tenant: t.doc, tenantId: t.doc.id, connection: forTenant(t.doc) });
const inTenant = (t, fn) => runWithTenant(scope(t), fn);

// mappingService's periodic reload only reads active tenants; keep the test
// tenants' mappings in its cache for the lifetime of this process.
const testMappings = new Map();
const originalLoad = mappingService.loadMappings.bind(mappingService);
mappingService.loadMappings = async () => {
  await originalLoad();
  pinMappings();
};
// The initial load started when the module was required and can finish after
// seeding, replacing the cache; re-pin before every use.
const pinMappings = () => {
  for (const [id, rows] of testMappings) mappingService.byTenant.set(id, rows);
};

// ── Seed ───────────────────────────────────────────────────────────────────

const seed = async (t) => {
  t.doc = (await Tenant.create({ slug: t.slug, name: `E2E Sentiment ${t.key}`, type: 'police', status: 'suspended' })).toObject();
  t.ids = { contentByDistrict: {}, events: [], short: null, comments: [] };

  await inTenant(t, async () => {
    const tid = t.doc.id;
    await Settings.create({ tenant_id: tid, district: '', high_risk_threshold: 70, medium_risk_threshold: 40,
      risk_threshold_high: 70, risk_threshold_medium: 40, enable_email_alerts: false, velocity_alerts_enabled: false });
    for (const [district, th] of Object.entries(t.districtThresholds)) {
      await Settings.create({ tenant_id: tid, district, high_risk_threshold: th.high, medium_risk_threshold: th.medium,
        risk_threshold_high: th.high, risk_threshold_medium: th.medium, enable_email_alerts: false, velocity_alerts_enabled: false });
    }

    const rows = [];
    for (const p of t.policies) {
      rows.push(await PolicyMapping.create({ tenant_id: tid, keywords: [], is_active: true, state: t.state, ...p }));
    }
    testMappings.set(tid, rows.map((r) => mappingService.constructor.shape(r.toObject())));
    mappingService.byTenant.set(tid, testMappings.get(tid));

    for (const k of t.keywords) await Keyword.create({ tenant_id: tid, language: 'en', is_active: true, ...k });

    let n = 0;
    for (const district of t.districts) {
      const src = await Source.create({ tenant_id: tid, platform: 'x', identifier: `e2e_${t.key}_${district}`.toLowerCase(),
        display_name: `E2E ${district}`, created_by: 'e2e', category: 'political', is_active: false, state: t.state, districts: [district] });
      t.ids.contentByDistrict[district] = [];
      for (const text of t.posts[district] || []) {
        n += 1;
        const c = await Content.create({ tenant_id: tid, source_id: src.id, districts: [district], state: t.state, platform: 'x',
          content_id: `e2e-${t.key}-${n}`, content_url: `https://x.com/e2e/status/${t.key}${n}`, text,
          author: `author_${n}`, author_handle: `author_${n}`, published_at: new Date() });
        t.ids.contentByDistrict[district].push(c.id);
      }
    }
    for (const text of t.events) {
      n += 1;
      const c = await Content.create({ tenant_id: tid, platform: 'x', content_id: `e2e-${t.key}-${n}`,
        content_url: `https://x.com/e2e/status/${t.key}${n}`, text, author: 'event_author', author_handle: 'event_author',
        published_at: new Date(), event_ids: ['e2e-event'] });
      t.ids.events.push(c.id);
    }
    n += 1;
    const short = await Content.create({ tenant_id: tid, platform: 'x', content_id: `e2e-${t.key}-${n}`,
      content_url: `https://x.com/e2e/status/${t.key}${n}`, text: '..', author: 'short', author_handle: 'short', published_at: new Date() });
    t.ids.short = short.id;

    const parent = t.ids.contentByDistrict[t.districts[0]][0];
    for (const [i, text] of t.comments.entries()) {
      const c = await Comment.create({ tenant_id: tid, content_id: parent, video_id: `e2e-v-${t.key}`, comment_id: `e2e-c-${t.key}-${i}-${STAMP}`,
        author_channel_id: `ch_${i}`, author_display_name: `commenter_${i}`, text, published_at: new Date() });
      t.ids.comments.push(c.id);
    }
  });
};

// ── Drive ──────────────────────────────────────────────────────────────────

const outstanding = (t) => inTenant(t, async () => {
  const q = { tenant_id: t.doc.id, analysis_status: { $in: ['pending', 'processing'] } };
  return (await Content.countDocuments(q)) + (await Comment.countDocuments(q));
});

const drain = async (t, deadline) => {
  let rounds = 0;
  for (;;) {
    const left = await outstanding(t);
    if (left === 0) return { rounds, left };
    if (Date.now() > deadline) return { rounds, left };
    rounds += 1;
    pinMappings();
    const tally = await inTenant(t, () => sentiment.runTenant(t.doc));
    if (tally && tally.claimed) {
      console.log(`  [${t.key}] round ${rounds}: claimed=${tally.claimed} done=${tally.done} skipped=${tally.skipped} retried=${tally.retried}  (outstanding before: ${left})`);
    } else {
      await sleep(5000); // items in retry backoff
    }
  }
};

// ── Verify ─────────────────────────────────────────────────────────────────

const verifyTenant = async (t, other) => {
  console.log(`\nTenant ${t.key} (${t.slug} → ${dbNameFor(t.doc)})`);
  await inTenant(t, async () => {
    const tid = t.doc.id;
    const contents = await Content.find({ tenant_id: tid }).lean();
    const analyses = await Analysis.find({ tenant_id: tid }).lean();
    const alerts = await Alert.find({ tenant_id: tid }).lean();
    const byContent = new Map(analyses.map((a) => [a.content_id, a]));

    // Status
    const statusCounts = contents.reduce((m, c) => ({ ...m, [c.analysis_status]: (m[c.analysis_status] || 0) + 1 }), {});
    check('every post settled (none pending/processing/failed)', !statusCounts.pending && !statusCounts.processing && !statusCounts.failed, JSON.stringify(statusCounts));
    check('too-short post skipped without a service call', contents.find((c) => c.id === t.ids.short)?.analysis_status === 'skipped');

    // One analysis per post
    const done = contents.filter((c) => c.analysis_status === 'done');
    const dupes = analyses.length - new Set(analyses.map((a) => a.content_id)).size;
    check('exactly one Analysis row per analysed post', analyses.length === done.length && dupes === 0, `${analyses.length} rows / ${done.length} done / ${dupes} duplicates`);

    // Data isolation inside this tenant's database
    const foreign = [...contents, ...analyses, ...alerts].filter((d) => d.tenant_id !== tid).length;
    check('database holds only this tenant\'s documents', foreign === 0, `${foreign} foreign`);
    const otherIds = await inTenant(other, async () => Content.countDocuments({ id: { $in: contents.map((c) => c.id) } }));
    check('none of these posts exist in the other tenant\'s database', otherIds === 0);

    // Category isolation
    const ownCats = new Set([...t.policies.map((p) => p.category_id), 'Normal']);
    const otherCats = new Set(other.policies.map((p) => p.category_id));
    const cats = analyses.map((a) => a.category);
    check('categories come only from this tenant\'s policy pack', cats.every((c) => ownCats.has(c)), [...new Set(cats)].join(', '));
    check('no category from the other tenant', !cats.some((c) => otherCats.has(c)));

    // District policy isolation
    for (const p of t.policies.filter((x) => x.districts.length)) {
      const outside = analyses.filter((a) => a.category === p.category_id && !(a.districts || []).some((d) => p.districts.includes(d)));
      check(`district policy ${p.category_id} never applied outside ${p.districts.join('/')}`, outside.length === 0, `${outside.length} violations`);
    }

    // Legal sections belong to this tenant
    const ownCodes = new Set(t.policies.flatMap((p) => p.legal_sections.map((l) => l.code)));
    const codes = analyses.flatMap((a) => (a.legal_sections || []).map((l) => l.section));
    check('legal sections come only from this tenant\'s policies', codes.every((c) => ownCodes.has(c)), `${codes.length} section(s): ${[...new Set(codes)].join(', ') || '—'}`);

    // Thresholds per district
    let thresholdMismatch = 0;
    for (const c of done) {
      const a = byContent.get(c.id);
      const d = (c.districts || [])[0];
      const th = t.districtThresholds[d] || { high: 70, medium: 40 };
      const expected = a.risk_score >= th.high ? 'high' : a.risk_score >= th.medium ? 'medium' : 'low';
      if (a.risk_level !== expected) thresholdMismatch += 1;
    }
    check('risk level follows each district\'s own thresholds', thresholdMismatch === 0, `${thresholdMismatch} mismatch(es)`);

    // No boosting: stored scores equal the service's assessment
    const boosted = done.filter((c) => {
      const a = byContent.get(c.id);
      return a.risk_score !== c.risk_score || a.llm_analysis?.score !== a.risk_score;
    });
    check('content, analysis and service scores agree (no keyword/viral boost)', boosted.length === 0, `${boosted.length} differ`);
    const badFactors = done.filter((c) => (c.risk_factors || []).some((f) => !c.text.toLowerCase().includes(f.keyword.toLowerCase())));
    check('detected keywords are tenant keywords present in the post', badFactors.length === 0);

    // Alerts
    const alertCount = new Map();
    alerts.forEach((a) => alertCount.set(a.content_id, (alertCount.get(a.content_id) || 0) + 1));
    const monitored = done.filter((c) => c.source_id);
    check('every analysed monitored post has exactly one alert (low risk included)', monitored.every((c) => alertCount.get(c.id) === 1),
      `${alerts.length} alerts for ${monitored.length} monitored posts`);
    check('event posts raised no alerts', t.ids.events.every((id) => !alertCount.has(id)));
    const levelMismatch = alerts.filter((al) => {
      const a = byContent.get(al.content_id);
      return a && al.risk_level !== (a.risk_level === 'critical' ? 'high' : a.risk_level);
    });
    check('alert risk levels match the analysis', levelMismatch.length === 0);

    // Provenance
    const bad = analyses.filter((a) => a.analysis_source !== 'sentiment-service' || typeof a.sentiment_confidence !== 'number' || !a.language || !a.model);
    check('every analysis came from the sentiment service with confidence, language and model', bad.length === 0, `${bad.length} incomplete`);

    // Comments
    const comments = await Comment.find({ tenant_id: tid }).lean();
    if (comments.length) {
      check('comments analysed', comments.every((c) => c.analysis_status === 'done' && c.sentiment && typeof c.threat_score === 'number'), `${comments.length} comment(s)`);
    }

    // Sample output
    console.log('  sample results:');
    done.filter((c) => c.source_id).slice(0, 6).forEach((c) => {
      const a = byContent.get(c.id);
      console.log(`    [${(c.districts || [])[0]}] ${a.sentiment}/${Math.round((a.sentiment_confidence || 0) * 100)}% risk=${a.risk_score} ${a.risk_level} cat=${a.category} lang=${a.language} action=${a.recommended_action} :: ${c.text.slice(0, 60)}`);
    });
  });
};

// ── District officers: investigation + scoped rescan ───────────────────────

const officerChecks = async (t) => {
  const districtPolicies = t.policies.filter((p) => p.districts.length);
  if (!districtPolicies.length) return;
  const policy = districtPolicies[0];
  const insider = policy.districts[0];
  const outsider = t.districts.find((d) => !policy.districts.includes(d));
  console.log(`\nTenant ${t.key}: district officers (${insider} vs ${outsider})`);

  pinMappings();
  await inTenant(t, async () => {
    const { buildPolicyPack } = require('../services/sentiment/sentiment.policyPack');
    const inPack = buildPolicyPack(t.doc.id, [insider]).categories.map((c) => c.id);
    const outPack = buildPolicyPack(t.doc.id, [outsider]).categories.map((c) => c.id);
    check(`${insider} officer's pack includes ${policy.category_id}`, inPack.includes(policy.category_id));
    check(`${outsider} officer's pack excludes ${policy.category_id}`, !outPack.includes(policy.category_id));

    const text = t.key === 'A'
      ? 'Signal not working at the Punjagutta junction, traffic chaos every evening'
      : 'Trucks are illegally digging sand from the riverbed every night';
    const started = Date.now();
    const asInsider = await sentiment.analyzeText(text, { tenantId: t.doc.id, districts: [insider] });
    const asOutsider = await sentiment.analyzeText(text, { tenantId: t.doc.id, districts: [outsider] });
    check(`investigation by ${outsider} officer cannot return ${policy.category_id}`, asOutsider.category !== policy.category_id,
      `${insider}: ${asInsider.category} | ${outsider}: ${asOutsider.category} (${Math.round((Date.now() - started) / 1000)}s)`);

    // District-scoped rescan
    const before = await Analysis.countDocuments({ tenant_id: t.doc.id });
    const res = await rescanContent(t.doc.id, [outsider]);
    const requeued = await Content.find({ tenant_id: t.doc.id, analysis_status: 'pending' }).select('districts').lean();
    check(`${outsider} officer's rescan requeued only ${outsider} posts`,
      requeued.length === res.queued && requeued.every((c) => (c.districts || []).includes(outsider)),
      `${res.queued} requeued`);
    t.afterRescan = { before };
  });
};

const verifyRescan = async (t) => {
  if (!t.afterRescan) return;
  await inTenant(t, async () => {
    const after = await Analysis.countDocuments({ tenant_id: t.doc.id });
    const pending = await Content.countDocuments({ tenant_id: t.doc.id, analysis_status: { $in: ['pending', 'processing'] } });
    check(`tenant ${t.key}: re-analysis updated rows in place (no duplicates)`, after === t.afterRescan.before && pending === 0, `${t.afterRescan.before} → ${after} rows`);
  });
};

// ── Cleanup ────────────────────────────────────────────────────────────────

const cleanup = async () => {
  for (const t of TENANTS) {
    if (!t.doc) continue;
    try {
      await forTenant(t.doc).dropDatabase();
      await Tenant.deleteOne({ id: t.doc.id });
      console.log(`  removed ${t.slug} and ${dbNameFor(t.doc)}`);
    } catch (err) {
      console.log(`  cleanup failed for ${t.slug}: ${err.message}`);
    }
  }
};

// ── Main ───────────────────────────────────────────────────────────────────

const main = async () => {
  const health = await sentiment.getStatus();
  if (!health.service.reachable) throw new Error(`sentiment service not reachable: ${health.service.error}`);
  console.log(`service: healthy=${health.service.healthy} device=${health.service.device} intelligence=${health.service.intelligence}`);
  console.log(`dispatcher: maxConcurrency=${health.dispatcher.maxConcurrency}\n`);

  await connectDB();
  try {
    console.log('Seeding test tenants...');
    for (const t of TENANTS) await seed(t);
    for (const t of TENANTS) {
      const pending = await outstanding(t);
      check(`tenant ${t.key}: new documents start as pending (${pending})`, pending > 0);
    }

    console.log('\nRunning both tenants concurrently...');
    const started = Date.now();
    const deadline = started + TIMEOUT_MS;
    const results = await Promise.all(TENANTS.map((t) => drain(t, deadline)));
    const elapsed = Math.round((Date.now() - started) / 1000);
    const stats = sentiment.dispatcherStats();
    const items = TENANTS.reduce((n, t) => n + Object.values(t.posts).flat().length + t.events.length + t.comments.length, 0);
    console.log(`\nDrained in ${elapsed}s — ${items} analysable items in ${stats.succeeded} service request(s), ${stats.failed} failed, ${stats.holds} pause(s)`);
    results.forEach((r, i) => check(`tenant ${TENANTS[i].key}: queue drained before timeout`, r.left === 0, `${r.rounds} round(s)`));
    check('one service request per post', stats.succeeded >= items, `${stats.succeeded} requests / ${items} items`);

    for (let i = 0; i < TENANTS.length; i += 1) await verifyTenant(TENANTS[i], TENANTS[(i + 1) % TENANTS.length]);

    for (const t of TENANTS) await officerChecks(t);
    console.log('\nRe-analysing rescanned posts...');
    await Promise.all(TENANTS.map((t) => drain(t, Date.now() + TIMEOUT_MS)));
    for (const t of TENANTS) await verifyRescan(t);
  } finally {
    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
    failed.forEach((c) => console.log(`  FAILED: ${c.name}${c.detail ? ` — ${c.detail}` : ''}`));
    if (KEEP) {
      console.log(`\n--keep: test data left in place — tenants ${TENANTS.map((t) => t.slug).join(', ')}`);
    } else {
      console.log('\nCleaning up...');
      await cleanup();
    }
    await mongoose.disconnect();
    process.exitCode = failed.length ? 1 : 0;
    setTimeout(() => process.exit(process.exitCode), 1000).unref();
  }
};

main().catch((err) => {
  console.error('E2E run failed:', err);
  process.exit(1);
});
