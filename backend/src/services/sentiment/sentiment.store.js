/**
 * Analysis work-tracking on a tenant collection (Content, Comment).
 *
 * Claims are atomic and token-based: a set of posts is claimed with a fresh token, and
 * every later write for them matches on the token. If the reaper returns
 * a stalled claim to 'pending' and another worker re-claims it, the first
 * worker's late result matches nothing and is dropped — no double writes.
 */

const { v4: uuidv4 } = require('uuid');

const envNum = (name, fallback, min) => {
  const n = Number(process.env[name]);
  return Math.max(min, Number.isFinite(n) && n > 0 ? n : fallback);
};

const maxAttempts = () => envNum('SENTIMENT_MAX_ATTEMPTS', 5, 1);
const staleMs = () => envNum('SENTIMENT_PROCESSING_STALE_MS', 20 * 60 * 1000, 60 * 1000);
// Content older than this is backlog (bulk lane); newer is fresh (routine lane).
const freshWindowMs = () => envNum('SENTIMENT_FRESH_WINDOW_MS', 6 * 60 * 60 * 1000, 60 * 1000);

/** Exponential backoff: 30s, 1m, 2m, 4m ... capped at 30m. */
const backoffMs = (attempts) => Math.min(30 * 60 * 1000, 30 * 1000 * 2 ** Math.max(0, attempts - 1));

/** Busy/outage backoff: 15s, 30s, 1m, 2m, 4m, capped at 5m so recovery is picked up quickly. */
const retryBackoffMs = (retries) => Math.min(5 * 60 * 1000, 15 * 1000 * 2 ** Math.max(0, retries - 1));

const CLAIMABLE = ['pending', 'failed'];

/** Return stalled claims to the queue. */
const reap = async (Model, tenantId) => {
  const res = await Model.updateMany(
    {
      tenant_id: tenantId,
      analysis_status: 'processing',
      analysis_claimed_at: { $lt: new Date(Date.now() - staleMs()) },
    },
    {
      $set: { analysis_status: 'pending', analysis_error: 'claim expired; requeued' },
      $unset: { analysis_claim_token: 1, analysis_claimed_at: 1 },
    },
  );
  return res.modifiedCount || 0;
};

const districtKey = (doc) => {
  const d = Array.isArray(doc.districts) ? doc.districts.filter(Boolean) : [];
  return d.length ? [...d].sort().join('|') : '_tenant';
};

/** Round-robin across districts so one busy district can't fill the whole claim. */
const roundRobinByDistrict = (docs, limit) => {
  const queues = new Map();
  for (const doc of docs) {
    const key = districtKey(doc);
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(doc);
  }
  const out = [];
  while (out.length < limit && queues.size) {
    for (const [key, list] of queues) {
      out.push(list.shift());
      if (!list.length) queues.delete(key);
      if (out.length >= limit) break;
    }
  }
  return out;
};

/**
 * Claim up to `limit` documents for one lane.
 * @param {'routine'|'bulk'} lane  routine = fresh documents (and their retries), newest first;
 *                                 bulk    = backlog (and its retries), oldest first
 * @returns {Promise<{token: string|null, docs: object[]}>}
 */
const claim = async (Model, tenantId, { lane, limit, select = null, extraFilter = {} }) => {
  const now = new Date();
  const freshSince = new Date(now.getTime() - freshWindowMs());
  const filter = {
    ...extraFilter,
    tenant_id: tenantId,
    analysis_status: { $in: CLAIMABLE },
    analysis_attempts: { $lt: maxAttempts() },
    $or: [{ analysis_next_attempt_at: null }, { analysis_next_attempt_at: { $lte: now } }],
  };
  // Lane is decided by age only. A fresh post that failed once stays in the
  // routine lane (its backoff delays it) instead of queueing behind the backlog.
  if (lane === 'routine') {
    filter.created_at = { $gte: freshSince };
  } else {
    filter.created_at = { $lt: freshSince };
  }

  const candidates = await Model.find(filter)
    .select('id districts')
    .sort({ created_at: lane === 'routine' ? -1 : 1 })
    .limit(limit * 3)
    .lean();
  if (!candidates.length) return { token: null, docs: [] };

  const ids = roundRobinByDistrict(candidates, limit).map((d) => d.id);
  const token = uuidv4();
  await Model.updateMany(
    { tenant_id: tenantId, id: { $in: ids }, analysis_status: { $in: CLAIMABLE } },
    { $set: { analysis_status: 'processing', analysis_claim_token: token, analysis_claimed_at: now } },
  );

  let query = Model.find({ tenant_id: tenantId, analysis_claim_token: token });
  if (select) query = query.select(select);
  const docs = await query.lean();
  return { token, docs };
};

/** Refresh claim time when a post actually reaches the service, so queue wait isn't mistaken for a stall. */
const touch = (Model, tenantId, token, ids) => Model.updateMany(
  { tenant_id: tenantId, analysis_claim_token: token, id: { $in: ids } },
  { $set: { analysis_claimed_at: new Date() } },
);

const releaseFields = { analysis_claim_token: 1, analysis_claimed_at: 1 };

/** Store a result. Returns false when the claim is no longer ours. */
const markDone = async (Model, tenantId, token, id, fields = {}) => {
  const res = await Model.updateOne(
    { tenant_id: tenantId, id, analysis_claim_token: token },
    {
      $set: { ...fields, analysis_status: 'done', analysis_error: null, analysis_retries: 0, analyzed_at: new Date() },
      $unset: { ...releaseFields, analysis_next_attempt_at: 1 },
    },
  );
  return (res.matchedCount || 0) > 0;
};

const markSkipped = (Model, tenantId, token, id, reason) => Model.updateOne(
  { tenant_id: tenantId, id, analysis_claim_token: token },
  {
    $set: { analysis_status: 'skipped', analysis_error: reason, analyzed_at: new Date() },
    $unset: releaseFields,
  },
);

/**
 * Return an item to the queue after a failure.
 *   countsAttempt=true   the post itself failed (unusable, rejected, malformed): spends an
 *                        attempt; 'failed' after SENTIMENT_MAX_ATTEMPTS
 *   countsAttempt=false  service busy, down or misconfigured: retried with backoff until
 *                        it recovers — never marked failed
 */
const markRetry = async (Model, tenantId, token, doc, { reason, countsAttempt = true, retryAfterS = null }) => {
  const attempts = (doc.analysis_attempts || 0) + (countsAttempt ? 1 : 0);
  const retries = (doc.analysis_retries || 0) + (countsAttempt ? 0 : 1);
  const exhausted = countsAttempt && attempts >= maxAttempts();
  const backoff = countsAttempt ? backoffMs(attempts) : retryBackoffMs(retries);
  const delayMs = Math.max(backoff, retryAfterS ? retryAfterS * 1000 : 0);
  return Model.updateOne(
    { tenant_id: tenantId, id: doc.id, analysis_claim_token: token },
    {
      $set: {
        analysis_status: exhausted ? 'failed' : 'pending',
        analysis_attempts: attempts,
        analysis_retries: retries,
        analysis_error: String(reason || 'analysis failed').slice(0, 500),
        analysis_next_attempt_at: exhausted ? null : new Date(Date.now() + delayMs),
      },
      $unset: releaseFields,
    },
  );
};

module.exports = {
  reap,
  claim,
  touch,
  markDone,
  markSkipped,
  markRetry,
  maxAttempts,
  backoffMs,
  retryBackoffMs,
  roundRobinByDistrict,
  CLAIMABLE,
};
