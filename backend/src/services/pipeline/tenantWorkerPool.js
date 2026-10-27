/**
 * tenantWorkerPool — runs per-tenant jobs in parallel, but bounded and isolated.
 *
 * Guarantees:
 *  - Parallelism: up to TENANT_CONCURRENCY jobs run at once; the rest queue (FIFO).
 *  - Per-tenant lock: the SAME tenant is never processed twice simultaneously
 *    (a duplicate submit while one is running is skipped). Replaces the old single
 *    global "running" boolean that blocked every tenant.
 *  - Isolation: each job is wrapped in try/catch + a timeout. One tenant failing or
 *    hanging only frees its own slot — it never blocks or breaks other tenants.
 *
 * Config:
 *   TENANT_CONCURRENCY   (default 3)
 *   TENANT_JOB_TIMEOUT_MS (default 120000)
 *
 * Usage:
 *   const pool = require('./tenantWorkerPool');
 *   await pool.runForTenants(activeTenants, async (tenant) => { ...job... }, { pipeline:'monitor' });
 */

const MAX = Math.max(1, Number(process.env.TENANT_CONCURRENCY) || 3);
const DEFAULT_TIMEOUT = Math.max(5000, Number(process.env.TENANT_JOB_TIMEOUT_MS) || 120000);

let active = 0;
const queue = [];                 // FIFO of pending { key, run }
const running = new Set();        // tenant keys currently executing (per-tenant lock)

const withTimeout = (promise, ms, key) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`tenant job timed out after ${ms}ms (key=${key})`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });

const pump = () => {
  while (active < MAX && queue.length > 0) {
    const job = queue.shift();
    // Per-tenant lock: if this key is already running, requeue-skip it.
    if (running.has(job.key)) {
      job.resolve({ skipped: true, reason: 'already-running' });
      continue;
    }
    active += 1;
    running.add(job.key);
    Promise.resolve()
      .then(job.run)
      .then(
        (result) => job.resolve({ skipped: false, result }),
        (error) => job.resolve({ skipped: false, error })
      )
      .finally(() => {
        active -= 1;
        running.delete(job.key);
        pump();
      });
  }
};

/**
 * Submit one isolated job for a tenant key.
 * @param {string} key - tenant_id (used for the per-tenant lock)
 * @param {() => Promise<any>} fn
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{skipped:boolean, result?:any, error?:Error}>}
 */
const submit = (key, fn, opts = {}) => {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT;
  return new Promise((resolve) => {
    queue.push({
      key,
      resolve,
      run: () => withTimeout(Promise.resolve().then(fn), timeoutMs, key),
    });
    pump();
  });
};

/**
 * Submit a job per tenant and wait for all to settle. Never throws — each tenant's
 * outcome (ok / skipped / error) is returned so one failure can't abort the batch.
 * @param {Array<{id:string, slug?:string}>} tenants
 * @param {(tenant:object) => Promise<any>} jobFn
 * @param {{pipeline?:string, timeoutMs?:number}} [opts]
 */
const runForTenants = async (tenants = [], jobFn, opts = {}) => {
  // Prefix key with pipeline name so different pipelines (monitor, grievance)
  // don't block each other's jobs for the same tenant.
  const keyPrefix = opts.pipeline ? `${opts.pipeline}:` : '';
  const outcomes = await Promise.all(
    tenants.map((tenant) =>
      submit(`${keyPrefix}${tenant.id}`, () => jobFn(tenant), { timeoutMs: opts.timeoutMs }).then((o) => ({
        tenant: tenant.slug || tenant.id,
        ...o,
      }))
    )
  );
  return outcomes;
};

const stats = () => ({ max: MAX, active, queued: queue.length, running: [...running] });

module.exports = { submit, runForTenants, stats, MAX };
