/**
 * Sentiment integration — unit tests (no database, no service, no network).
 *
 *   node --test src/services/sentiment/sentiment.unit.test.js
 *
 * Covers the wire contract, per-tenant policy packs, keyword scoping, policy
 * mapping, result mapping, and the shared dispatcher.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const stub = (rel, exports) => {
  const id = require.resolve(path.join(__dirname, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

// Per-tenant policy mappings, as mappingService.byTenant holds them.
const MAPPINGS = {
  'tenant-a': [
    { category_id: 'Hate_Speech', definition: 'A hate', severity_level: 'High', keywords: ['scum'], districts: [], country: 'IN',
      legal_sections: [{ code: '196', title: 'Promoting enmity' }], platform_policies: { x: [{ id: 'HATE', name: 'Hateful Conduct' }] } },
    { category_id: 'Local_Rule', definition: 'Only Hyderabad', severity_level: 'Low', keywords: ['sand mining'], districts: ['Hyderabad'], country: 'IN',
      legal_sections: [{ code: '303', title: 'Theft' }], platform_policies: {} },
  ],
  'tenant-b': [
    { category_id: 'Fraud', definition: 'B fraud', severity_level: 'Medium', keywords: [], districts: [], country: 'IN',
      legal_sections: [], platform_policies: {} },
  ],
};

// The real mappingService, with its database edges stubbed and its timers unref'd.
stub('../../models/PolicyMapping.js', { find: async () => [] });
stub('../../models/Tenant.js', { find: () => ({ select: () => ({ lean: async () => [] }) }) });
stub('../../config/tenantConnections.js', { isPerTenant: () => true });
stub('../../config/tenantContext.js', { forEachTenant: async () => [] });
const realSetInterval = global.setInterval;
global.setInterval = (...args) => realSetInterval(...args).unref();
const mappingService = require('../mappingService');
global.setInterval = realSetInterval;

const contract = require('./sentiment.contract');
const { buildPolicyPack, districtSignature } = require('./sentiment.policyPack');
const { matchKeywords } = require('./sentiment.keywords');
const { mapResult } = require('./sentiment.mapper');
const { createDispatcher } = require('./sentiment.dispatcher');
const { stripUrls } = require('./sentiment.analyzer');
const { toServiceError } = require('./sentiment.http');

test.before(async () => {
  await new Promise((r) => setTimeout(r, 20)); // let the startup load settle before seeding
  mappingService.byTenant = new Map(Object.entries(MAPPINGS));
});

const serviceItem = (over = {}, intel = {}) => ({
  post_text: 'x', language: 'te', english_text: 'hello', was_translated: true,
  sentiment: 'Negative', confidence: 0.91, ...over,
  intelligence: {
    category: 'Hate_Speech', intent: 'insult a group', risk_score: 30,
    reasoning: 'because', summary: 'short', recommended_action: 'Monitor', evidence_confidence: 'high',
    signals: ['code_mixed'], source: 'provider', model: 'qwen', ...intel,
  },
});

const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((r) => setImmediate(r));

// ── Contract ───────────────────────────────────────────────────────────────

test('contract: one post per request with the pack and intent mode; no keywords sent', () => {
  const pack = { name: 'p', unknown_label: 'Normal', categories: [] };
  const body = contract.buildRequest({ text: '  hello  ', policyPack: pack, timeoutS: 175 });
  assert.deepEqual(body, { texts: ['hello'], policy_pack: pack, intent_mode: 'free', timeout_s: 175 });
});

test('contract: matched keywords, tenant key and tenant name are sent when present', () => {
  const body = contract.buildRequest({
    text: 'bandh tomorrow',
    policyPack: { categories: [] },
    matchedKeywords: [{ keyword: 'bandh', weight: 50 }, { keyword: 'riot', weight: 250 }],
    tenantKey: 'police:t-1',
    tenantName: 'T-SCAN Police',
  });
  assert.deepEqual(body.matched_keywords, [[{ keyword: 'bandh', weight: 50 }, { keyword: 'riot', weight: 100 }]]);
  assert.equal(body.tenant_key, 'police:t-1');
  assert.equal(body.tenant_name, 'T-SCAN  Police', 'control characters would be rejected by the service');
  assert.ok(!('matched_keywords' in contract.buildRequest({ text: 'x', policyPack: {}, matchedKeywords: [] })));
  assert.equal(contract.buildRequest({ text: 'x', policyPack: {}, tenantName: 'n'.repeat(500) }).tenant_name.length, 200);
});

test('contract: stance and stance_confidence are read, invalid values fall back to Unclear/0', () => {
  const r = contract.normalizeItem(serviceItem({}, { stance: 'Oppose', stance_confidence: 0.82, keyword_context: [{ keyword: 'bandh' }] }));
  assert.equal(r.value.stance, 'Oppose');
  assert.equal(r.value.stance_confidence, 0.82);
  assert.equal(r.value.keyword_context.length, 1);
  const bad = contract.normalizeItem(serviceItem({}, { stance: 'Angry', stance_confidence: 'NaN' }));
  assert.equal(bad.value.stance, 'Unclear');
  assert.equal(bad.value.stance_confidence, 0);
});

test('contract: long text keeps the head and is marked truncated', () => {
  const [clipped] = contract.buildRequest({ text: `START ${'x'.repeat(20000)}`, policyPack: {} }).texts;
  const marker = '\n[...content truncated for analysis]';
  assert.ok(clipped.startsWith('START'));
  assert.ok(clipped.endsWith(marker));
  assert.equal(clipped.length, 4500 + marker.length);
});

test('contract: a source=error record or a missing intelligence block is a failure, never a verdict', () => {
  assert.equal(contract.normalizeItem(serviceItem({}, { source: 'error', risk_score: 0 })).ok, false);
  assert.equal(contract.normalizeItem({ sentiment: 'Negative' }).ok, false);
});

test('contract: sentiment lowercased (unknown -> neutral), risk clamped, category defaults to Normal', () => {
  const r = contract.normalizeItem(serviceItem({}, { risk_score: 140 }));
  assert.equal(r.value.sentiment, 'negative');
  assert.equal(r.value.risk_score, 100);
  assert.equal(r.value.sentiment_confidence, 0.91);
  const odd = contract.normalizeItem(serviceItem({ sentiment: 'Angry' }, { category: '', intent: '', risk_score: -3 }));
  assert.equal(odd.value.sentiment, 'neutral');
  assert.equal(odd.value.risk_score, 0);
  assert.equal(odd.value.category, 'Normal');
  assert.equal(odd.value.intent, 'Normal');
});

// ── Policy pack: tenant isolation ──────────────────────────────────────────

test('policy pack: contains only the requesting tenant\'s categories, with keywords', () => {
  const a = buildPolicyPack('tenant-a').categories;
  const b = buildPolicyPack('tenant-b').categories.map((c) => c.id);
  assert.ok(a.some((c) => c.id === 'Hate_Speech' && c.keywords.includes('scum')));
  assert.ok(!a.some((c) => c.id === 'Fraud'));
  assert.ok(b.includes('Fraud') && !b.includes('Hate_Speech'));
});

test('policy pack: district policies apply only to their own district', () => {
  const hyd = buildPolicyPack('tenant-a', ['Hyderabad']).categories.map((c) => c.id);
  const other = buildPolicyPack('tenant-a', ['Warangal']).categories.map((c) => c.id);
  const noDistrict = buildPolicyPack('tenant-a').categories.map((c) => c.id);
  assert.ok(hyd.includes('Local_Rule'));
  assert.ok(!other.includes('Local_Rule'));
  // Event/search content has no district: tenant-wide policies only.
  assert.ok(!noDistrict.includes('Local_Rule'), 'a district policy was offered for district-less content');
  assert.ok(noDistrict.includes('Hate_Speech'));
});

test('policy pack: Normal is always last; a tenant with no mappings gets a Normal-only pack', () => {
  const a = buildPolicyPack('tenant-a').categories;
  assert.equal(a[a.length - 1].id, 'Normal');
  const empty = buildPolicyPack('tenant-without-mappings');
  assert.deepEqual(empty.categories.map((c) => c.id), ['Normal']);
  assert.equal(empty.unknown_label, 'Normal');
});

test('policy pack: district signature is order-independent', () => {
  assert.equal(districtSignature(['B', 'A']), districtSignature(['A', 'B']));
  assert.equal(districtSignature([]), '_tenant');
});

// ── Keywords ───────────────────────────────────────────────────────────────

test('keywords: substring match at weight 50; district keywords only match their own district', () => {
  const keywords = [
    { keyword: 'Rally', weight: 90, districts: ['Hyderabad'] },
    { keyword: 'bandh', districts: [] },
  ];
  const text = 'RALLY and bandh tomorrow';
  const hyd = matchKeywords(text, keywords, ['Hyderabad']);
  assert.deepEqual(hyd.map((k) => k.keyword).sort(), ['Rally', 'bandh']);
  assert.ok(hyd.every((k) => k.weight === 50 && k.category === 'other'));
  assert.deepEqual(matchKeywords(text, keywords, ['Warangal']).map((k) => k.keyword), ['bandh']);
});

test('keywords: whole words and phrases only, in any script', () => {
  const kw = (k) => [{ keyword: k, districts: [] }];
  assert.equal(matchKeywords('new mobile launch', kw('mob')).length, 0);
  assert.equal(matchKeywords('whatever you say', kw('hate')).length, 0);
  assert.equal(matchKeywords('a MOB gathered, #riot', kw('mob')).length, 1);
  assert.equal(matchKeywords('they want to kill them all', kw('kill them')).length, 1);
  assert.equal(matchKeywords('బంద్ పిలుపు', kw('బంద్')).length, 1);
  assert.equal(matchKeywords('హింసాత్మక ఘటన', kw('హింస')).length, 0, 'matched inside a Telugu word');
});

// ── Mapping (category normalisation + inference) ───────────────────────────

test('mapping: service category labels are normalised to the tenant\'s category_id', () => {
  const r = mappingService.resolveForAnalysis({ category: 'hate speech', text: '', platform: 'x', tenantId: 'tenant-a' });
  assert.equal(r.category_id, 'Hate_Speech');
  assert.equal(r.legal_sections[0].section, '196');
  assert.equal(r.platform_policies[0].policy_name, 'Hateful Conduct');
});

test('mapping: Normal/Unknown falls back to the category inferred from policy keywords, district-scoped', () => {
  const text = 'illegal sand mining every night';
  assert.equal(mappingService.resolveForAnalysis({ category: 'Normal', text, tenantId: 'tenant-a', districts: ['Hyderabad'] }).category_id, 'Local_Rule');
  assert.notEqual(mappingService.resolveForAnalysis({ category: 'Unknown', text, tenantId: 'tenant-a', districts: ['Warangal'] }).category_id, 'Local_Rule');
  // Keywords match whole words: 'sand mining' inside another word does not infer a category.
  assert.equal(mappingService.resolveForAnalysis({ category: 'Normal', text: 'quicksand miningcorp', tenantId: 'tenant-a', districts: ['Hyderabad'] }).category_id, 'Normal');
  assert.equal(mappingService.resolveForAnalysis({ category: 'Normal', text: 'what a scummy day', tenantId: 'tenant-a' }).category_id, 'Normal');
  // A real category from the service is never overridden by keywords.
  assert.equal(mappingService.resolveForAnalysis({ category: 'Hate_Speech', text, tenantId: 'tenant-a', districts: ['Hyderabad'] }).category_id, 'Hate_Speech');
});

// ── Mapper ─────────────────────────────────────────────────────────────────

test('mapper: keywords are shown and explained but never change the risk score or level', () => {
  const v = contract.normalizeItem(serviceItem({}, { risk_score: 20 })).value;
  const matched = [{ keyword: 'kill', weight: 50, category: 'other' }];
  const m = mapResult(v, { tenantId: 'tenant-a', text: 'I will kill him', matched, settings: { high_risk_threshold: 70, medium_risk_threshold: 40 } });
  assert.equal(m.risk_score, 20);
  assert.equal(m.risk_level, 'low');
  assert.equal(m.contentFields.risk_score, 20);
  assert.deepEqual(m.highlights, ['kill']);
  // socye-2's evidence list: why it scored, then what it breaches.
  assert.deepEqual(m.reasons, [
    'because',
    'Risk Score: 20%',
    'Policy: Hateful Conduct',
    'Legal: BNS 2023 196',
    'Keyword match: kill (weight 50)',
  ]);
  assert.equal(m.contentFields.risk_factors[0].keyword, 'kill');
});

test('mapper: risk level follows the supplied district thresholds', () => {
  const v = contract.normalizeItem(serviceItem({}, { risk_score: 55 })).value;
  assert.equal(mapResult(v, { tenantId: 'tenant-a', settings: { high_risk_threshold: 70, medium_risk_threshold: 40 } }).risk_level, 'medium');
  assert.equal(mapResult(v, { tenantId: 'tenant-a', settings: { high_risk_threshold: 50, medium_risk_threshold: 20 } }).risk_level, 'high');
});

test('mapper: legal sections and the post\'s own platform policies come from the tenant\'s mapping', () => {
  const v = contract.normalizeItem(serviceItem()).value;
  const onX = mapResult(v, { tenantId: 'tenant-a', text: 'you scum', platform: 'x' });
  assert.equal(onX.legal_sections[0].section, '196');
  assert.equal(onX.violated_policies[0].policy_name, 'Hateful Conduct');
  assert.deepEqual(onX.analysisFields.policy_triggered_keywords, ['scum']);
  // The same content breaches the same rules wherever it is posted, so a
  // YouTube post still carries X's policy — that is what lets ReasonModal fill
  // its X / YouTube / Meta groups instead of leaving two of them empty.
  const onYouTube = mapResult(v, { tenantId: 'tenant-a', text: 'you scum', platform: 'youtube' });
  assert.equal(onYouTube.violated_policies.length, 1, 'policies are resolved for every platform');
  assert.equal(onYouTube.violated_policies[0].platform, 'x', 'and stay tagged with the platform they belong to');

  // Tenant isolation survives the widening: another tenant's mapping is untouched.
  assert.equal(mapResult(v, { tenantId: 'tenant-b', text: 'you scum' }).legal_sections.length, 0);
  assert.equal(mapResult(v, { tenantId: 'tenant-b', text: 'you scum' }).violated_policies.length, 0);
});

test('mapper: stores soceye\'s analysis fields and the llm_analysis shape the alert popup reads', () => {
  const m = mapResult(contract.normalizeItem(serviceItem()).value, { tenantId: 'tenant-a', platform: 'x' });
  // socye-2's llm_analysis shape, which ReasonModal reads.
  assert.deepEqual(Object.keys(m.llm_analysis).sort(),
    ['bns_sections_violated', 'category', 'evidence_confidence', 'intent', 'platform_policies_violated',
      'reasoning', 'recommended_action', 'score', 'sentiment', 'signals', 'summary'].sort());
  for (const k of ['sentiment_confidence', 'recommended_action', 'signals', 'matched_keywords', 'language', 'english_text', 'was_translated', 'model', 'thresholds']) {
    assert.ok(k in m.analysisFields, `analysisFields.${k} missing`);
  }
  assert.ok('evidence_confidence' in m.analysisFields, 'socye-2 stores evidence_confidence');
  for (const k of ['intent_label', 'translation_backend', 'low_confidence', 'review_recommended']) {
    assert.ok(!(k in m.analysisFields), `analysisFields.${k} should not be stored`);
  }
});

// ── Dispatcher ─────────────────────────────────────────────────────────────

test('dispatcher: never exceeds max concurrency', async () => {
  const d = createDispatcher({ maxConcurrency: 2, maxQueue: 100 });
  let inFlight = 0; let peak = 0;
  const jobs = Array.from({ length: 8 }, () => d.run(async () => {
    inFlight += 1; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
  }, { key: 't::a' }));
  await Promise.all(jobs);
  assert.equal(peak, 2);
});

test('dispatcher: live beats routine beats bulk once a slot frees', async () => {
  const d = createDispatcher({ maxConcurrency: 1, maxQueue: 100 });
  const gate = deferred();
  const order = [];
  const blocker = d.run(() => gate.promise, { key: 'x' });
  const bulk = d.run(async () => order.push('bulk'), { key: 'b', priority: 'bulk' });
  const routine = d.run(async () => order.push('routine'), { key: 'r', priority: 'routine' });
  const live = d.run(async () => order.push('live'), { key: 'l', priority: 'live' });
  gate.resolve();
  await Promise.all([blocker, bulk, routine, live]);
  assert.deepEqual(order, ['live', 'routine', 'bulk']);
});

test('dispatcher: buckets are served round-robin, so a big backlog cannot starve a small one', async () => {
  const d = createDispatcher({ maxConcurrency: 1, maxQueue: 100 });
  const gate = deferred();
  const order = [];
  const blocker = d.run(() => gate.promise, { key: 'x' });
  const jobs = [];
  for (let i = 0; i < 5; i += 1) jobs.push(d.run(async () => order.push('tenantA'), { key: 'tenant-a::_tenant' }));
  jobs.push(d.run(async () => order.push('tenantB'), { key: 'tenant-b::_tenant' }));
  gate.resolve();
  await Promise.all([blocker, ...jobs]);
  assert.ok(order.indexOf('tenantB') <= 1, `tenant B waited behind A's backlog: ${order.join(',')}`);
});

test('dispatcher: a full queue rejects fast as backpressure', async () => {
  const d = createDispatcher({ maxConcurrency: 1, maxQueue: 10 });
  const gate = deferred();
  const blocker = d.run(() => gate.promise);
  const queued = Array.from({ length: 10 }, () => d.run(async () => {}));
  await assert.rejects(d.run(async () => {}), (err) => err.code === 'SENTIMENT_QUEUE_FULL' && err.kind === 'backpressure');
  gate.resolve();
  await Promise.all([blocker, ...queued]);
});

test('dispatcher: a 429 pauses all dispatch until Retry-After passes', async (t) => {
  // The hold timer is unref'd (it must never keep a server alive); keep this test's loop alive.
  const keepAlive = setInterval(() => {}, 50);
  t.after(() => clearInterval(keepAlive));
  const d = createDispatcher({ maxConcurrency: 1, maxQueue: 100 });
  const busy = Object.assign(new Error('busy'), { kind: 'backpressure', retryAfterS: 0.15 });
  await assert.rejects(d.run(async () => { throw busy; }));
  assert.equal(d.stats().paused, true);

  const startedAt = Date.now();
  let ranAt = 0;
  await d.run(async () => { ranAt = Date.now(); });
  assert.ok(ranAt - startedAt >= 100, `ran after ${ranAt - startedAt}ms, before the hold elapsed`);
});

test('dispatcher: repeated outages open a cooldown', async () => {
  const d = createDispatcher({ maxConcurrency: 1, maxQueue: 100, failureThreshold: 3, cooldownMs: 1000 });
  const down = () => Object.assign(new Error('down'), { kind: 'unavailable' });
  for (let i = 0; i < 3; i += 1) await assert.rejects(d.run(async () => { throw down(); }));
  assert.equal(d.stats().paused, true);
  let ran = false;
  d.run(async () => { ran = true; });
  await tick();
  assert.equal(ran, false, 'dispatched during cooldown');
});

// ── Service error classification ───────────────────────────────────────────

const axiosError = (status, detail, headers = {}) => ({ message: 'Request failed', response: { status, data: { detail }, headers } });

test('http: a per-post 503 is item_unusable, not an outage', () => {
  for (const detail of ['Ollama fallback translation is unusable', 'Ollama fallback sentiment is invalid',
    'Ollama fallback output was not verified as English', 'Ollama pipeline fallback failed: ReadTimeout',
    'vLLM fallback translation is unusable', 'vLLM fallback confidence is invalid',
    'vLLM fallback output was not verified as English', 'vLLM pipeline fallback failed: ReadTimeout']) {
    assert.equal(toServiceError(axiosError(503, detail)).kind, 'item_unusable', detail);
  }
});

test('http: real outages and capacity 503s keep their meaning', () => {
  assert.equal(toServiceError(axiosError(503, 'inference lock unavailable after 600s')).kind, 'unavailable');
  assert.equal(toServiceError(axiosError(503, 'Ollama circuit open — retry after 30s', { 'retry-after': '30' })).retryAfterS, 30);
  assert.equal(toServiceError(axiosError(503, 'Ollama fallback queue is at capacity')).kind, 'backpressure');
  assert.equal(toServiceError(axiosError(503, 'vLLM fallback queue is at capacity')).kind, 'backpressure');
  assert.equal(toServiceError(axiosError(503, 'LLM circuit is open', { 'retry-after': '30' })).kind, 'unavailable');
  assert.equal(toServiceError(axiosError(429, 'LLM gate is full')).kind, 'backpressure');
  assert.equal(toServiceError(axiosError(429, 'Ollama gate full')).kind, 'backpressure');
});

test('http: wrong URL or API key is a config error, not a post failure', () => {
  for (const status of [401, 403, 404]) assert.equal(toServiceError(axiosError(status, 'nope')).kind, 'config', String(status));
  assert.equal(toServiceError(axiosError(422, 'text too long')).kind, 'rejected');
});

test('dispatcher: an item-level failure does not pause other tenants', async () => {
  const d = createDispatcher({ maxConcurrency: 1, maxQueue: 100 });
  const bad = Object.assign(new Error('one post unusable'), { kind: 'item_unusable' });
  await assert.rejects(d.run(async () => { throw bad; }));
  assert.equal(d.stats().paused, false);
});


// ── Link-heavy posts ───────────────────────────────────────────────────────

test('links are dropped before analysis, so the complaint is what gets sent', () => {
  const post = 'https://www.facebook.com/share/v/1MRr7zB7BH/ https://www.instagram.com/x?igsi=abc '
    + 'Sir please act, they are threatening us daily www.example.com/evidence';
  const stripped = stripUrls(post);
  assert.equal(stripped, 'Sir please act, they are threatening us daily');
  assert.ok(!/https?:|www\./.test(stripped));
});

test('a post that is only links has nothing to analyse', () => {
  assert.equal(stripUrls('https://t.co/abc https://t.co/def'), '');
  assert.equal(stripUrls('  '), '');
});

test('ordinary text and non-Latin scripts are untouched', () => {
  assert.equal(stripUrls('no water supply for five days'), 'no water supply for five days');
  assert.equal(stripUrls('\u0c2c\u0c02\u0c26\u0c4d \u0c2a\u0c3f\u0c32\u0c41\u0c2a\u0c41'), '\u0c2c\u0c02\u0c26\u0c4d \u0c2a\u0c3f\u0c32\u0c41\u0c2a\u0c41');
});


// ── Parity with soceye's flattenResult: every field it reads off a service
// record must survive police's normalizeItem too, or the mapping silently
// loses data the service is required to return.
test('normalizeItem keeps the fields soceye reads (evidence_confidence, intent_label, transliteration, source)', () => {
  const norm = contract.normalizeItem({
    sentiment: 'Negative', confidence: 0.91, language: 'te', english_text: 'translated',
    was_translated: true, was_transliterated: true,
    intelligence: {
      category: 'Abusive', intent: 'criticise', intent_label: 'Opinion', risk_score: 20,
      reasoning: 'r', summary: 's', recommended_action: 'Monitor',
      evidence_confidence: 'HIGH', stance: 'Oppose', stance_confidence: 0.7,
      signals: [], keyword_context: [], source: 'provider', model: 'qwen',
    },
  });
  assert.equal(norm.ok, true);
  assert.equal(norm.value.evidence_confidence, 'high', 'evidence_confidence is required by the service schema');
  assert.equal(norm.value.intent_label, 'Opinion');
  assert.equal(norm.value.was_transliterated, true);
  assert.equal(norm.value.source, 'provider');
});

test('evidence_confidence falls back to low when the model omits or mangles it', () => {
  const mk = (over) => contract.normalizeItem({
    sentiment: 'Neutral',
    intelligence: { category: 'Normal', risk_score: 0, source: 'provider', ...over },
  }).value;
  assert.equal(mk({}).evidence_confidence, 'low', 'a missing value must not become undefined');
  assert.equal(mk({ evidence_confidence: 'wildly-confident' }).evidence_confidence, 'low');
  assert.equal(mk({ evidence_confidence: 'Medium' }).evidence_confidence, 'medium');
});

test('mapResult persists provenance the way soceye does', () => {
  const value = contract.normalizeItem({
    sentiment: 'Negative',
    intelligence: {
      category: 'Normal', risk_score: 10, source: 'provider', model: 'qwen',
      evidence_confidence: 'medium', intent_label: 'Opinion',
    },
  }).value;
  const mapped = mapResult(value, { tenantId: 'tenant-a', districts: [], text: 'some text', platform: 'x' });
  assert.equal(mapped.analysisFields.source, 'provider', 'which provider answered');
  assert.equal(mapped.analysisFields.analyzed_via, 'analyze/intelligence', 'which endpoint produced it');
  assert.equal(mapped.analysisFields.analysis_source, 'sentiment-service');
  assert.equal(mapped.analysisFields.evidence_confidence, 'medium', 'socye-2 persists it');
  assert.ok(!('intent_label' in mapped.analysisFields), 'socye-2 does not persist intent_label');
});
