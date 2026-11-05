/**
 * Engager analysis report — unit tests (no database, no browser, no network).
 *
 *   node --test src/services/engagerReport.test.js
 *
 * Covers the date range, the per-range recount of engagers, the snapshot
 * merge, and the HTML and Excel outputs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');

const { frequencyFor, mergeSnapshots } = require('./engagerSnapshots');
const { buildReportData, coverage, parseIstDate, istDay } = require('./engagerReportService');
const { buildReportHtml, buildReportWorkbook } = require('./engagerReportRender');

// Four posts over three IST days; p4 has no retweeter data.
const analysis = {
  id: 'a1',
  handle: 'acct',
  display_name: 'An Account',
  analyzed_at: new Date('2026-11-04T10:00:00Z'),
  period_days: 30,
  status: 'completed',
  tweets: [
    { tweet_id: 'p1', text: 'first', created_at: new Date('2026-11-01T04:00:00Z'), content_url: 'https://x.com/acct/status/p1', retweet_count: 50, like_count: 5, view_count: 1000, retweeters_found: 3 },
    { tweet_id: 'p2', text: 'second', created_at: new Date('2026-11-02T04:00:00Z'), content_url: 'u2', retweet_count: 20, like_count: 2, view_count: 500, retweeters_found: 2 },
    { tweet_id: 'p3', text: 'third', created_at: new Date('2026-11-03T04:00:00Z'), content_url: 'u3', retweet_count: 90, like_count: 9, view_count: 900, retweeters_found: 1 },
    { tweet_id: 'p4', text: 'fourth', created_at: new Date('2026-11-03T05:00:00Z'), content_url: 'u4', retweet_count: 0, retweeters_found: 0 },
  ],
  engagers: [
    { handle: 'alice', name: 'Alice', verified: true, tweet_ids: ['p1', 'p2', 'p3'] },
    { handle: 'bob', name: 'Bob', tweet_ids: ['p1', 'p2'] },
    { handle: 'carol', name: 'Carol', tweet_ids: ['p1'] },
    { handle: 'old', name: 'Gone', tweet_ids: ['p0-outside'] },
  ],
};
const full = () => ({ from: parseIstDate('2026-11-01'), to: parseIstDate('2026-11-03', true) });

test('frequency tiers follow ratio or absolute counts', () => {
  assert.equal(frequencyFor(10, 100), 'super-active');
  assert.equal(frequencyFor(5, 10), 'super-active');
  assert.equal(frequencyFor(5, 100), 'regular');
  assert.equal(frequencyFor(2, 100), 'occasional');
  assert.equal(frequencyFor(1, 100), 'one-time');
  assert.equal(frequencyFor(1, 0), 'one-time');
});

test('a re-fetched post is replaced; old-only posts are kept', () => {
  const merged = mergeSnapshots(
    [{ tweet_id: 'a', text: 'old' }, { tweet_id: 'b', text: 'kept' }],
    [{ tweet_id: 'a', text: 'new', retweet_count: 7 }, { tweet_id: 'c', text: 'fresh' }]
  );
  const byId = Object.fromEntries(merged.map((t) => [t.tweet_id, t]));
  assert.deepEqual(Object.keys(byId).sort(), ['a', 'b', 'c']);
  assert.equal(byId.a.text, 'new');
  assert.equal(byId.a.retweet_count, 7);
  assert.equal(byId.b.text, 'kept');
});

test('IST day boundaries', () => {
  assert.equal(parseIstDate('2026-11-01').toISOString(), '2026-10-31T18:30:00.000Z');
  assert.equal(parseIstDate('2026-11-01', true).toISOString(), '2026-11-01T18:29:59.999Z');
  assert.equal(parseIstDate('01-11-2026'), null);
  assert.equal(parseIstDate(''), null);
  // 20:00 UTC is already the next day in IST
  assert.equal(istDay(new Date('2026-11-01T20:00:00Z')), '2026-11-02');
});

test('coverage is the first and last post date', () => {
  const c = coverage(analysis);
  assert.equal(c.start.toISOString(), '2026-11-01T04:00:00.000Z');
  assert.equal(c.end.toISOString(), '2026-11-03T05:00:00.000Z');
  assert.equal(coverage({ tweets: [{ tweet_id: 'x' }] }), null);
});

test('full range: totals, ranking, share and tiers', () => {
  const d = buildReportData(analysis, full());
  assert.equal(d.totals.posts, 4);
  assert.equal(d.totals.posts_with_retweeter_data, 3);
  assert.equal(d.totals.unique_engagers, 3, 'an engager with no post in range is dropped');
  assert.equal(d.totals.retweet_events, 6);
  assert.equal(d.totals.verified_engagers, 1);
  assert.equal(d.totals.retweets, 160);
  assert.deepEqual(d.engagers.map((e) => e.handle), ['alice', 'bob', 'carol']);
  assert.equal(d.engagers[0].share, 1);
  assert.equal(d.engagers[0].frequency, 'super-active');        // 3 of 4 posts
  assert.equal(d.engagers[1].frequency, 'super-active');        // 2 of 4 = 50%
  assert.equal(d.engagers[2].frequency, 'regular');             // 1 of 4 = 25%
  assert.equal(d.summary['super-active'], 2);
});

test('a narrower range recounts engagers over that range only', () => {
  const d = buildReportData(analysis, { from: parseIstDate('2026-11-02'), to: parseIstDate('2026-11-03', true) });
  assert.equal(d.totals.posts, 3);
  assert.deepEqual(d.engagers.map((e) => [e.handle, e.posts_retweeted]), [['alice', 2], ['bob', 1]]);
  assert.ok(!d.engagers.some((e) => e.handle === 'carol'), 'carol only retweeted p1, outside the range');
  assert.equal(d.engagers[0].first_engaged.toISOString(), '2026-11-02T04:00:00.000Z');
});

test('top posts by retweets, with their top engagers in rank order', () => {
  const d = buildReportData(analysis, full());
  assert.deepEqual(d.top_posts.map((p) => p.tweet_id), ['p3', 'p1', 'p2', 'p4']);
  assert.deepEqual(d.top_posts[1].top_engagers, ['alice', 'bob', 'carol']);
});

test('timeline groups posts by IST day', () => {
  const d = buildReportData(analysis, full());
  assert.deepEqual(d.timeline, [
    { day: '2026-11-01', posts: 1, retweeters: 3 },
    { day: '2026-11-02', posts: 1, retweeters: 2 },
    { day: '2026-11-03', posts: 2, retweeters: 1 },
  ]);
});

test('HTML escapes post text and names', () => {
  const evil = {
    ...analysis,
    tweets: [{ ...analysis.tweets[0], text: '<script>alert(1)</script>' }],
    engagers: [{ handle: 'x', name: '<img src=x onerror=alert(1)>', tweet_ids: ['p1'] }],
  };
  const html = buildReportHtml(buildReportData(evil, full()), { generatedBy: 'Officer <b>' });
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('Officer &lt;b&gt;'));
});

test('HTML has the engager sections and no post-type sections', () => {
  const html = buildReportHtml(buildReportData(analysis, full()), { generatedBy: 'Officer' });
  for (const s of ['Engager tiers', 'Most engaged accounts', 'Most amplified posts', 'Method and limits', 'Appendix A', 'Appendix B']) {
    assert.ok(html.includes(s), s);
  }
  for (const s of ['What the account posted', 'High-risk', 'Sentiment', 'classified']) {
    assert.ok(!html.includes(s), `unexpected: ${s}`);
  }
});

test('Excel workbook has every sheet and every engager and post', async () => {
  const buf = await buildReportWorkbook(buildReportData(analysis, full()), { generatedBy: 'Officer' });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  assert.deepEqual(wb.worksheets.map((s) => s.name), ['Summary', 'Engagers', 'Posts', 'Post engagers']);
  assert.equal(wb.getWorksheet('Engagers').rowCount, 1 + 3);
  assert.equal(wb.getWorksheet('Posts').rowCount, 1 + 4);
  assert.equal(wb.getWorksheet('Post engagers').rowCount, 1 + 6);
  assert.equal(wb.getWorksheet('Engagers').getRow(2).getCell(2).value, '@alice');
});

test('posts older than the cutoff, or undated, are dropped', () => {
  const { dropOlderThan } = require('./engagerSnapshots');
  const kept = dropOlderThan([
    { tweet_id: 'new', created_at: new Date('2026-11-01T00:00:00Z') },
    { tweet_id: 'old', created_at: new Date('2026-07-01T00:00:00Z') },
    { tweet_id: 'nodate', created_at: null },
  ], new Date('2026-08-05T00:00:00Z'));
  assert.deepEqual(kept.map((t) => t.tweet_id), ['new']);
});
