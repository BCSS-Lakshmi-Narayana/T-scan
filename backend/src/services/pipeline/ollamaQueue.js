/**
 * ollamaQueue — a FAIR, PRIORITY-AWARE concurrency gate for every Ollama (LLM)
 * call in the app, shared across ALL tenants, ALL districts, and ALL call sites.
 *
 * Replaces the old raw FIFO semaphore. A single Ollama instance on one GPU can
 * only run a couple of generations at once, so the problem is never "more
 * parallelism" — it is ORDERING the shared budget so that:
 *
 *   1. FAIRNESS — one district's burst of 500 posts can never starve another
 *      district's 3 posts (even within the same state tenant). Work is dispatched
 *      round-robin across fairness buckets (tenant+district), so every active
 *      bucket gets a turn regardless of backlog size.
 *
 *   2. PRIORITY — interactive/urgent work jumps ahead of bulk churn. Three lanes,
 *      highest first:
 *         'live'    → user-triggered investigations (an officer is watching)
 *         'routine' → normal background monitoring analysis (default)
 *         'bulk'    → backfill / pending-analysis retry sweeps
 *      Within a lane, buckets are still served round-robin (fair).
 *
 *   3. BACKPRESSURE — under extreme burst the queue is capped; overflow callers
 *      get a fast OLLAMA_QUEUE_FULL error instead of the process exhausting
 *      memory. Callers treat that like any LLM miss: the item is left unanalysed
 *      and picked up later by the pending-analysis retry sweep. Nothing is lost.
 *
 * IMPORTANT for callers: do NOT hold a slot across your own retry backoff. Call
 * run() once per attempt and sleep BETWEEN calls, so a failing item releases the
 * GPU while it waits instead of blocking everyone else.
 *
 * Config (env):
 *   OLLAMA_MAX_CONCURRENCY (preferred) / OLLAMA_CONCURRENCY   default 2
 *       Tuned to the GPU. Benchmarks show one shared 8GB GPU running llama3.1:8b
 *       serves ~2 generations truly in parallel (OLLAMA_NUM_PARALLEL=2) at near
 *       zero extra latency; beyond that they only queue inside Ollama with no gain.
 *   OLLAMA_QUEUE_MAX   default 4000   (max items waiting before backpressure)
 *
 * Usage:
 *   const ollamaQueue = require('./ollamaQueue');
 *   const out = await ollamaQueue.run(fn, { key: `${tenantId}::${district}`, priority: 'routine' });
 *   // Backward compatible: run(fn) with no opts == { key:'__global__', priority:'routine' }
 */

const MAX = Math.max(1, Number(process.env.OLLAMA_MAX_CONCURRENCY || process.env.OLLAMA_CONCURRENCY) || 2);
const MAX_QUEUE = Math.max(50, Number(process.env.OLLAMA_QUEUE_MAX) || 4000);

// Highest priority first. Strict priority is safe here because 'live' volume is
// tiny (only user investigations), so it cannot practically starve
// 'routine'/'bulk' — and the pending-analysis sweep guarantees any bulk item
// eventually runs regardless.
const PRIORITIES = ['live', 'routine', 'bulk'];
const DEFAULT_PRIORITY = 'routine';

let active = 0;
let queuedCount = 0;

// Each lane maps bucketKey -> FIFO array of waiters. A JS Map preserves insertion
// order, which we exploit for round-robin: we always serve the bucket at the FRONT
// of the map, then move it to the BACK — so buckets rotate fairly with no pointer
// bookkeeping and no starvation.
const lanes = {
  live: new Map(),
  routine: new Map(),
  bulk: new Map(),
};

const normalizePriority = (p) => (PRIORITIES.includes(p) ? p : DEFAULT_PRIORITY);

// Build the fairness bucket key. Prefer an explicit `key` (caller composes
// tenant+district); fall back to tenantId; finally a global bucket. This is the
// unit of fairness — the queue rotates evenly across distinct keys.
const normalizeKey = (opts) => {
  if (opts && opts.key) return String(opts.key);
  const t = opts && (opts.tenantId || opts.tenant_id);
  return t ? String(t) : '__global__';
};

// Pull the next waiter: highest non-empty lane, front bucket (oldest-waiting),
// then rotate that bucket to the back of its lane for fairness.
const pickNext = () => {
  for (const p of PRIORITIES) {
    const lane = lanes[p];
    if (lane.size === 0) continue;
    const key = lane.keys().next().value; // front bucket in insertion order
    const dq = lane.get(key);
    const waiter = dq.shift();
    lane.delete(key);
    if (dq.length > 0) lane.set(key, dq); // still has work → send to the back
    return waiter;
  }
  return null;
};

const pump = () => {
  while (active < MAX) {
    const waiter = pickNext();
    if (!waiter) break;
    active += 1;
    queuedCount -= 1;
    Promise.resolve()
      .then(waiter.fn)
      .then(waiter.resolve, waiter.reject)
      .finally(() => {
        active -= 1;
        if (active < 0) active = 0;
        pump();
      });
  }
};

/**
 * Run an async fn within a fair, priority-scheduled Ollama slot.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ key?: string, tenantId?: string, tenant_id?: string, priority?: 'live'|'routine'|'bulk' }} [opts]
 * @returns {Promise<T>}
 * @throws {Error} code 'OLLAMA_QUEUE_FULL' when the queue is saturated (backpressure)
 */
const run = (fn, opts = {}) => {
  const priority = normalizePriority(opts.priority);
  const key = normalizeKey(opts);

  if (queuedCount >= MAX_QUEUE) {
    const err = new Error(`Ollama queue full (${queuedCount}/${MAX_QUEUE}) — backpressure; item will be retried by the pending-analysis sweep`);
    err.code = 'OLLAMA_QUEUE_FULL';
    return Promise.reject(err);
  }

  return new Promise((resolve, reject) => {
    const lane = lanes[priority];
    if (!lane.has(key)) lane.set(key, []);
    lane.get(key).push({ fn, resolve, reject });
    queuedCount += 1;
    pump();
  });
};

// Live diagnostics for health endpoints: concurrency, total queued, and per-lane
// per-bucket depth so you can SEE fairness (which tenant/district is backed up).
const stats = () => {
  const laneStats = {};
  for (const p of PRIORITIES) {
    const buckets = {};
    let waiting = 0;
    for (const [key, dq] of lanes[p]) {
      buckets[key] = dq.length;
      waiting += dq.length;
    }
    laneStats[p] = { waiting, buckets };
  }
  return { max: MAX, active, queued: queuedCount, maxQueue: MAX_QUEUE, lanes: laneStats };
};

module.exports = { run, stats, MAX, PRIORITIES };
