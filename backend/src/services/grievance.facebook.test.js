/**
 * Facebook grievance ingestion — unit tests (no database, no provider, no network).
 *
 *   node --test src/services/grievance.facebook.test.js
 *
 * Covers the mentions pass: which posts count as naming the monitored page, the
 * dedupe rules against the page's own timeline, and the fields written.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const stub = (rel, exports) => {
  const id = require.resolve(path.join(__dirname, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

// ── Edge stubs ─────────────────────────────────────────────────────────────

const saved = [];
class FakeGrievance {
  constructor(doc) { Object.assign(this, doc); }
  async save() { saved.push(this); FakeGrievance.docs.push(this); return this; }
}
FakeGrievance.docs = [];
FakeGrievance.findOne = async (filter) => {
  const ids = filter?.tweet_id?.$in || [filter?.tweet_id];
  return FakeGrievance.docs.find((d) => d.tenant_id === filter.tenant_id && ids.includes(d.tweet_id)) || null;
};
FakeGrievance.reset = () => { FakeGrievance.docs.length = 0; saved.length = 0; };

stub('../models/Grievance.js', FakeGrievance);
stub('../models/GrievanceSource.js', {});
stub('../models/GrievanceSettings.js', {});
stub('./blugate/index.js', {});
stub('./complaintCodeService.js', { generateComplaintCode: async () => 'CODE-1' });
stub('./grievanceWorkflowService.js', { syncLegacyFieldsFromWorkflow: () => {} });

let searchResults = [];
stub('./rapidApiFacebookService.js', {
  searchPosts: async () => searchResults,
  fetchPagePosts: async () => [],
  fetchPostComments: async () => [],
  fetchPageDetails: async () => null,
  searchPages: async () => [],
});

const { __private: { upsertFacebookMentionsForSource, mentionNamesSource } } = require('./grievanceService');

const SOURCE = {
  id: 'src-1', tenant_id: 'tenant-a', handle: '100064', display_name: 'Cyberabad Police',
  state: 'Telangana', districts: ['Hyderabad'], platform: 'facebook',
};

const post = (over = {}) => ({
  id: `p-${Math.random().toString(36).slice(2, 8)}`, text: 'Cyberabad Police please act on this pothole',
  author: 'Citizen One', author_handle: 'citizen_one', created_at: new Date().toISOString(),
  url: 'https://facebook.com/p/1', media: [], metrics: { likes: 2, shares: 1, comments: 3, views: 40 }, ...over,
});

// ── Relevance ──────────────────────────────────────────────────────────────

test('a post counts as a mention only when it actually names the page', () => {
  assert.equal(mentionNamesSource('Cyberabad Police please help', SOURCE), true);
  assert.equal(mentionNamesSource('cyberabad police commissioner should act', SOURCE), true, 'name words in another order/case');
  assert.equal(mentionNamesSource('Traffic jam in Mumbai today', SOURCE), false, 'unrelated post from a fuzzy search');
  assert.equal(mentionNamesSource('', SOURCE), false);
  // A one-word page name must not match on that word alone...
  assert.equal(mentionNamesSource('heavy traffic near the mall', { ...SOURCE, display_name: 'Traffic' }), false);
  // ...unless the tenant's own state or district backs it up.
  assert.equal(mentionNamesSource('traffic mess in Hyderabad again', { ...SOURCE, display_name: 'Traffic' }), true);
  // A non-numeric page handle in the text also counts.
  assert.equal(mentionNamesSource('complained to cyberabadpolice yesterday', { ...SOURCE, display_name: '', handle: 'cyberabadpolice' }), true);
});

// ── Ingestion ──────────────────────────────────────────────────────────────

test('mentions are stored with the source\'s district scope and Facebook ids', async () => {
  FakeGrievance.reset();
  searchResults = [post({ id: '555' })];

  const result = await upsertFacebookMentionsForSource(SOURCE);

  assert.deepEqual(result, { newCount: 1, totalFetched: 1 });
  const g = saved[0];
  assert.equal(g.tweet_id, 'facebook:mention:555');
  assert.equal(g.platform, 'facebook');
  assert.equal(g.tenant_id, 'tenant-a');
  assert.equal(g.state, 'Telangana');
  assert.deepEqual(g.districts, ['Hyderabad']);
  assert.equal(g.tagged_account, '100064');
  assert.equal(g.grievance_source_id, 'src-1');
  assert.equal(g.posted_by.handle, 'citizen_one');
  assert.equal(g.content.text, 'Cyberabad Police please act on this pothole');
  assert.equal(g.engagement.retweets, 1, 'shares map to retweets');
  assert.equal(g.engagement.replies, 3, 'comments map to replies');
  assert.equal(g.workflow_status, 'received');
});

test('irrelevant posts, the page\'s own posts, and already-stored posts are skipped', async () => {
  FakeGrievance.reset();
  FakeGrievance.docs.push({ tenant_id: 'tenant-a', tweet_id: 'facebook:post:900' });   // from the timeline pass
  FakeGrievance.docs.push({ tenant_id: 'tenant-a', tweet_id: 'facebook:mention:901' }); // from an earlier run
  searchResults = [
    post({ id: '900' }),
    post({ id: '901' }),
    post({ id: '902', text: 'Completely unrelated post about cricket' }),
    post({ id: '903', author_handle: '100064' }),                       // the page itself
    post({ id: '904' }),                                                // the only new one
  ];

  const result = await upsertFacebookMentionsForSource(SOURCE);

  assert.equal(result.newCount, 1);
  assert.deepEqual(saved.map((g) => g.tweet_id), ['facebook:mention:904']);
});

test('mentions outside the requested date range are ignored', async () => {
  FakeGrievance.reset();
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  searchResults = [post({ id: '910', created_at: old }), post({ id: '911' })];
  const today = new Date().toISOString().slice(0, 10);

  const result = await upsertFacebookMentionsForSource(SOURCE, today, today);

  assert.equal(result.newCount, 1);
  assert.equal(saved[0].tweet_id, 'facebook:mention:911');
});

test('a page with no name is not searched at all', async () => {
  FakeGrievance.reset();
  searchResults = [post()];
  const result = await upsertFacebookMentionsForSource({ ...SOURCE, display_name: '', handle: '' });
  assert.deepEqual(result, { newCount: 0, totalFetched: 0 });
  assert.equal(saved.length, 0);
});
