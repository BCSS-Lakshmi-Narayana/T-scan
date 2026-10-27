const Grievance = require('../models/Grievance');
const Alert = require('../models/Alert');
const CampaignSuggestion = require('../models/CampaignSuggestion');

const axios = require('axios');

const SAGA_TYPE = 'police';

// ── LLM helper ───────────────────────────────────────────────────────────────
// Priority: Ollama (PRIMARY_LLM_PROVIDER=ollama) → OpenAI → Gemini.
// If none is configured throws a 503-safe error — never crashes startup.
async function callLLM(systemPrompt, userPrompt) {
  const provider = process.env.PRIMARY_LLM_PROVIDER || 'ollama';

  if (provider === 'ollama') {
    const baseURL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    const model = process.env.OLLAMA_MODEL || 'llama3.1:latest';
    const timeout = parseInt(process.env.OLLAMA_TIMEOUT_MS || '300000', 10);
    const res = await axios.post(`${baseURL}/api/chat`, {
      model,
      stream: false,
      options: { temperature: 0.4 },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }, { timeout });
    return res.data?.message?.content || '';
  }

  if (process.env.OPENAI_API_KEY) {
    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
      temperature: 0.4,
      max_tokens: 1600,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
    return res.choices?.[0]?.message?.content || '';
  }

  if (process.env.GEMINI_API_KEY) {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-flash-latest' });
    const result = await model.generateContent(`${systemPrompt}\n\n${userPrompt}`);
    return result.response.text();
  }

  const err = new Error('AI not configured — set PRIMARY_LLM_PROVIDER=ollama or OPENAI_API_KEY or GEMINI_API_KEY');
  err.code = 'AI_NOT_CONFIGURED';
  throw err;
}

// Defensive JSON extraction (handles code fences / surrounding prose).
function extractSuggestions(raw) {
  if (!raw) return [];
  let text = String(raw).trim().replace(/```json|```/gi, '').trim();
  // Prefer an object with a `suggestions` array; else a bare array.
  const objMatch = text.match(/\{[\s\S]*\}/);
  const arrMatch = text.match(/\[[\s\S]*\]/);
  for (const candidate of [objMatch && objMatch[0], arrMatch && arrMatch[0]]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed.suggestions)) return parsed.suggestions;
    } catch (_) { /* try next */ }
  }
  return [];
}

const tally = (arr) => {
  const m = new Map();
  arr.filter(Boolean).forEach((k) => m.set(k, (m.get(k) || 0) + 1));
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

const clampScore = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
const PRIORITIES = ['low', 'medium', 'high', 'critical'];

/**
 * Generate ranked campaign suggestions from THIS tenant's recent grievances + alerts.
 * Everything is filtered by tenant_id (strict isolation).
 */
async function generateForTenant(tenantId, { days = 7 } = {}) {
  if (!tenantId) throw new Error('tenantId is required');
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [grievances, alerts] = await Promise.all([
    Grievance.find({ tenant_id: tenantId, created_at: { $gte: cutoff }, is_active: true })
      .select('content.text analysis.sentiment analysis.category analysis.grievance_type analysis.risk_level platform priority created_at')
      .sort({ created_at: -1 }).limit(300).lean(),
    Alert.find({ tenant_id: tenantId, created_at: { $gte: cutoff } })
      .select('title complaint_text priority alert_type threat_details.intent platform created_at')
      .sort({ created_at: -1 }).limit(200).lean(),
  ]);

  if (!grievances.length && !alerts.length) {
    // Nothing to analyse — clear stale "new" suggestions and return empty.
    await CampaignSuggestion.deleteMany({ tenant_id: tenantId, status: 'new' });
    return [];
  }

  // Compact, privacy-light signal for the LLM.
  const topics = tally([
    ...grievances.map((g) => g.analysis?.category || g.analysis?.grievance_type).filter(Boolean),
    ...alerts.map((a) => a.threat_details?.intent || a.alert_type).filter(Boolean),
  ]).slice(0, 12);
  const sentiments = tally(grievances.map((g) => g.analysis?.sentiment).filter(Boolean));
  const platforms = tally([
    ...grievances.map((g) => g.platform).filter(Boolean),
    ...alerts.map((a) => a.platform).filter(Boolean),
  ]).slice(0, 6).map(([p]) => p);
  const samples = [
    ...grievances.map((g) => g.content?.text),
    ...alerts.map((a) => a.complaint_text || a.title),
  ].filter(Boolean).slice(0, 40).map((t) => String(t).replace(/\s+/g, ' ').slice(0, 200));

  const systemPrompt =
`You are an analyst for a public-affairs awareness team. From aggregated social-media grievances and alerts, identify emerging ISSUES/TRENDS that warrant an awareness campaign.
For each, decide intent: "counter" (defuse a negative/critical trend, correct misinformation, address complaints) or "amplify" (boost a positive achievement/scheme/appreciation).
Prioritise by impact (how widespread/important) and urgency (how fast it is rising / how time-sensitive).
Return ONLY JSON: {"suggestions":[{"title","summary","sentiment":"positive|negative|neutral|mixed","intent":"amplify|counter","impact_score":0-100,"urgency_score":0-100,"priority":"low|medium|high|critical","suggested_message","suggested_news":["..."],"target_platforms":["Instagram","X",...],"recommended_niche","rationale"}]}.
Produce 3 to 6 distinct, non-overlapping suggestions, highest priority first. Base everything ONLY on the provided data; do not invent facts.`;

  const userPrompt = JSON.stringify({
    window_days: days,
    counts: { grievances: grievances.length, alerts: alerts.length },
    top_topics: topics.map(([t, n]) => ({ topic: t, count: n })),
    sentiment_split: Object.fromEntries(sentiments),
    active_platforms: platforms,
    sample_texts: samples,
  });

  const raw = await callLLM(systemPrompt, userPrompt);
  const parsed = extractSuggestions(raw);

  const topTopicNames = topics.slice(0, 6).map(([t]) => t);
  const evidence = {
    grievance_count: grievances.length,
    alert_count: alerts.length,
    top_topics: topTopicNames,
    sample_texts: samples.slice(0, 5),
  };

  const docs = parsed.slice(0, 8).map((s) => ({
    tenant_id: tenantId,
    type: SAGA_TYPE,
    title: String(s.title || 'Awareness campaign').slice(0, 200),
    summary: String(s.summary || '').slice(0, 1500),
    sentiment: ['positive', 'negative', 'neutral', 'mixed'].includes(s.sentiment) ? s.sentiment : 'mixed',
    intent: s.intent === 'counter' ? 'counter' : 'amplify',
    impact_score: clampScore(s.impact_score),
    urgency_score: clampScore(s.urgency_score),
    priority: PRIORITIES.includes(s.priority) ? s.priority : 'medium',
    suggested_message: String(s.suggested_message || '').slice(0, 2000),
    suggested_news: Array.isArray(s.suggested_news) ? s.suggested_news.map((x) => String(x).slice(0, 300)).slice(0, 6) : [],
    target_platforms: Array.isArray(s.target_platforms) ? s.target_platforms.map((x) => String(x)).slice(0, 8) : platforms,
    recommended_niche: String(s.recommended_niche || '').slice(0, 120),
    rationale: String(s.rationale || '').slice(0, 1000),
    evidence,
    status: 'new',
    generated_at: new Date(),
  }));

  // Replace this tenant's existing "new" suggestions; never touch dismissed/converted.
  await CampaignSuggestion.deleteMany({ tenant_id: tenantId, status: 'new' });
  if (docs.length) await CampaignSuggestion.insertMany(docs);

  return CampaignSuggestion.find({ tenant_id: tenantId, status: 'new' })
    .sort({ impact_score: -1, urgency_score: -1 }).lean();
}

module.exports = { generateForTenant };
