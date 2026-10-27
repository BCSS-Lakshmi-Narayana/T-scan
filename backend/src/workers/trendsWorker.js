/**
 * trendsWorker.js
 *
 * Fetches trending data via RapidAPI (google-trends-api5.p.rapidapi.com).
 * Replaces the unofficial google-trends-api npm package to avoid rate-limiting.
 *
 * Flow: keyword + geo + hours → RapidAPI → filter/aggregate → cache → return payload
 */
const axios = require('axios');
const cacheService = require('../services/cacheService');
const { getTrendsQueue } = require('../queues/trendsQueue');

const CACHE_PREFIX = 'trends:';
const STALE_PREFIX = 'trends:stale:';
const FRESH_TTL  = 15 * 60;       // 15 min
const STALE_TTL  = 12 * 60 * 60;  // 12 h

const RAPIDAPI_HOST = process.env.RAPIDAPI_TRENDS_HOST || 'google-trends-api5.p.rapidapi.com';

// ─── helpers ────────────────────────────────────────────────────────────────

// "500K+" → 500000 | "1M+" → 1000000 | "200+" → 200
const parseVolume = (vol) => {
  if (!vol) return 0;
  const s = String(vol).replace(/[+,\s]/g, '').toUpperCase();
  if (s.endsWith('M')) return Math.round(parseFloat(s) * 1_000_000);
  if (s.endsWith('K')) return Math.round(parseFloat(s) * 1_000);
  return parseInt(s, 10) || 0;
};

// "14 hours ago" / "2 days ago" → milliseconds
const parseAgoMs = (str) => {
  if (!str) return 0;
  const m = String(str).match(/(\d+)\s+(minute|hour|day)/i);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (unit === 'minute') return n * 60_000;
  if (unit === 'hour')   return n * 3_600_000;
  if (unit === 'day')    return n * 86_400_000;
  return 0;
};

// Normalize an array of raw volumes to 0-100 scale
const normalize100 = (values) => {
  const max = Math.max(...values, 1);
  return values.map(v => Math.round((v / max) * 100));
};

// ─── core fetch ──────────────────────────────────────────────────────────────

async function fetchTrends(jobData) {
  const { keyword, geo, hours, cacheKey } = jobData;

  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) throw new Error('RAPIDAPI_KEY is not set in environment');

  const response = await axios.post(
    `https://${RAPIDAPI_HOST}/api/v1/trends`,
    { geo, hours: String(hours), sort: 'title' },
    {
      headers: {
        'Content-Type': 'application/json',
        'x-rapidapi-host': RAPIDAPI_HOST,
        'x-rapidapi-key': apiKey,
      },
      timeout: 30_000,
    }
  );

  if (!response.data?.success) {
    throw new Error(response.data?.message || 'RapidAPI returned an error');
  }

  const allTrends = (response.data.data || []).filter(t => t.trends_keyword);

  // ── keyword filter ─────────────────────────────────────────────────────────
  let filtered = allTrends;
  let keywordFound = false;
  if (keyword && keyword.trim()) {
    const kw = keyword.toLowerCase();
    const matches = allTrends.filter(t =>
      t.trends_keyword.toLowerCase().includes(kw) ||
      (t.trend_breakdown || []).some(b => b.keywords?.toLowerCase().includes(kw))
    );
    if (matches.length > 0) {
      filtered = matches;
      keywordFound = true;
    }
  }

  // Sort by volume desc
  const sorted = [...filtered].sort((a, b) => parseVolume(b.seach_volume) - parseVolume(a.seach_volume));

  // ── interest over time (hourly/daily buckets) ──────────────────────────────
  const bucketSize  = hours <= 24 ? 2 : hours <= 72 ? 6 : 24; // 2h / 6h / 24h
  const numBuckets  = Math.ceil(hours / bucketSize);
  const buckets     = Array.from({ length: numBuckets }, (_, i) => ({
    hoursAgo: (i + 1) * bucketSize,
    volume: 0,
    count: 0,
  }));

  for (const t of allTrends) {
    const hoursAgo = parseAgoMs(t.started_at) / 3_600_000;
    const idx = Math.min(Math.floor(hoursAgo / bucketSize), numBuckets - 1);
    if (idx >= 0) {
      buckets[idx].volume += parseVolume(t.seach_volume);
      buckets[idx].count  += 1;
    }
  }

  const rawVolumes     = buckets.map(b => b.volume);
  const normalizedVals = normalize100(rawVolumes);
  const now            = Date.now();

  const interestOverTime = buckets
    .map((b, i) => ({
      time:      b.hoursAgo <= 24 ? `${b.hoursAgo}h ago` : `${Math.round(b.hoursAgo / 24)}d ago`,
      date:      new Date(now - b.hoursAgo * 3_600_000).toISOString(),
      value:     normalizedVals[i],
      rawVolume: b.volume,
      count:     b.count,
    }))
    .reverse(); // oldest → newest

  // ── top trending as "regions" (bar list) ───────────────────────────────────
  const topRegions = sorted.slice(0, 25).map((t, i) => ({
    geoCode:   `${i + 1}`,
    geoName:   t.trends_keyword,
    value:     parseVolume(t.seach_volume),
    formatted: t.seach_volume,
    startedAt: t.started_at,
  }));

  // ── related queries & topics ───────────────────────────────────────────────
  const allBreakdown = allTrends.flatMap(t =>
    (t.trend_breakdown || []).map(b => b.keywords?.trim()).filter(Boolean)
  );
  const uniqueBreakdown = [...new Set(allBreakdown)];

  // Rising = trending topics with volume (used for the "Rising" column)
  const risingItems = sorted.slice(0, 25).map((t, i) => ({
    rank:      i + 1,
    query:     t.trends_keyword,
    value:     parseVolume(t.seach_volume),
    label:     t.seach_volume,
    breakout:  parseVolume(t.seach_volume) >= 500_000,
    changePct: null,
  }));

  // Top = related breakdown keywords
  const topItems = uniqueBreakdown.slice(0, 25).map((q, i) => ({
    rank:  i + 1,
    query: q,
    value: null,
  }));

  const queries = { top: topItems, rising: risingItems };
  const topics  = { top: [],       rising: [] };

  // ── summary ────────────────────────────────────────────────────────────────
  const topTrend    = sorted[0];
  const topVolume   = topTrend ? parseVolume(topTrend.seach_volume) : 0;
  const trendingScore = topVolume > 0
    ? Math.min(100, Math.round((Math.log10(topVolume) / 7) * 100))
    : 0;

  const totalVol  = sorted.reduce((s, t) => s + parseVolume(t.seach_volume), 0);
  const avgVol    = sorted.length ? Math.round(totalVol / sorted.length) : 0;
  const avgScore  = avgVol > 0 ? Math.min(100, Math.round((Math.log10(avgVol) / 7) * 100)) : 0;

  // ── build payload ──────────────────────────────────────────────────────────
  const payload = {
    success:      true,
    query:        keywordFound ? keyword : (keyword ? `${keyword} (not trending — showing all ${geo} trends)` : `Trending in ${geo}`),
    displayQuery: keyword || `Trending in ${geo}`,
    country:      geo,
    geo,
    hours,
    keywordFound,
    totalTrends:  allTrends.length,
    filteredCount: filtered.length,
    fallbacks:    [],
    interestOverTime,
    queries,
    topics,
    relatedQueries: queries,
    topRegions,
    summary: {
      trendingScore,
      momentum:        { changePct: 0, direction: topVolume > 100_000 ? 'up' : 'flat' },
      averageInterest: avgScore,
      peakInterest: topTrend ? {
        value: trendingScore,
        time:  topTrend.trends_keyword,
        date:  new Date(now - parseAgoMs(topTrend.started_at)).toISOString(),
      } : null,
      dataPoints:        interestOverTime.filter(b => b.count > 0).length,
      topRegionsCount:   topRegions.length,
      topQueriesCount:   topItems.length,
      risingQueriesCount: risingItems.length,
      topTopicsCount:    0,
      risingTopicsCount: 0,
    },
    lastUpdated: new Date().toISOString(),
  };

  await cacheService.set(CACHE_PREFIX + cacheKey, payload, FRESH_TTL);
  await cacheService.set(STALE_PREFIX + cacheKey, payload, STALE_TTL);

  return payload;
}

// ─── worker registration ─────────────────────────────────────────────────────

function registerWorker() {
  const queue = getTrendsQueue();
  if (!queue) {
    console.log('[TrendsWorker] Queue not available — using synchronous fallback');
    return;
  }

  queue.process(1, async (job) => {
    console.log(`[TrendsWorker] Job ${job.id} started — keyword: "${job.data.keyword}" geo: ${job.data.geo}`);
    await job.progress(5);
    const result = await fetchTrends(job.data);
    await job.progress(100);
    return result;
  });

  queue.on('completed', (job) => {
    console.log(`[TrendsWorker] Job ${job.id} completed`);
  });
  queue.on('failed', (job, err) => {
    console.error(`[TrendsWorker] Job ${job.id} failed — ${err.message}`);
  });

  console.log('[TrendsWorker] Worker registered (concurrency: 1)');
}

module.exports = { fetchTrends, registerWorker };
