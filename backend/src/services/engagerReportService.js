/**
 * Engager analysis report: the data behind the PDF and Excel downloads.
 *
 * Built from a stored analysis only (no X API calls), limited to a date range
 * inside what the analysis covers. Engager counts are recounted over the posts
 * in that range, so a narrower range gives that period's engagers, not the
 * whole window's.
 */

const { frequencyFor } = require('./engagerSnapshots');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const TOP_ENGAGERS = 25;
const TOP_POSTS = 10;
const ENGAGERS_PER_POST = 5;
const TIERS = ['super-active', 'regular', 'occasional', 'one-time'];

const istDay = (d) => new Date(new Date(d).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** 'YYYY-MM-DD' in IST -> start or end of that day as a Date; null if malformed. */
const parseIstDate = (value, endOfDay = false) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const d = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+05:30`);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** First and last post dates the analysis holds: the range a report may use. */
const coverage = (analysis) => {
  const times = (analysis.tweets || [])
    .map((t) => (t.created_at ? new Date(t.created_at).getTime() : NaN))
    .filter(Number.isFinite);
  if (!times.length) return null;
  return { start: new Date(Math.min(...times)), end: new Date(Math.max(...times)) };
};

/**
 * @param {object} analysis  a completed EngagerAnalysis (lean)
 * @param {{from: Date, to: Date}} range  already checked against coverage()
 */
const buildReportData = (analysis, { from, to }) => {
  const inRange = (t) => {
    if (!t.created_at) return false;
    const ms = new Date(t.created_at).getTime();
    return ms >= from.getTime() && ms <= to.getTime();
  };
  const posts = (analysis.tweets || []).filter(inRange)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const postById = new Map(posts.map((p) => [String(p.tweet_id), p]));
  const withRetweeterData = posts.filter((p) => (p.retweeters_found || 0) > 0).length;

  // Recount each engager over the posts in range only.
  const engagers = [];
  for (const e of analysis.engagers || []) {
    const ids = (e.tweet_ids || []).map(String).filter((id) => postById.has(id));
    if (!ids.length) continue;
    const dates = ids.map((id) => new Date(postById.get(id).created_at).getTime());
    engagers.push({
      handle: e.handle,
      name: e.name || e.handle,
      verified: !!e.verified,
      posts_retweeted: ids.length,
      share: withRetweeterData ? ids.length / withRetweeterData : 0,
      frequency: frequencyFor(ids.length, posts.length),
      first_engaged: new Date(Math.min(...dates)),
      last_engaged: new Date(Math.max(...dates)),
      tweet_ids: ids,
    });
  }
  engagers.sort((a, b) => b.posts_retweeted - a.posts_retweeted
    || TIERS.indexOf(a.frequency) - TIERS.indexOf(b.frequency)
    || a.handle.localeCompare(b.handle));
  const rank = new Map(engagers.map((e, i) => [e.handle, i]));

  const engagersByPost = new Map();
  for (const e of engagers) {
    for (const id of e.tweet_ids) {
      if (!engagersByPost.has(id)) engagersByPost.set(id, []);
      engagersByPost.get(id).push(e);
    }
  }
  const postRows = posts.map((p) => {
    const by = (engagersByPost.get(String(p.tweet_id)) || []).sort((a, b) => rank.get(a.handle) - rank.get(b.handle));
    return {
      tweet_id: String(p.tweet_id),
      created_at: p.created_at ? new Date(p.created_at) : null,
      text: p.text || '',
      url: p.content_url || '',
      retweets: p.retweet_count || 0,
      likes: p.like_count || 0,
      replies: p.reply_count || 0,
      quotes: p.quote_count || 0,
      views: p.view_count || 0,
      retweeters_found: p.retweeters_found || 0,
      engagers: by.map((e) => e.handle),
      top_engagers: by.slice(0, ENGAGERS_PER_POST).map((e) => e.handle),
    };
  });

  const days = new Map();
  for (const p of postRows) {
    const k = istDay(p.created_at);
    const d = days.get(k) || { day: k, posts: 0, retweeters: 0 };
    d.posts += 1;
    d.retweeters += p.retweeters_found;
    days.set(k, d);
  }

  const sum = (f) => postRows.reduce((s, p) => s + f(p), 0);
  const summary = Object.fromEntries(TIERS.map((t) => [t, 0]));
  for (const e of engagers) summary[e.frequency] += 1;

  return {
    account: {
      handle: analysis.handle,
      display_name: analysis.display_name || analysis.handle,
      url: `https://x.com/${analysis.handle}`,
    },
    analysis: {
      id: analysis.id,
      analyzed_at: analysis.analyzed_at,
      period_days: analysis.period_days,
      coverage: coverage(analysis),
    },
    range: { from, to },
    totals: {
      posts: postRows.length,
      posts_with_retweeter_data: withRetweeterData,
      unique_engagers: engagers.length,
      retweet_events: engagers.reduce((s, e) => s + e.posts_retweeted, 0),
      verified_engagers: engagers.filter((e) => e.verified).length,
      retweets: sum((p) => p.retweets),
      likes: sum((p) => p.likes),
      replies: sum((p) => p.replies),
      views: sum((p) => p.views),
    },
    summary,
    top_engagers: engagers.slice(0, TOP_ENGAGERS),
    engagers,
    top_posts: [...postRows].sort((a, b) => b.retweets - a.retweets || b.retweeters_found - a.retweeters_found).slice(0, TOP_POSTS),
    timeline: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    posts: postRows,
  };
};

module.exports = { buildReportData, coverage, parseIstDate, istDay, TOP_ENGAGERS };
