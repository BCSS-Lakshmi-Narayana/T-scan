/**
 * Shared, fair, priority-aware gate for every request to the sentiment service.
 *
 * One instance per process, shared by all tenants and all call sites. Same
 * scheduling model as pipeline/ollamaQueue, plus service-aware backpressure:
 *
 *   Lanes      live (investigation) > routine (fresh content) > bulk (backlog, retries)
 *   Buckets    tenant::districtSignature — round-robin inside each lane, so one
 *              district's burst never starves another tenant's or district's work
 *   Capacity   SENTIMENT_MAX_CONCURRENCY requests in flight (default 1, see config)
 *   Hold       a 429/503 from the service pauses ALL dispatch for Retry-After;
 *              repeated outages open a cooldown, instead of hammering a sick service
 *   Queue cap  overflow is rejected fast (SENTIMENT_QUEUE_FULL); callers release
 *              their claim and the item is picked up again later — nothing is lost
 */

const PRIORITIES = ['live', 'routine', 'bulk'];
const DEFAULT_PRIORITY = 'routine';

const envInt = (name, fallback, min) => {
  const n = Number(process.env[name]);
  return Math.max(min, Number.isFinite(n) && n > 0 ? n : fallback);
};

// Default 1: the service runs its translation/sentiment stage one request at a
// time (single worker, one inference lock) and shares VLLM_GATE_SIZE LLM slots
// across every caller. A second concurrent request mostly waits there. Raise
// only when the service runs more capacity.
const config = () => ({
  maxConcurrency: envInt('SENTIMENT_MAX_CONCURRENCY', 1, 1),
  maxQueue: envInt('SENTIMENT_QUEUE_MAX', 2000, 10),
  failureThreshold: envInt('SENTIMENT_CIRCUIT_FAILURES', 5, 1),
  cooldownMs: envInt('SENTIMENT_CIRCUIT_COOLDOWN_MS', 30000, 1000),
});

const createDispatcher = (overrides = {}) => {
  const cfg = { ...config(), ...overrides };
  const lanes = { live: new Map(), routine: new Map(), bulk: new Map() };
  let active = 0;
  let queued = 0;
  let holdUntil = 0;
  let holdTimer = null;
  let consecutiveFailures = 0;
  const counters = { dispatched: 0, succeeded: 0, failed: 0, rejectedFull: 0, holds: 0 };

  const normalizePriority = (p) => (PRIORITIES.includes(p) ? p : DEFAULT_PRIORITY);

  // Highest non-empty lane, front bucket, then rotate that bucket to the back.
  const pickNext = () => {
    for (const p of PRIORITIES) {
      const lane = lanes[p];
      if (lane.size === 0) continue;
      const key = lane.keys().next().value;
      const waiters = lane.get(key);
      const waiter = waiters.shift();
      lane.delete(key);
      if (waiters.length) lane.set(key, waiters);
      return waiter;
    }
    return null;
  };

  const hold = (ms, reason) => {
    const until = Date.now() + Math.max(0, ms);
    if (until <= holdUntil) return;
    holdUntil = until;
    counters.holds += 1;
    console.warn(`[Sentiment] dispatch paused ${Math.round(ms / 1000)}s: ${reason}`);
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { holdTimer = null; pump(); }, ms);
    if (holdTimer.unref) holdTimer.unref();
  };

  // Service health feedback: busy/outage signals pause everyone, success resets.
  const observe = (err) => {
    if (!err) {
      consecutiveFailures = 0;
      return;
    }
    if (err.kind === 'backpressure') {
      hold((err.retryAfterS || 15) * 1000, err.message);
      return;
    }
    if (err.kind === 'unavailable') {
      consecutiveFailures += 1;
      if (err.retryAfterS) hold(err.retryAfterS * 1000, err.message);
      if (consecutiveFailures >= cfg.failureThreshold) {
        hold(cfg.cooldownMs, `${consecutiveFailures} consecutive failures — ${err.message}`);
        consecutiveFailures = 0;
      }
    }
  };

  const pump = () => {
    while (active < cfg.maxConcurrency) {
      if (Date.now() < holdUntil) return;
      const waiter = pickNext();
      if (!waiter) return;
      active += 1;
      queued -= 1;
      counters.dispatched += 1;
      Promise.resolve()
        .then(waiter.fn)
        .then(
          (value) => { counters.succeeded += 1; observe(null); waiter.resolve(value); },
          (err) => { counters.failed += 1; observe(err); waiter.reject(err); },
        )
        .finally(() => {
          active = Math.max(0, active - 1);
          pump();
        });
    }
  };

  /**
   * @template T
   * @param {() => Promise<T>} fn one service request
   * @param {{key?: string, priority?: 'live'|'routine'|'bulk'}} [opts]
   */
  const run = (fn, opts = {}) => {
    const priority = normalizePriority(opts.priority);
    const key = opts.key ? String(opts.key) : '__global__';
    if (queued >= cfg.maxQueue) {
      counters.rejectedFull += 1;
      const err = new Error(`Sentiment queue full (${queued}/${cfg.maxQueue})`);
      err.code = 'SENTIMENT_QUEUE_FULL';
      err.kind = 'backpressure';
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      const lane = lanes[priority];
      if (!lane.has(key)) lane.set(key, []);
      lane.get(key).push({ fn, resolve, reject });
      queued += 1;
      pump();
    });
  };

  const stats = () => {
    const laneStats = {};
    for (const p of PRIORITIES) {
      const buckets = {};
      let waiting = 0;
      for (const [key, waiters] of lanes[p]) {
        buckets[key] = waiters.length;
        waiting += waiters.length;
      }
      laneStats[p] = { waiting, buckets };
    }
    const holdMs = Math.max(0, holdUntil - Date.now());
    return {
      maxConcurrency: cfg.maxConcurrency,
      active,
      queued,
      maxQueue: cfg.maxQueue,
      paused: holdMs > 0,
      pausedForMs: holdMs,
      consecutiveFailures,
      ...counters,
      lanes: laneStats,
    };
  };

  return { run, stats, PRIORITIES };
};

// Process-wide singleton; createDispatcher is exported for tests.
const shared = createDispatcher();

module.exports = {
  run: shared.run,
  stats: shared.stats,
  createDispatcher,
  PRIORITIES,
};
