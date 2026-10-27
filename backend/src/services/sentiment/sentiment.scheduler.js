/**
 * Sentiment scheduler — starts every active tenant's analysis run on each tick.
 *
 * Deliberately outside tenantWorkerPool: an analysis run spends nearly all its
 * time waiting for its turn at the service, and holding one of the pool's
 * TENANT_CONCURRENCY slots while waiting would stall profile and event scans for
 * every other tenant. Fairness and the one-request-at-a-time limit come from the
 * shared dispatcher instead; runTenant's own lock keeps one run per tenant.
 */

const { getActiveTenants } = require('../pipeline/tenantScheduler');
const { runWithTenant } = require('../../config/tenantContext');
const { forTenant } = require('../../config/tenantConnections');
const { runTenant } = require('./sentiment.pipeline');

const startScheduler = ({ intervalMs, startDelayMs = 0 }) => {
  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    let tenants = [];
    try {
      tenants = await getActiveTenants();
    } catch (err) {
      console.error(`[Sentiment] scheduler could not list tenants: ${err.message}`);
      return;
    }
    // Not awaited together: a slow tenant never delays the others' start.
    for (const tenant of tenants) {
      Promise.resolve()
        .then(() => runWithTenant({ tenant, tenantId: tenant.id, connection: forTenant(tenant) }, () => runTenant(tenant)))
        .catch((err) => console.error(`[Sentiment] run failed for ${tenant.slug || tenant.id}: ${err.message}`));
    }
  };

  const startTimer = setTimeout(() => {
    tick();
    timer = setInterval(tick, intervalMs);
  }, startDelayMs);

  return {
    stop: () => { stopped = true; clearTimeout(startTimer); if (timer) clearInterval(timer); },
    triggerNow: tick,
  };
};

module.exports = { startScheduler };
