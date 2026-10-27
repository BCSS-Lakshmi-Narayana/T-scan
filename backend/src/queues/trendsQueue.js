const Bull = require('bull');
const crypto = require('crypto');
const net = require('net');

let _queue = null;
let _initialized = false;

const parseRedisUrl = (url) => {
  try {
    const u = new URL(url);
    const opts = { host: u.hostname || '127.0.0.1', port: parseInt(u.port, 10) || 6379 };
    if (u.password) opts.password = decodeURIComponent(u.password);
    if (u.pathname && u.pathname.length > 1) {
      const db = parseInt(u.pathname.slice(1), 10);
      if (Number.isFinite(db)) opts.db = db;
    }
    return opts;
  } catch {
    return { host: '127.0.0.1', port: 6379 };
  }
};

// Quick TCP reachability check — resolves false instead of throwing
function probeRedis(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.connect(port, host, () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

/**
 * Async init — call once at startup (from index.js).
 * Probes Redis before creating Bull so an unreachable server never
 * produces unhandled ECONNREFUSED rejections.
 */
async function initTrendsQueue() {
  if (_initialized) return;
  _initialized = true;

  if (!process.env.REDIS_URL) {
    console.log('[TrendsQueue] REDIS_URL not set — queue disabled, using sync fallback');
    return;
  }

  const redisOpts = parseRedisUrl(process.env.REDIS_URL);
  const reachable = await probeRedis(redisOpts.host, redisOpts.port);
  if (!reachable) {
    console.warn(`[TrendsQueue] Redis at ${redisOpts.host}:${redisOpts.port} not reachable — queue disabled, using sync fallback`);
    return;
  }

  try {
    _queue = new Bull('trends-fetch', {
      redis: {
        ...redisOpts,
        connectTimeout: 8000,
        maxRetriesPerRequest: null,
        retryStrategy(times) {
          if (times > 3) {
            console.error('[TrendsQueue] Redis connection lost — disabling queue');
            _queue = null;
            return null;
          }
          return Math.min(times * 2000, 8000);
        },
      },
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'fixed', delay: 10000 },
        removeOnComplete: 500,
        removeOnFail: 200,
        timeout: 120000,
      },
    });

    _queue.on('error', (err) => {
      console.error('[TrendsQueue] Error:', err?.message || err?.code || String(err));
    });
    _queue.on('ready', () => console.log('[TrendsQueue] Connected to Redis'));

    console.log('[TrendsQueue] Queue initialized');
  } catch (err) {
    console.error('[TrendsQueue] Failed to initialize:', err?.message || String(err));
    _queue = null;
  }
}

/** Synchronous getter — safe to call anywhere after initTrendsQueue() has been awaited. */
function getTrendsQueue() {
  return _queue;
}

function makeJobId(cacheKey) {
  return 'tr:' + crypto.createHash('md5').update(cacheKey).digest('hex');
}

module.exports = { getTrendsQueue, initTrendsQueue, makeJobId };
