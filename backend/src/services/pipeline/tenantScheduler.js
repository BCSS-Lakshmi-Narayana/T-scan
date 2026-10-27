/**
 * tenantScheduler — drives a pipeline on an interval across ALL active tenants.
 *
 * On each tick it enumerates active tenants and hands one job per tenant to the
 * tenantWorkerPool (which runs them in parallel, bounded + isolated). The scheduler
 * itself processes nothing — it only decides WHO runs and WHEN.
 *
 * Overlap guard: if the previous tick's batch is still running, the next tick is
 * skipped (so slow cycles don't pile up).
 *
 * Usage:
 *   const { scheduleTenantPipeline } = require('./tenantScheduler');
 *   const handle = scheduleTenantPipeline({
 *     name: 'monitor',
 *     intervalMs: 2 * 60 * 1000,
 *     startDelayMs: 30 * 1000,
 *     jobFn: async (tenant) => { ...per-tenant work... },
 *   });
 *   // handle.stop() to cancel
 */

const Tenant = require('../../models/Tenant');
const pool = require('./tenantWorkerPool');
const { createPipelineLogger } = require('../../utils/tenantLogger');
const { runWithTenant } = require('../../config/tenantContext');
const { forTenant } = require('../../config/tenantConnections');

const getActiveTenants = async (type) => {
  const query = { status: { $in: ['trial', 'active'] } };
  if (type) query.type = type; // optional filter (e.g. only 'political')
  // db_name is needed too: the worker pool resolves each tenant's database from
  // this record, and a tenant pinned to an explicit database must not fall back
  // to the name derived from its slug.
  return Tenant.find(query).select('id slug type name status db_name').lean();
};

const scheduleTenantPipeline = ({ name, intervalMs, startDelayMs = 0, jobFn, timeoutMs, type }) => {
  const log = createPipelineLogger(name, { slug: 'scheduler' });
  let ticking = false;
  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped || ticking) return; // overlap guard
    ticking = true;
    const startedAt = Date.now();
    try {
      const tenants = await getActiveTenants(type);
      if (tenants.length === 0) { ticking = false; return; }

      // Every pipeline job reaches tenant models, and those resolve against the
      // tenant in AsyncLocalStorage — which a timer has no reason to have. Establish
      // it here, once, rather than in each jobFn: a scheduler that forgets does not
      // read the wrong database (tenantModel refuses), it simply fails every tick.
      const scopedJob = (tenant) => runWithTenant(
        { tenant, tenantId: tenant.id, connection: forTenant(tenant) },
        () => jobFn(tenant)
      );

      const outcomes = await pool.runForTenants(tenants, scopedJob, { timeoutMs, pipeline: name });

      const ok = outcomes.filter((o) => !o.skipped && !o.error).length;
      const skipped = outcomes.filter((o) => o.skipped).length;
      const errored = outcomes.filter((o) => o.error);
      log.summary({ tenants: tenants.length, ok, skipped, errors: errored.length, ms: Date.now() - startedAt });
      errored.forEach((o) => log.error(`tenant=${o.tenant} job failed`, o.error));
    } catch (err) {
      log.error('scheduler tick failed', err);
    } finally {
      ticking = false;
    }
  };

  const startTimer = setTimeout(() => {
    tick();
    timer = setInterval(tick, intervalMs);
  }, startDelayMs);

  return {
    name,
    stop: () => { stopped = true; clearTimeout(startTimer); if (timer) clearInterval(timer); },
    triggerNow: tick,
  };
};

module.exports = { scheduleTenantPipeline, getActiveTenants };
