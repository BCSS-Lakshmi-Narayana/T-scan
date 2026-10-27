/**
 * Per-tenant sentiment pipeline.
 *
 * Runs inside a tenant scope (tenant scheduler tick, or kick() from ingest):
 *   reap stalled claims -> for each target: claim fresh (routine) then backlog (bulk)
 *   -> prepare text -> analyze through the shared dispatcher -> store -> alert
 *
 * Fairness across tenants comes from two places: each tick does a bounded number
 * of rounds, and every service request goes through the shared dispatcher's
 * tenant::district buckets.
 */

const { getTenantContext, runWithTenant } = require('../../config/tenantContext');
const tenantContextService = require('../pipeline/tenantContextService');
const { getSettingsForDistricts } = require('../settingsResolver');
const { analyzeItems } = require('./sentiment.analyzer');
const store = require('./sentiment.store');
const { TARGETS } = require('./sentiment.targets');

const envInt = (name, fallback, min) => {
  const n = Number(process.env[name]);
  return Math.max(min, Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback);
};

const claimSize = () => envInt('SENTIMENT_CLAIM_SIZE', 20, 1);
const maxRounds = () => envInt('SENTIMENT_ROUNDS_PER_TICK', 4, 1);

const running = new Set();   // tenantIds with a run in progress
const rerun = new Set();     // tenantIds kicked while running

const tallies = () => ({ claimed: 0, done: 0, skipped: 0, retried: 0, failedAttempts: 0, lost: 0, reaped: 0 });

/**
 * Analyze one claimed set of posts (one service request each) and apply the outcomes.
 * @returns {Promise<{backpressure: boolean}>}
 */
const processBatch = async (target, tenantId, token, docs, lane, ctx, t) => {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const items = await target.prepare(docs);

  const outcomes = await analyzeItems(items, {
    tenantId,
    keywords: ctx.keywords,
    tenantName: ctx.name || ctx.slug,
    priority: lane,
    resolveSettings: (districts) => getSettingsForDistricts(tenantId, districts),
    onDispatchStart: (ref) => store.touch(target.Model, tenantId, token, [ref]).catch(() => {}),
  });

  let backpressure = false;
  for (const item of items) {
    const doc = byId.get(item.ref);
    const outcome = outcomes.get(item.ref) || { status: 'retry', kind: 'invalid', reason: 'no outcome', countsAttempt: true };

    try {
      if (outcome.status === 'ok') {
        const { stored } = await target.persist(doc, token, outcome.mapped, { settings: outcome.settings });
        if (stored) t.done += 1; else t.lost += 1;
      } else if (outcome.status === 'skipped') {
        await store.markSkipped(target.Model, tenantId, token, doc.id, outcome.reason);
        t.skipped += 1;
      } else {
        // Service busy, down or misconfigured: stop this run; the posts wait with backoff.
        if (!outcome.countsAttempt) backpressure = true;
        await store.markRetry(target.Model, tenantId, token, doc, outcome);
        t.retried += 1;
        if (outcome.countsAttempt) t.failedAttempts += 1;
      }
    } catch (err) {
      // A storage failure leaves the claim to the reaper rather than guessing.
      console.error(`[Sentiment] ${target.name} ${doc.id}: storing outcome failed: ${err.message}`);
    }
  }
  return { backpressure };
};

/**
 * Process one tenant. Must be called inside that tenant's scope.
 * @param {{id: string, slug?: string}} tenant
 */
const runTenant = async (tenant) => {
  const tenantId = tenant?.id;
  if (!tenantId) return null;
  if (running.has(tenantId)) {
    rerun.add(tenantId);
    return null;
  }
  running.add(tenantId);
  const t = tallies();

  try {
    const ctx = await tenantContextService.getContext(tenantId);
    if (!ctx) return null;

    for (const target of TARGETS) {
      t.reaped += await store.reap(target.Model, tenantId).catch(() => 0);
    }

    for (let round = 0; round < maxRounds(); round++) {
      let claimedThisRound = 0;
      let stop = false;

      for (const target of TARGETS) {
        for (const lane of ['routine', 'bulk']) {
          const { token, docs } = await store.claim(target.Model, tenantId, {
            lane,
            limit: claimSize(),
            select: target.select,
            extraFilter: target.claimFilter || {},
          });
          if (!docs.length) continue;
          claimedThisRound += docs.length;
          t.claimed += docs.length;

          const { backpressure } = await processBatch(target, tenantId, token, docs, lane, ctx, t);
          if (backpressure) { stop = true; break; }
        }
        if (stop) break;
      }
      if (stop || claimedThisRound === 0) break;
    }

    if (t.claimed || t.reaped) {
      console.log(`[Sentiment] tenant=${tenant.slug || tenantId} claimed=${t.claimed} done=${t.done} skipped=${t.skipped} retried=${t.retried} reaped=${t.reaped}${t.lost ? ` lost-claims=${t.lost}` : ''}`);
    }
    return t;
  } finally {
    running.delete(tenantId);
    if (rerun.delete(tenantId)) {
      const scope = getTenantContext();
      setImmediate(() => {
        const run = () => runTenant(tenant).catch((err) => console.error(`[Sentiment] rerun failed for ${tenantId}: ${err.message}`));
        if (scope?.tenantId === tenantId) runWithTenant(scope, run); else run();
      });
    }
  }
};

/**
 * Start analysing the current tenant's pending work now, without waiting for
 * the next scheduler tick. Call after ingesting content or comments.
 * No-op outside a tenant scope.
 */
const kick = () => {
  const scope = getTenantContext();
  if (!scope?.tenantId || !scope.tenant) return false;
  setImmediate(() => {
    runWithTenant(scope, () => runTenant(scope.tenant))
      .catch((err) => console.error(`[Sentiment] kick failed for ${scope.tenantId}: ${err.message}`));
  });
  return true;
};

module.exports = { runTenant, kick, processBatch };
