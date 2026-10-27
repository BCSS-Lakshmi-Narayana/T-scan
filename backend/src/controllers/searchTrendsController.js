/**
 * searchTrendsController.js
 *
 * HTTP layer for Google Trends (via RapidAPI).
 *
 * Flow:
 *   1. Check Redis cache → return immediately on HIT
 *   2a. Redis/Bull available → enqueue job → return { status:'queued', jobId }
 *   2b. No Redis → run fetchTrends() synchronously
 *
 * Frontend polls GET /search-trends/status/:jobId until status === 'completed'.
 */
const cacheService = require('../services/cacheService');
const { getTrendsQueue, makeJobId } = require('../queues/trendsQueue');
const { fetchTrends } = require('../workers/trendsWorker');

const CACHE_PREFIX = 'trends:';
const STALE_PREFIX = 'trends:stale:';

// Map frontend range (days) → hours supported by RapidAPI (max 168)
const daysToHours = (days) => Math.min(Math.max(parseInt(days, 10) || 7, 1) * 24, 168);

// ─── GET /api/search-trends ──────────────────────────────────────────────────

exports.getSearchTrends = async (req, res) => {
  const keyword = String(req.query.q || '').trim();
  const geo     = String(req.query.country || 'IN').toUpperCase();
  const hours   = daysToHours(req.query.range || req.query.days || 7);

  const cacheKey = `${keyword.toLowerCase()}|${geo}|${hours}`;

  // ── 1. Cache hit ────────────────────────────────────────────────────────
  const cached = await cacheService.get(CACHE_PREFIX + cacheKey);
  if (cached) {
    res.set('X-Cache', 'HIT');
    return res.json(cached);
  }

  const jobData = { keyword, geo, hours, cacheKey };

  // ── 2a. Queue path (Redis + Bull) ───────────────────────────────────────
  const queue = getTrendsQueue();
  if (queue) {
    const jobId = makeJobId(cacheKey);
    try {
      const existing = await queue.getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        if (['waiting', 'active', 'delayed'].includes(state)) {
          return res.json({ status: 'queued', jobId });
        }
      }
      await queue.add(jobData, { jobId });
      return res.json({ status: 'queued', jobId });
    } catch (queueErr) {
      console.warn('[searchTrends] Queue error, falling back to sync:', queueErr?.message || queueErr);
    }
  }

  // ── 2b. Synchronous fallback ─────────────────────────────────────────────
  try {
    const result = await fetchTrends(jobData);
    if (result.stale) res.set('X-Cache', 'STALE');
    else               res.set('X-Cache', 'MISS');
    return res.json(result);
  } catch (err) {
    console.error('[searchTrends] sync fetch failed:', err.message);
    return res.status(502).json({
      success: false,
      message: err.message || 'Failed to fetch trends data',
    });
  }
};

// ─── GET /api/search-trends/status/:jobId ────────────────────────────────────

exports.getJobStatus = async (req, res) => {
  const queue = getTrendsQueue();
  if (!queue) {
    return res.status(503).json({
      status: 'unavailable',
      message: 'Queue not configured',
    });
  }

  const { jobId } = req.params;
  let job;
  try {
    job = await queue.getJob(jobId);
  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message });
  }

  if (!job) return res.status(404).json({ status: 'not_found' });

  const state = await job.getState();

  if (state === 'completed') {
    const data = job.returnvalue;
    if (data?.stale) res.set('X-Cache', 'STALE');
    return res.json({ status: 'completed', data });
  }

  if (state === 'failed') {
    const stale = await cacheService.get(STALE_PREFIX + job.data?.cacheKey);
    if (stale) {
      res.set('X-Cache', 'STALE');
      return res.json({ status: 'completed', data: { ...stale, stale: true } });
    }
    return res.json({
      status: 'failed',
      error: job.failedReason || 'Trends fetch failed. Please try again.',
    });
  }

  const progress = typeof job.progress === 'function' ? job.progress() : (job._progress || 0);
  return res.json({ status: 'processing', progress });
};
