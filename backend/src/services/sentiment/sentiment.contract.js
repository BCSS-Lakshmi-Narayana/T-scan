/**
 * Wire contract with the sentiment service (social_media_sentiment_analysis, multitenancy).
 *
 * buildRequest  — one post -> POST /analyze/intelligence body
 * normalizeItem — one response record -> flat result, or a failure reason
 *
 * Only this file knows the service's field names.
 */

const SENTIMENTS = ['positive', 'neutral', 'negative'];
const STANCES = ['Support', 'Oppose', 'Neutral', 'Unclear'];
// The service's schema requires evidence_confidence on every record.
const EVIDENCE = ['high', 'medium', 'low'];
const MAX_LABEL_CHARS = 200; // service limit for tenant_name / tenant_key

const maxTextChars = () => Math.max(800, Number(process.env.SENTIMENT_MAX_TEXT_CHARS) || 4500);

const intentMode = () =>
  String(process.env.SENTIMENT_INTENT_MODE || 'free').toLowerCase() === 'enum' ? 'enum' : 'free';

const truncateText = (text) => {
  const trimmed = String(text || '').trim();
  if (trimmed.length <= maxTextChars()) return trimmed;
  return `${trimmed.slice(0, maxTextChars())}\n[...content truncated for analysis]`;
};

// The service rejects (422) labels with control characters or over the length limit.
const cleanLabel = (value) => {
  // eslint-disable-next-line no-control-regex
  const v = String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, MAX_LABEL_CHARS);
  return v || null;
};

/**
 * @param {object} args
 * @param {string} args.text
 * @param {object} args.policyPack               tenant/district categories with definitions and keywords
 * @param {Array<{keyword: string, weight: number}>} [args.matchedKeywords] tenant keywords found in the text
 * @param {string} [args.tenantKey]              stable per-tenant key for the service's fair LLM queue
 * @param {string} [args.tenantName]             tenant display name (prompt context only)
 * @param {number} [args.timeoutS]               per-request LLM timeout on the service side
 */
const buildRequest = ({ text, policyPack, matchedKeywords = [], tenantKey = null, tenantName = null, timeoutS = null }) => {
  const body = {
    texts: [truncateText(text)],
    policy_pack: policyPack,
    intent_mode: intentMode(),
  };
  // The model judges each matched keyword in context (keyword_context); a match alone is not risk.
  if (Array.isArray(matchedKeywords) && matchedKeywords.length) {
    body.matched_keywords = [matchedKeywords.map((m) => ({
      keyword: String(m.keyword),
      weight: Math.max(0, Math.min(100, Math.round(Number(m.weight) || 0))),
    }))];
  }
  const key = cleanLabel(tenantKey);
  const name = cleanLabel(tenantName);
  if (key) body.tenant_key = key;
  if (name) body.tenant_name = name;
  if (timeoutS != null) body.timeout_s = Math.max(5, Math.min(600, Math.floor(timeoutS)));
  return body;
};

const str = (v) => (v == null ? '' : String(v)).trim();

/**
 * @returns {{ok: true, value: object} | {ok: false, kind: 'unavailable'|'invalid', reason: string}}
 */
const normalizeItem = (item) => {
  const intel = item?.intelligence;
  if (!intel || typeof intel !== 'object') return { ok: false, kind: 'invalid', reason: 'Empty or unusable intelligence response' };

  // A provider outage (LLM down/timeout) comes back as a well-formed record with source=error.
  if (str(intel.source).toLowerCase() === 'error') {
    return { ok: false, kind: 'unavailable', reason: `intelligence source=error: ${str(intel.reasoning) || 'provider failed'}` };
  }

  const sentiment = str(item.sentiment).toLowerCase();
  let riskScore = parseInt(intel.risk_score, 10);
  if (Number.isNaN(riskScore) || riskScore < 0) riskScore = 0;
  if (riskScore > 100) riskScore = 100;
  const category = str(intel.category) || 'Normal';
  const stanceConfidence = Number(intel.stance_confidence);
  const evidence = str(intel.evidence_confidence).toLowerCase();

  return {
    ok: true,
    value: {
      category,
      intent: str(intel.intent) || category,
      sentiment: SENTIMENTS.includes(sentiment) ? sentiment : 'neutral',
      risk_score: riskScore,
      reasoning: str(intel.reasoning),
      summary: str(intel.summary),
      recommended_action: str(intel.recommended_action),
      signals: Array.isArray(intel.signals) ? intel.signals.map(String) : [],
      keyword_context: Array.isArray(intel.keyword_context) ? intel.keyword_context : [],
      stance: STANCES.includes(str(intel.stance)) ? str(intel.stance) : 'Unclear',
      stance_confidence: Number.isFinite(stanceConfidence) ? Math.max(0, Math.min(1, stanceConfidence)) : 0,
      // The model's own confidence in its judgement, distinct from the
      // classifier's sentiment confidence. Required by the service schema.
      evidence_confidence: EVIDENCE.includes(evidence) ? evidence : 'low',
      // Only returned in enum intent mode; empty in free mode.
      intent_label: str(intel.intent_label),
      source: str(intel.source) || 'provider',
      model: str(intel.model),
      sentiment_confidence: typeof item.confidence === 'number' ? item.confidence : null,
      language: item.language || null,
      english_text: item.english_text || null,
      was_translated: Boolean(item.was_translated),
      was_transliterated: Boolean(item.was_transliterated),
    },
  };
};

module.exports = { buildRequest, normalizeItem, truncateText, intentMode, maxTextChars };
