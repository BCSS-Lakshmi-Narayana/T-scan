/**
 * Sentiment pipeline — end-to-end tests over in-memory models.
 *
 *   node --test src/services/sentiment/sentiment.pipeline.test.js
 *
 * Runs the real analyzer, store, targets and pipeline. Only the edges are
 * replaced: Mongo models (an in-memory fake supporting the operators the store
 * uses), the HTTP call to the service, and side-effect services.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.SENTIMENT_MAX_ATTEMPTS = '3';
process.env.SENTIMENT_ROUNDS_PER_TICK = '4';
process.env.SENTIMENT_CLAIM_SIZE = '32';

const resolveRel = (rel) => require.resolve(path.join(__dirname, rel));
const stub = (rel, exports) => {
  const id = resolveRel(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

// ── In-memory model ────────────────────────────────────────────────────────

const getPath = (doc, key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);

const matchValue = (actual, cond) => {
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    return Object.entries(cond).every(([op, v]) => {
      switch (op) {
        case '$in': return Array.isArray(actual) ? actual.some((a) => v.includes(a)) : v.includes(actual ?? null);
        case '$nin': return !v.includes(actual ?? null);
        case '$ne': return actual !== v;
        case '$lt': return actual != null && actual < v;
        case '$lte': return actual != null && actual <= v;
        case '$gt': return actual != null && actual > v;
        case '$gte': return actual != null && actual >= v;
        case '$exists': return v ? actual !== undefined : actual === undefined;
        default: throw new Error(`fake model: unsupported operator ${op}`);
      }
    });
  }
  if (cond === null) return actual === null || actual === undefined;
  if (Array.isArray(actual)) return actual.includes(cond);
  return actual === cond;
};

const matches = (doc, filter = {}) => Object.entries(filter).every(([k, v]) => {
  if (k === '$or') return v.some((f) => matches(doc, f));
  if (k === '$and') return v.every((f) => matches(doc, f));
  return matchValue(getPath(doc, k), v);
});

const applyUpdate = (doc, update) => {
  const hasOps = Object.keys(update).some((k) => k.startsWith('$'));
  const set = hasOps ? update.$set || {} : update;
  for (const [k, v] of Object.entries(set)) doc[k] = v;
  for (const k of Object.keys(update.$unset || {})) delete doc[k];
};

let idSeq = 0;
const createFakeModel = (name) => {
  const docs = [];
  const query = (list) => {
    let result = list;
    const q = {
      select() { return q; },
      sort(spec) {
        const [[key, dir]] = Object.entries(spec);
        result = [...result].sort((a, b) => (a[key] > b[key] ? dir : a[key] < b[key] ? -dir : 0));
        return q;
      },
      limit(n) { result = result.slice(0, n); return q; },
      lean() { return q; },
      then(res, rej) { return Promise.resolve(result.map((d) => ({ ...d }))).then(res, rej); },
    };
    return q;
  };
  return {
    modelName: name,
    docs,
    insert(doc) { const d = { _id: ++idSeq, ...doc }; docs.push(d); return d; },
    find(filter) { return query(docs.filter((d) => matches(d, filter))); },
    findOne(filter) {
      const hit = docs.find((d) => matches(d, filter));
      const q = query(hit ? [hit] : []);
      q.then = (res, rej) => Promise.resolve(hit ? { ...hit } : null).then(res, rej);
      return q;
    },
    async exists(filter) { return docs.some((d) => matches(d, filter)) ? { _id: 1 } : null; },
    async countDocuments(filter) { return docs.filter((d) => matches(d, filter)).length; },
    async updateMany(filter, update) {
      const hit = docs.filter((d) => matches(d, filter));
      hit.forEach((d) => applyUpdate(d, update));
      return { matchedCount: hit.length, modifiedCount: hit.length };
    },
    async updateOne(filter, update) {
      const hit = docs.find((d) => matches(d, filter));
      if (hit) applyUpdate(hit, update);
      return { matchedCount: hit ? 1 : 0, modifiedCount: hit ? 1 : 0 };
    },
    findOneAndUpdate(filter, update, opts = {}) {
      let hit = docs.find((d) => matches(d, filter));
      if (!hit && opts.upsert) {
        hit = { _id: ++idSeq, ...filter, ...(update.$setOnInsert || {}) };
        docs.push(hit);
      }
      if (hit) applyUpdate(hit, update);
      const out = hit ? { ...hit } : null;
      return { select: () => ({ lean: async () => out }) };
    },
    async create(doc) { return this.insert({ id: `${name}-${idSeq + 1}`, created_at: new Date(), ...doc }); },
    reset() { docs.length = 0; },
  };
};

const Content = createFakeModel('Content');
const Comment = createFakeModel('Comment');
const Grievance = createFakeModel('Grievance');
const Analysis = createFakeModel('Analysis');
const Alert = createFakeModel('Alert');
const Source = createFakeModel('Source');

stub('../../models/Content.js', Content);
stub('../../models/Comment.js', Comment);
stub('../../models/Grievance.js', Grievance);
stub('../../models/Analysis.js', Analysis);
stub('../../models/Alert.js', Alert);
stub('../../models/Source.js', Source);

// ── Edge stubs ─────────────────────────────────────────────────────────────

const MAPPINGS = {
  'tenant-a': [{ category_id: 'Hate_Speech', definition: 'A', severity_level: 'High', keywords: [], districts: [], legal_sections: [], platform_policies: {} }],
  'tenant-b': [{ category_id: 'Fraud', definition: 'B', severity_level: 'Low', keywords: [], districts: [], legal_sections: [], platform_policies: {} }],
};
let mappingOverride = null;
stub('../mappingService.js', {
  getTenantCategories: (tenantId) => MAPPINGS[tenantId] || [],
  resolveForAnalysis: ({ category }) => ({
    category_id: category,
    legal_sections: [], platform_policies: [], triggered_keywords: [],
    ...(mappingOverride || {}),
  }),
});
let tenantKeywords = [];
let districtSettings = null;
const DEFAULT_SETTINGS = { high_risk_threshold: 70, medium_risk_threshold: 40 };
stub('../pipeline/tenantContextService.js', { getContext: async (tenantId) => ({ tenant_id: tenantId, name: `${tenantId} Police`, keywords: tenantKeywords }) });
stub('../settingsResolver.js', { getSettingsForDistricts: async () => districtSettings || DEFAULT_SETTINGS });
let velocityResult = null;
stub('../velocityAlertService.js', { checkVelocity: async () => velocityResult, updateEngagementHistory: async () => {} });
stub('../emailService.js', { sendAlertEmail: async () => {} });
let cacheClears = 0;
stub('../alertCache.js', { clearAlertCache: async () => { cacheClears += 1; } });
stub('../mediaTranscriptUtils.js', { buildTextWithTranscript: async ({ text }) => text });

// Records every dispatch (key + lane) and runs it immediately.
const dispatches = [];
stub('./sentiment.dispatcher.js', {
  run: (fn, opts) => { dispatches.push(opts); return Promise.resolve().then(fn); },
  stats: () => ({}),
});

// Scriptable service. Default: every text analysed with risk 50.
const requests = [];
let serviceBehaviour = null;
const okResult = (text, intel = {}) => ({
  post_text: text, language: 'en', english_text: text, was_translated: false, was_transliterated: false,
  sentiment: 'Negative', confidence: 0.9,
  intelligence: { category: 'Hate_Speech', intent: 'x', intent_label: 'Opinion', risk_score: 50, reasoning: 'r', summary: 's',
    recommended_action: 'Monitor', evidence_confidence: 'high', signals: [], source: 'provider', keyword_context: [], ...intel },
});
stub('./sentiment.http.js', {
  timeoutMs: () => 180000,
  postIntelligence: async (body) => {
    requests.push(body);
    if (serviceBehaviour) return serviceBehaviour(body);
    return { results: body.texts.map((t) => okResult(t)) };
  },
  getHealth: async () => ({ healthy: true }),
});

let activeTenants = [];
stub('../pipeline/tenantScheduler.js', { getActiveTenants: async () => activeTenants });
stub('../../config/tenantConnections.js', { forTenant: () => null });

const { runTenant } = require('./sentiment.pipeline');
const { startScheduler } = require('./sentiment.scheduler');
const { analyzeText } = require('./sentiment.interactive');
const { runWithTenant } = require('../../config/tenantContext');

// ── Helpers ────────────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
const run = (tenantId) => runWithTenant({ tenant: { id: tenantId, slug: tenantId }, tenantId, connection: null },
  () => runTenant({ id: tenantId, slug: tenantId }));

const reset = () => {
  [Content, Comment, Grievance, Analysis, Alert, Source].forEach((m) => m.reset());
  requests.length = 0;
  dispatches.length = 0;
  serviceBehaviour = null;
  velocityResult = null;
  tenantKeywords = [];
  districtSettings = null;
  mappingOverride = null;
  cacheClears = 0;
};

const addContent = (over = {}) => Content.insert({
  id: `c-${idSeq + 1}`, tenant_id: 'tenant-a', text: 'some post text', districts: [], platform: 'x',
  source_id: 'src-1', author: 'someone', created_at: new Date(), analysis_status: 'pending', analysis_attempts: 0, ...over,
});

// ── Tests ──────────────────────────────────────────────────────────────────

test('analyses monitored content only (events are fetch-only), stores one Analysis, skips empty text', async () => {
  reset();
  Source.insert({ id: 'src-1', tenant_id: 'tenant-a', category: 'political' });
  const monitored = addContent({ id: 'monitored' });
  const event = addContent({ id: 'event', source_id: null });
  const empty = addContent({ id: 'empty', text: '  ' });

  await run('tenant-a');

  const byId = (id) => Content.docs.find((d) => d.id === id);
  assert.equal(byId('monitored').analysis_status, 'done');
  assert.equal(byId('monitored').sentiment, 'negative');
  assert.equal(byId('monitored').risk_level, 'medium');
  assert.equal(byId('monitored').analysis_claim_token, undefined, 'claim not released');
  assert.equal(byId('event').analysis_status, 'pending', 'event content must never be claimed');
  assert.equal(byId('empty').analysis_status, 'skipped');

  assert.equal(Analysis.docs.length, 1);
  assert.equal(Alert.docs.length, 1);
  assert.equal(Alert.docs[0].content_id, monitored.id);
  assert.ok(!Alert.docs.some((a) => a.content_id === event.id), 'event content must not alert');
  assert.equal(requests.length, 1, 'only the monitored post is sent');
  assert.ok(!requests.some((r) => r.texts.includes(byId('event').text) && r.texts.length > 1));
  void empty;
});

test('re-analysis updates the same Analysis row instead of adding another', async () => {
  reset();
  Source.insert({ id: 'src-1', tenant_id: 'tenant-a' });
  addContent({ id: 'again' });
  await run('tenant-a');
  Content.docs[0].analysis_status = 'pending';
  serviceBehaviour = (body) => ({ results: body.texts.map((t) => okResult(t, { risk_score: 90 })) });
  await run('tenant-a');

  assert.equal(Analysis.docs.length, 1);
  assert.equal(Analysis.docs[0].risk_score, 90);
});

test('tenant isolation: a run claims only its own tenant\'s documents and sends its own policy pack', async () => {
  reset();
  addContent({ id: 'a1', tenant_id: 'tenant-a' });
  addContent({ id: 'b1', tenant_id: 'tenant-b' });

  await run('tenant-a');

  assert.equal(Content.docs.find((d) => d.id === 'a1').analysis_status, 'done');
  assert.equal(Content.docs.find((d) => d.id === 'b1').analysis_status, 'pending', 'tenant B was touched by tenant A\'s run');
  assert.deepEqual(requests[0].policy_pack.categories.map((c) => c.id).sort(), ['Hate_Speech', 'Normal']);
  assert.ok(dispatches.every((d) => d.key.startsWith('tenant-a::')), 'dispatched under another tenant\'s bucket');
});

test('one post per request, each dispatched under its own tenant::district bucket', async () => {
  reset();
  for (let i = 0; i < 20; i += 1) addContent({ id: `hyd-${i}`, districts: ['Hyderabad'] });
  addContent({ id: 'wgl-1', districts: ['Warangal'] });

  await run('tenant-a');

  assert.equal(requests.length, 21);
  assert.ok(requests.every((r) => r.texts.length === 1), 'posts were batched');
  assert.equal(dispatches.filter((d) => d.key === 'tenant-a::Hyderabad').length, 20);
  const keys = new Set(dispatches.map((d) => d.key));
  assert.ok(keys.has('tenant-a::Hyderabad') && keys.has('tenant-a::Warangal'));
  assert.ok(Content.docs.every((d) => d.analysis_status === 'done'));
});

test('lanes: fresh content goes routine, backlog goes bulk', async () => {
  reset();
  addContent({ id: 'fresh', created_at: new Date() });
  addContent({ id: 'old', created_at: new Date(Date.now() - 48 * HOUR) });
  await run('tenant-a');
  const lanes = dispatches.map((d) => d.priority).sort();
  assert.deepEqual(lanes, ['bulk', 'routine']);
});

test('backpressure (429): items go back to pending without spending an attempt, and the run stops', async () => {
  reset();
  addContent({ id: 'busy' });
  // More work waiting in other lanes and collections — none of it may be sent once the service is busy.
  addContent({ id: 'backlog', created_at: new Date(Date.now() - 48 * HOUR) });
  Comment.insert({ id: 'cm-wait', tenant_id: 'tenant-a', content_id: 'x', text: 'queued comment',
    created_at: new Date(), analysis_status: 'pending', analysis_attempts: 0 });
  serviceBehaviour = () => { throw Object.assign(new Error('busy'), { kind: 'backpressure', retryAfterS: 20 }); };

  await run('tenant-a');

  const doc = Content.docs.find((d) => d.id === 'busy');
  assert.equal(doc.analysis_status, 'pending');
  assert.equal(doc.analysis_attempts, 0);
  assert.ok(doc.analysis_next_attempt_at > new Date(Date.now() + 15000), 'Retry-After not honoured');
  assert.equal(requests.length, 1, 'kept calling a busy service');
  assert.equal(Content.docs.find((d) => d.id === 'backlog').analysis_status, 'pending');
  assert.equal(Comment.docs[0].analysis_status, 'pending');
});

test('service outages never fail a post: retried with backoff, no attempt spent, run stops', async () => {
  reset();
  addContent({ id: 'down' });
  addContent({ id: 'waiting', created_at: new Date(Date.now() - 48 * HOUR) });
  serviceBehaviour = () => { throw Object.assign(new Error('down'), { kind: 'unavailable' }); };

  for (let i = 0; i < 8; i += 1) {
    await run('tenant-a');
    Content.docs.forEach((d) => { if (d.analysis_status === 'pending') d.analysis_next_attempt_at = null; }); // skip the backoff wait
  }
  const doc = Content.docs.find((d) => d.id === 'down');
  assert.equal(doc.analysis_status, 'pending', 'an outage marked the post failed');
  assert.equal(doc.analysis_attempts, 0);
  assert.equal(doc.analysis_retries, 8);
  assert.equal(Content.docs.find((d) => d.id === 'waiting').analysis_status, 'pending');
  assert.equal(requests.length, 8, 'kept sending the backlog to a down service within a run');

  serviceBehaviour = null; // service recovers
  await run('tenant-a');
  assert.ok(Content.docs.every((d) => d.analysis_status === 'done'), 'posts were not analysed after recovery');
  assert.equal(doc.analysis_retries, 0);
});

test('outage backoff grows and is capped at 5 minutes', async () => {
  reset();
  addContent({ id: 'down', analysis_retries: 20 });
  serviceBehaviour = () => { throw Object.assign(new Error('down'), { kind: 'unavailable' }); };
  const before = Date.now();
  await run('tenant-a');
  const wait = Content.docs[0].analysis_next_attempt_at - before;
  assert.ok(wait > 4 * 60 * 1000 && wait <= 5 * 60 * 1000 + 1000, `backoff ${wait}ms`);
});

test('a post the service cannot process spends attempts and is failed after the limit', async () => {
  reset();
  addContent({ id: 'bad' });
  serviceBehaviour = () => { throw Object.assign(new Error('Ollama fallback translation is unusable'), { kind: 'item_unusable' }); };

  for (let i = 0; i < 3; i += 1) {
    await run('tenant-a');
    const d = Content.docs[0];
    if (d.analysis_status === 'pending') d.analysis_next_attempt_at = null;
  }
  const doc = Content.docs[0];
  assert.equal(doc.analysis_attempts, 3);
  assert.equal(doc.analysis_status, 'failed');
  await run('tenant-a');
  assert.equal(requests.length, 3, 'failed item was claimed again');
});

test('misconfigured service (401/404/no URL) never fails posts', async () => {
  reset();
  addContent({ id: 'cfg' });
  serviceBehaviour = () => { throw Object.assign(new Error('not configured'), { kind: 'config' }); };
  for (let i = 0; i < 6; i += 1) {
    await run('tenant-a');
    Content.docs[0].analysis_next_attempt_at = null;
  }
  assert.equal(Content.docs[0].analysis_status, 'pending');
  assert.equal(Content.docs[0].analysis_attempts, 0);
});

test('a source=error record (provider outage) retries only that post; its neighbours are stored', async () => {
  reset();
  addContent({ id: 'good', text: 'good post' });
  addContent({ id: 'bad', text: 'bad post' });
  serviceBehaviour = (body) => ({
    results: body.texts.map((t) => (t === 'bad post' ? okResult(t, { source: 'error' }) : okResult(t))),
  });

  await run('tenant-a');

  assert.equal(Content.docs.find((d) => d.id === 'good').analysis_status, 'done');
  const bad = Content.docs.find((d) => d.id === 'bad');
  assert.equal(bad.analysis_status, 'pending');
  assert.equal(bad.analysis_attempts, 0, 'a provider outage spent an attempt');
  assert.equal(bad.analysis_retries, 1);
  assert.equal(Analysis.docs.length, 1);
});

test('a superseded claim cannot write: late results after a re-claim are dropped', async () => {
  reset();
  addContent({ id: 'raced' });
  serviceBehaviour = (body) => {
    // Another worker reaped and re-claimed the item while this request was in flight.
    Content.docs[0].analysis_claim_token = 'someone-else';
    return { results: body.texts.map((t) => okResult(t)) };
  };

  await run('tenant-a');

  assert.equal(Analysis.docs.length, 0, 'stale worker wrote an Analysis');
  assert.equal(Content.docs[0].analysis_claim_token, 'someone-else');
  assert.equal(Content.docs[0].analysis_status, 'processing');
});

test('stalled claims are reaped and analysed', async () => {
  reset();
  addContent({ id: 'stuck', analysis_status: 'processing', analysis_claim_token: 'dead-worker',
    analysis_claimed_at: new Date(Date.now() - 2 * HOUR) });

  await run('tenant-a');

  assert.equal(Content.docs[0].analysis_status, 'done');
});

test('comments are analysed and inherit their post\'s districts', async () => {
  reset();
  Content.insert({ id: 'parent', tenant_id: 'tenant-a', districts: ['Hyderabad'], analysis_status: 'done', created_at: new Date() });
  Comment.insert({ id: 'cm1', tenant_id: 'tenant-a', content_id: 'parent', text: 'this is outrageous',
    created_at: new Date(), analysis_status: 'pending', analysis_attempts: 0 });
  serviceBehaviour = (body) => ({ results: body.texts.map((t) => okResult(t, { risk_score: 80 })) });

  await run('tenant-a');

  const c = Comment.docs[0];
  assert.equal(c.analysis_status, 'done');
  assert.equal(c.sentiment, 'negative');
  assert.equal(c.threat_score, 80);
  assert.equal(c.is_threat, true);
  assert.ok(dispatches.some((d) => d.key === 'tenant-a::Hyderabad'), 'comment did not inherit parent district');
});

test('a second run for the same tenant while one is in progress does not double-process', async () => {
  reset();
  for (let i = 0; i < 5; i += 1) addContent({ id: `p-${i}` });
  let release;
  const gate = new Promise((r) => { release = r; });
  serviceBehaviour = async (body) => { await gate; return { results: body.texts.map((t) => okResult(t)) }; };

  const first = run('tenant-a');
  await new Promise((r) => setImmediate(r));
  const second = await run('tenant-a');
  assert.equal(second, null, 'second run was not locked out');
  release();
  await first;

  assert.equal(requests.length, 5, 'a post was processed twice');
  assert.equal(Analysis.docs.length, 5);
});

test('virality shows the Viral badge but never changes risk level or score', async () => {
  reset();
  Source.insert({ id: 'src-1', tenant_id: 'tenant-a' });
  addContent({ id: 'viral-benign' });
  serviceBehaviour = (body) => ({ results: body.texts.map((t) => okResult(t, { risk_score: 45 })) });
  velocityResult = {
    highestPriority: { priority: 'HIGH', thresholdTriggered: 1000 },
    triggeredMetrics: [{ metric: 'views', value: 50000, priority: 'HIGH' }],
    threshold: { time_window_minutes: 60 },
    postAgeMinutes: 30,
  };

  await run('tenant-a');

  const alert = Alert.docs[0];
  assert.equal(alert.alert_type, 'velocity', 'Viral badge signal missing');
  assert.ok(alert.velocity_data, 'velocity_data missing');
  assert.equal(alert.risk_level, 'medium', 'virality changed the risk level');
  assert.equal(alert.threat_details.risk_score, 45, 'virality raised the risk score');
  const content = Content.docs[0];
  assert.equal(content.risk_level, 'medium');
  assert.equal(content.risk_score, 45);
  assert.equal(Analysis.docs[0].risk_score, 45);
});

test('an unusable post fails on its own; the other posts are stored', async () => {
  reset();
  for (let i = 0; i < 8; i += 1) addContent({ id: `ok-${i}`, text: `ordinary post number ${i}` });
  addContent({ id: 'poison', text: 'poison post that the service cannot translate' });
  serviceBehaviour = (body) => {
    if (body.texts[0].startsWith('poison')) {
      throw Object.assign(new Error('Sentiment service could not process this post: Ollama fallback translation is unusable'),
        { kind: 'item_unusable', status: 503 });
    }
    return { results: body.texts.map((t) => okResult(t)) };
  };

  await run('tenant-a');

  const others = Content.docs.filter((d) => d.id !== 'poison');
  assert.ok(others.every((d) => d.analysis_status === 'done'), 'a healthy neighbour was not analysed');
  const poison = Content.docs.find((d) => d.id === 'poison');
  assert.equal(poison.analysis_status, 'pending');
  assert.equal(poison.analysis_attempts, 1, 'the unusable post should spend an attempt');
  assert.equal(Analysis.docs.length, 8);
  assert.equal(requests.length, 9);
});

test('a fresh post that failed once keeps the routine lane (not demoted behind the backlog)', async () => {
  reset();
  addContent({ id: 'fresh-retry', created_at: new Date(), analysis_attempts: 1 });
  addContent({ id: 'old-backlog', created_at: new Date(Date.now() - 48 * HOUR) });
  await run('tenant-a');
  const lanes = Object.fromEntries(dispatches.map((d, i) => [i, d.priority]));
  const freshReq = requests.findIndex((r) => r.texts.length === 1 && dispatches[requests.indexOf(r)]?.priority === 'routine');
  assert.ok(Object.values(lanes).includes('routine'), 'retried fresh post was not dispatched in the routine lane');
  assert.ok(freshReq >= 0);
  assert.equal(Content.docs.find((d) => d.id === 'fresh-retry').analysis_status, 'done');
});

test('alert rule: every analysed monitored post alerts, Normal / low risk included', async () => {
  reset();
  Source.insert({ id: 'src-1', tenant_id: 'tenant-a' });
  addContent({ id: 'calm', text: 'lovely weather today', author: 'citizen' });
  serviceBehaviour = (body) => ({ results: body.texts.map((t) => okResult(t, { risk_score: 0, category: 'Normal', intent: 'Normal' })) });

  await run('tenant-a');

  assert.equal(Content.docs[0].analysis_status, 'done');
  assert.equal(Alert.docs.length, 1, 'a low-risk post raised no alert');
  assert.equal(Alert.docs[0].risk_level, 'low');
  assert.equal(Alert.docs[0].alert_type, 'ai_risk');
  assert.equal(Alert.docs[0].title, 'LOW Risk: citizen');
});

test('alert rule: a tenant keyword match alerts even at low risk, in soceye\'s format', async () => {
  reset();
  Source.insert({ id: 'src-1', tenant_id: 'tenant-a' });
  tenantKeywords = [{ keyword: 'bandh', districts: [] }];
  addContent({ id: 'kw', text: 'Bandh called for tomorrow', author: 'reporter' });
  serviceBehaviour = (body) => ({ results: body.texts.map((t) => okResult(t, { risk_score: 10, intent: 'Protest call', reasoning: 'r1', summary: 's1', stance: 'Oppose', stance_confidence: 0.7, keyword_context: [{ keyword: 'bandh', contextually_relevant: true }] })) });

  await run('tenant-a');

  const alert = Alert.docs[0];
  assert.equal(alert.alert_type, 'keyword_risk');
  assert.equal(alert.risk_level, 'low');
  assert.equal(alert.title, 'LOW Risk: Protest call - reporter');
  assert.equal(alert.description, '**Analysis:**\n\u2022 r1\n\u2022 Risk Score: 10%\n\u2022 Keyword match: bandh (weight 50)');
  assert.deepEqual(alert.matched_keywords_normalized, ['bandh']);
  // The service receives the matched keyword, the policy pack and the tenant labels.
  assert.deepEqual(requests[0].matched_keywords, [[{ keyword: 'bandh', weight: 50 }]]);
  assert.ok(requests[0].policy_pack.categories.length > 0);
  assert.equal(requests[0].tenant_key, 'police:tenant-a');
  assert.equal(requests[0].tenant_name, 'tenant-a Police');
  assert.equal(Content.docs[0].risk_score, 10, 'keyword changed the score');
  assert.equal(Analysis.docs[0].stance, 'Oppose');
  assert.equal(Analysis.docs[0].keyword_context[0].keyword, 'bandh');
});

test('re-analysis refreshes the one alert and keeps its workflow status', async () => {
  reset();
  Source.insert({ id: 'src-1', tenant_id: 'tenant-a' });
  addContent({ id: 'post' });
  await run('tenant-a');
  Alert.docs[0].status = 'escalated';
  Content.docs[0].analysis_status = 'pending';
  serviceBehaviour = (body) => ({ results: body.texts.map((t) => okResult(t, { risk_score: 90 })) });

  await run('tenant-a');

  assert.equal(Alert.docs.length, 1, 'a second alert was created');
  assert.equal(Alert.docs[0].risk_level, 'high');
  assert.equal(Alert.docs[0].threat_details.risk_score, 90);
  assert.equal(Alert.docs[0].status, 'escalated', 'workflow status was reset');
});

test('scheduler: every active tenant runs at once, not limited by the tenant worker pool', async () => {
  reset();
  activeTenants = ['t1', 't2', 't3', 't4', 't5'].map((id) => ({ id, slug: id }));
  for (const t of activeTenants) addContent({ id: `post-${t.id}`, tenant_id: t.id });
  let release;
  const gate = new Promise((r) => { release = r; });
  const started = new Set();
  serviceBehaviour = async (body) => {
    started.add(body.texts[0]);
    await gate;
    return { results: body.texts.map((t) => okResult(t)) };
  };
  // Every tenant's post must reach the service while all five are still in flight.
  const handle = startScheduler({ intervalMs: 60 * 60 * 1000, startDelayMs: 60 * 60 * 1000 });
  await handle.triggerNow();
  for (let i = 0; i < 50 && requests.length < 5; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(requests.length, 5, `only ${requests.length} of 5 tenants started`);
  assert.deepEqual([...new Set(dispatches.map((d) => d.key.split('::')[0]))].sort(), ['t1', 't2', 't3', 't4', 't5']);

  release();
  for (let i = 0; i < 50 && !Content.docs.every((d) => d.analysis_status === 'done'); i += 1) await new Promise((r) => setImmediate(r));
  handle.stop();
  assert.ok(Content.docs.every((d) => d.analysis_status === 'done'));
  activeTenants = [];
});

test('investigation: a busy/unavailable service is retried; the officer gets the result', async () => {
  reset();
  let calls = 0;
  serviceBehaviour = (body) => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error('down'), { kind: 'unavailable', retryAfterS: 0.01 });
    return { results: body.texts.map((t) => okResult(t, { risk_score: 75 })) };
  };
  const scope = { tenant: { id: 'tenant-a' }, tenantId: 'tenant-a', connection: null };
  const result = await runWithTenant(scope, () => analyzeText('a post to investigate', { tenantId: 'tenant-a', platform: 'x' }));
  assert.equal(calls, 3);
  assert.equal(result.risk_level, 'high');
  assert.equal(dispatches[0].priority, 'live');
});

test('investigation: a post-level failure is not retried and raises an error (no invented verdict)', async () => {
  reset();
  serviceBehaviour = () => { throw Object.assign(new Error('unusable'), { kind: 'item_unusable' }); };
  const scope = { tenant: { id: 'tenant-a' }, tenantId: 'tenant-a', connection: null };
  await assert.rejects(
    runWithTenant(scope, () => analyzeText('a post to investigate', { tenantId: 'tenant-a' })),
    (err) => err.name === 'AnalysisUnavailableError' && err.kind === 'item_unusable',
  );
  assert.equal(requests.length, 1);
});

test('keywords: only the first SENTIMENT_MAX_MATCHED_KEYWORDS are sent; all are shown on the alert', async () => {
  reset();
  Source.insert({ id: 'src-1', tenant_id: 'tenant-a' });
  tenantKeywords = ['bandh', 'riot', 'ganja'].map((keyword) => ({ keyword, districts: [] }));
  addContent({ id: 'kw3', text: 'bandh and riot over ganja seizure' });

  await run('tenant-a');

  assert.equal(requests[0].matched_keywords[0].length, 1, 'more keywords sent than the default cap');
  assert.deepEqual(Alert.docs[0].matched_keywords_normalized.sort(), ['bandh', 'ganja', 'riot']);
});

test('keywords: a source=error answer with keywords is retried at once without them', async () => {
  reset();
  Source.insert({ id: 'src-1', tenant_id: 'tenant-a' });
  tenantKeywords = [{ keyword: 'bandh', districts: [] }];
  addContent({ id: 'kw', text: 'bandh tomorrow' });
  serviceBehaviour = (body) => ({
    results: body.texts.map((t) => (body.matched_keywords
      ? okResult(t, { source: 'error', reasoning: 'unusable response (RuntimeError)' })
      : okResult(t, { risk_score: 45 }))),
  });

  await run('tenant-a');

  assert.equal(requests.length, 2);
  assert.ok(requests[0].matched_keywords && !requests[1].matched_keywords);
  assert.equal(Content.docs[0].analysis_status, 'done');
  assert.equal(Content.docs[0].risk_score, 45);
  assert.deepEqual(Alert.docs[0].matched_keywords_normalized, ['bandh'], 'the match is still shown');
});

// ── Grievances ─────────────────────────────────────────────────────────────

const addGrievance = (over = {}) => Grievance.insert({
  id: `g-${idSeq + 1}`, tenant_id: 'tenant-a', platform: 'x', districts: ['Hyderabad'], is_active: true,
  content: { text: 'no water supply in our colony for five days', full_text: 'no water supply in our colony for five days' },
  created_at: new Date(), analysis_status: 'pending', analysis_attempts: 0, ...over,
});

test('grievances are analysed and stored inline, with no alert', async () => {
  reset();
  addGrievance({ id: 'g1' });
  serviceBehaviour = (body) => ({ results: body.texts.map((t) => okResult(t, { risk_score: 55, category: 'Public_Safety', intent: 'Report water shortage', summary: 'water summary' })) });

  await run('tenant-a');

  const g = Grievance.docs[0];
  assert.equal(g.analysis_status, 'done');
  assert.equal(g['analysis.sentiment'], 'negative');
  assert.equal(g['analysis.risk_score'], 55);
  assert.equal(g['analysis.risk_level'], 'medium');
  assert.equal(g['analysis.urgency'], 'medium', 'urgency must mirror the risk level for existing readers');
  assert.equal(g['analysis.category'], 'Public_Safety');
  assert.equal(g['analysis.summary'], 'water summary');
  assert.equal(g['analysis.analysis_source'], 'sentiment-service');
  assert.equal(Alert.docs.length, 0, 'grievances must not raise alerts');
  assert.equal(Analysis.docs.length, 0, 'grievances store inline, not in the Analysis collection');
  assert.equal(dispatches[0].key, 'tenant-a::Hyderabad', 'grievance not dispatched under its district');
});

// The alerts list, its stats and the dashboard are cached for 20s. socye-2
// clears them the moment an alert is written; without that the alert is
// invisible until the TTL lapses and reads as "the alert never fired".
test('creating or refreshing an alert clears the alert read caches', async () => {
  reset();
  Source.insert({ id: 'src-1', tenant_id: 'tenant-a', category: 'political' });
  addContent({ id: 'c-cache' });

  await run('tenant-a');
  assert.equal(Alert.docs.length, 1, 'the post should have alerted');
  assert.ok(cacheClears >= 1, 'a new alert must invalidate the cached alert list');

  // Re-analysing the same post updates the alert; that must invalidate too.
  const before = cacheClears;
  Content.docs[0].analysis_status = 'pending';
  Content.docs[0].analysis_claim_token = null;
  await run('tenant-a');
  assert.ok(cacheClears > before, 'refreshing an existing alert must invalidate too');
});

const MAPPED_POLICY = {
  legal_sections: [{ id: 'BNS_352', code: '352', title: 'Intentional insult provoking breach of peace' }],
  platform_policies: [{ id: 'ABUSE_HARASSMENT', name: 'Abuse and Harassment' }],
};

// The service returns a category, never a law. Sections and platform rules are
// the Policy Manager's mapping of that category, and grievances show them just
// as content does.
test('a grievance carries the legal sections and platform policies its category maps to', async () => {
  reset();
  mappingOverride = MAPPED_POLICY;
  addGrievance({ id: 'g-complaint' });
  serviceBehaviour = (body) => ({ results: body.texts.map((t) => okResult(t, { risk_score: 20, category: 'Abusive' })) });

  await run('tenant-a');

  const g = Grievance.docs[0];
  assert.equal(g.analysis_status, 'done');
  assert.equal(g['analysis.category'], 'Abusive');
  assert.deepEqual(g['analysis.legal_sections'], MAPPED_POLICY.legal_sections);
  assert.deepEqual(g['analysis.violated_policies'], MAPPED_POLICY.platform_policies);
  // ReasonModal reads these when the top-level fields are absent.
  assert.deepEqual(g['analysis.llm_analysis'].bns_sections_violated, MAPPED_POLICY.legal_sections);
  assert.deepEqual(g['analysis.llm_analysis'].platform_policies_violated, MAPPED_POLICY.platform_policies);
});

test('monitored content keeps its legal sections and platform policies', async () => {
  reset();
  mappingOverride = MAPPED_POLICY;
  Source.insert({ id: 'src-1', tenant_id: 'tenant-a', category: 'political' });
  addContent({ id: 'c-offence' });

  await run('tenant-a');

  const a = Analysis.docs[0];
  assert.deepEqual(a.legal_sections, MAPPED_POLICY.legal_sections, 'content is where an offence IS attributed to the author');
  assert.deepEqual(a.violated_policies, MAPPED_POLICY.platform_policies);
  assert.deepEqual(a.llm_analysis.bns_sections_violated, MAPPED_POLICY.legal_sections);
});

// The whole point of the rewrite: a grievance is mapped exactly as a monitored
// post is. If the content pipeline gains a field, the grievance gets it too —
// this fails if grievance.persist ever goes back to cherry-picking.
test('a grievance stores every field the content pipeline stores', async () => {
  reset();
  mappingOverride = MAPPED_POLICY;
  Source.insert({ id: 'src-1', tenant_id: 'tenant-a', category: 'political' });
  addContent({ id: 'c-parity', text: 'same words in both places' });
  addGrievance({ id: 'g-parity', content: { text: 'same words in both places', full_text: 'same words in both places' } });

  await run('tenant-a');

  const a = Analysis.docs[0];
  const g = Grievance.docs[0];
  const missing = Object.keys(a).filter((k) => (
    !['id', '_id', 'tenant_id', 'content_id', 'districts', 'analyzed_at'].includes(k)
    && !(`analysis.${k}` in g)
  ));
  assert.deepEqual(missing, [], `grievance is missing analysis fields content stores: ${missing.join(', ')}`);

  // Spot-check the ones a subset would most likely have dropped.
  for (const k of ['signals', 'keyword_context', 'stance_confidence', 'thresholds', 'matched_keywords', 'confidence', 'explanation', 'was_translated']) {
    assert.deepEqual(g[`analysis.${k}`], a[k], `analysis.${k} differs from the content pipeline`);
  }
  // ...and the grievance-only aliases the UI reads.
  assert.equal(g['analysis.urgency'], g['analysis.risk_level'], 'urgency mirrors risk level');
  assert.deepEqual(g['analysis.keywords'], g['analysis.highlights']);
});

test('a grievance that only tags the police account is analysed from the post it replies to', async () => {
  reset();
  addGrievance({
    id: 'g-ctx',
    content: { text: '@hydcitypolice @TelanganaCOPs', full_text: '@hydcitypolice @TelanganaCOPs' },
    context: {
      in_reply_to: { content: { text: 'my bike was stolen near the metro station last night' } },
      quoted: { content: { full_text: 'chain snatching again in this colony' } },
      thread_chain: [{ content: { text: 'first' } }, { content: { text: 'second' } }, { content: { text: 'third' } }],
    },
  });

  await run('tenant-a');

  assert.equal(Grievance.docs[0].analysis_status, 'done');
  const sent = requests[0].texts[0];
  assert.ok(sent.startsWith('@hydcitypolice'));
  assert.ok(sent.includes('[REPLYING TO]:\nmy bike was stolen'), 'reply text missing');
  assert.ok(sent.includes('[QUOTED POST]:\nchain snatching'), 'quoted text missing');
  assert.ok(sent.includes('third') && sent.includes('second') && !sent.includes('first'), 'only the last two thread posts belong');
});

test('text-less Facebook grievances are skipped, inactive ones are never claimed', async () => {
  reset();
  addGrievance({ id: 'g-placeholder', platform: 'facebook', content: { text: '[Facebook post without text]', full_text: '[Facebook post without text]' } });
  addGrievance({ id: 'g-inactive', is_active: false });
  addGrievance({ id: 'g-real', platform: 'facebook', content: { text: 'garbage not collected for two weeks', full_text: 'garbage not collected for two weeks' } });

  await run('tenant-a');

  const byId = (id) => Grievance.docs.find((d) => d.id === id);
  assert.equal(byId('g-placeholder').analysis_status, 'skipped');
  assert.equal(byId('g-inactive').analysis_status, 'pending', 'an inactive grievance was claimed');
  assert.equal(byId('g-real').analysis_status, 'done');
  assert.equal(requests.length, 1);
});
