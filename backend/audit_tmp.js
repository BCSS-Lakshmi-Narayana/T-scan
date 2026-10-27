require('dotenv').config();
const m = require('mongoose');

const TENANT = 'e4b1ec57-ceff-4f3c-a33a-7b34e1fb71d2';
const pct = (a, b) => b ? `${Math.round(a / b * 100)}%` : '-';

(async () => {
  await m.connect(process.env.MONGODB_URI, { dbName: 'police_tenant_t-scan' });
  const db = m.connection;

  const head = (s) => console.log(`\n${'='.repeat(72)}\n${s}\n${'='.repeat(72)}`);

  // ---- 1. analysis coverage --------------------------------------------- //
  head('1. ANALYSIS COVERAGE  (unanalysed = unanswerable)');
  for (const c of ['contents', 'grievances', 'comments']) {
    const col = db.collection(c);
    const total = await col.countDocuments({ tenant_id: TENANT });
    if (!total) continue;
    const rows = await col.aggregate([
      { $match: { tenant_id: TENANT } },
      { $group: { _id: '$analysis_status', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]).toArray();
    const done = rows.find(r => r._id === 'done')?.n || 0;
    const stranded = rows.find(r => r._id === null || r._id === undefined)?.n || 0;
    console.log(`\n  ${c}: ${total} docs, ${done} analysed (${pct(done, total)})`);
    rows.forEach(r => console.log(`      ${String(r._id)}: ${r.n}`));
    if (stranded) console.log(`      ^^ ${stranded} have NO status and can never be claimed`);
  }

  // ---- 2. facet population ---------------------------------------------- //
  head('2. FACET POPULATION  (what the engine can filter on)');
  const facetCheck = async (c, checks) => {
    const col = db.collection(c);
    const total = await col.countDocuments({ tenant_id: TENANT });
    if (!total) return;
    console.log(`\n  ${c} (${total} docs)`);
    for (const [label, q] of checks) {
      const n = await col.countDocuments({ tenant_id: TENANT, ...q });
      const flag = n / total < 0.5 ? '  <-- thin' : '';
      console.log(`      ${label.padEnd(26)} ${String(n).padStart(5)}  ${pct(n, total).padStart(4)}${flag}`);
    }
  };
  await facetCheck('contents', [
    ['sentiment', { sentiment: { $nin: [null, ''] } }],
    ['risk_level', { risk_level: { $nin: [null, ''] } }],
    ['content_url (link)', { content_url: { $nin: [null, ''] } }],
    ['author_handle', { author_handle: { $nin: [null, ''] } }],
    ['published_at', { published_at: { $ne: null } }],
    ['districts', { 'districts.0': { $exists: true } }],
  ]);
  await facetCheck('grievances', [
    ['analysis.sentiment', { 'analysis.sentiment': { $nin: [null, ''] } }],
    ['analysis.stance', { 'analysis.stance': { $nin: [null, ''] } }],
    ['analysis.category', { 'analysis.category': { $nin: [null, ''] } }],
    ['tweet_url (link)', { tweet_url: { $nin: [null, ''] } }],
    ['post_date', { post_date: { $ne: null } }],
    ['districts', { 'districts.0': { $exists: true } }],
  ]);
  await facetCheck('alerts', [
    ['risk_level', { risk_level: { $nin: [null, ''] } }],
    ['content_url (link)', { content_url: { $nin: [null, ''] } }],
    ['author_handle', { author_handle: { $nin: [null, ''] } }],
    ['content_published_at', { content_published_at: { $ne: null } }],
    ['districts', { 'districts.0': { $exists: true } }],
    ['llm_analysis', { llm_analysis: { $ne: null } }],
  ]);

  // ---- 3. junk in live data --------------------------------------------- //
  head('3. TEST / JUNK RECORDS IN LIVE DATA');
  for (const c of ['alerts', 'contents', 'grievances']) {
    const col = db.collection(c);
    const n = await col.countDocuments({
      tenant_id: TENANT,
      $or: [
        { author_handle: /test/i }, { author: /test/i },
        { 'posted_by.handle': /test/i },
      ],
    });
    if (n) console.log(`  ${c}: ${n} record(s) from a test* handle`);
  }

  // ---- 4. indexes on the source collections ------------------------------ //
  head('4. INDEXES ON SOURCE COLLECTIONS');
  for (const c of ['alerts', 'contents', 'grievances']) {
    const ix = await db.collection(c).indexes();
    const names = ix.map(i => i.name).filter(n => n !== '_id_');
    console.log(`  ${c}: ${names.length ? names.join(', ') : '(none beyond _id)'}`);
  }

  // ---- 5. how far back the data goes ------------------------------------- //
  head('5. DATE RANGE  (the 7-day default was hiding most of this)');
  for (const [c, f] of [['alerts', 'content_published_at'], ['contents', 'published_at'], ['grievances', 'post_date']]) {
    const col = db.collection(c);
    const oldest = await col.find({ tenant_id: TENANT, [f]: { $ne: null } }).sort({ [f]: 1 }).limit(1).toArray();
    const newest = await col.find({ tenant_id: TENANT, [f]: { $ne: null } }).sort({ [f]: -1 }).limit(1).toArray();
    const o = oldest[0]?.[f], nw = newest[0]?.[f];
    if (o && nw) {
      const days = Math.round((new Date(nw) - new Date(o)) / 86400000);
      console.log(`  ${c.padEnd(12)} ${String(o).slice(0, 10)} -> ${String(nw).slice(0, 10)}  (${days} days)`);
    }
  }

  await m.disconnect();
})();
