/**
 * Maps a service result onto police storage — soceye's analysis_result, written
 * into the police shapes (Analysis, Content, the llm_analysis block ReasonModal reads).
 */

const mappingService = require('../mappingService');

const DEFAULT_THRESHOLDS = { high: 70, medium: 40 };

// Every platform whose rules are checked for a post, whichever one it came from.
const POLICY_PLATFORMS = ['x', 'youtube', 'facebook', 'instagram'];

/** Thresholds from a settings doc; both legacy field pairs are honoured. */
const thresholdsFrom = (settings) => ({
  high: Number(settings?.high_risk_threshold ?? settings?.risk_threshold_high ?? DEFAULT_THRESHOLDS.high),
  medium: Number(settings?.medium_risk_threshold ?? settings?.risk_threshold_medium ?? DEFAULT_THRESHOLDS.medium),
});

const riskLevelFor = (score, { high, medium }) => {
  if (score >= high) return 'high';
  if (score >= medium) return 'medium';
  return 'low';
};

/** 0-1000 sub-scores kept for Command Center averages. */
const subScores = (category, riskScore) => {
  const c = String(category || '');
  const scaled = Math.round(riskScore * 10);
  return {
    violence_score: /violen|communal|terror|riot/i.test(c) ? scaled : 0,
    threat_score: /threat|terror/i.test(c) ? scaled : 0,
    hate_score: /hate/i.test(c) ? scaled : 0,
  };
};

/**
 * @param {object} value      normalized service result (sentiment.contract)
 * @param {object} ctx
 * @param {string} ctx.tenantId
 * @param {string[]} [ctx.districts]
 * @param {string} ctx.text              the text that was analysed
 * @param {string} [ctx.platform]        x | facebook | instagram | youtube
 * @param {Array} [ctx.matched]          tenant keyword matches
 * @param {object} [ctx.settings]        resolved district settings (thresholds)
 */
const mapResult = (value, ctx) => {
  const { tenantId, districts = [], text = '', platform = 'x', matched = [], settings = null } = ctx;
  const thresholds = thresholdsFrom(settings);

  // Risk is the service's score only; keywords never change it.
  const riskScore = Math.max(0, Math.min(100, Number(value.risk_score) || 0));
  const riskLevel = riskLevelFor(riskScore, thresholds);

  // Policy Manager legal + platform rules (category inferred from policy keywords
  // if the service said Normal).
  //
  // Policies are resolved for EVERY platform, not just the one the post is on:
  // the same content usually breaches several platforms' rules at once, and
  // ReasonModal renders them grouped under X / YouTube / Meta. Resolving only
  // the post's own platform left two of those groups permanently empty.
  let mapping = { category_id: null, legal_sections: [], platform_policies: [], triggered_keywords: [] };
  try {
    mapping = mappingService.resolveForAnalysis({ category: value.category, text, platform, country: 'IN', tenantId, districts });
    for (const other of POLICY_PLATFORMS) {
      if (other === platform) continue;
      const m = mappingService.resolveMapping(mapping.category_id || value.category, text, other, 'IN', tenantId, districts);
      if (m.platform_policies?.length) mapping.platform_policies.push(...m.platform_policies);
    }
  } catch (err) {
    console.error(`[Sentiment] policy mapping failed: ${err.message}`);
  }

  const category = mapping.category_id || value.category || null;
  const intent = value.intent || category || null;
  const keywords = matched.map((m) => m.keyword);
  const legalSections = mapping.legal_sections || [];
  const violatedPolicies = mapping.platform_policies || [];

  // Reads as a short evidence list under "Analysis" on the alert and in
  // ReasonModal: why it scored, then what it breaches.
  const reasons = [
    value.reasoning,
    `Risk Score: ${riskScore}%`,
    ...violatedPolicies.map((p) => `Policy: ${p.policy_name}`),
    ...legalSections.map((l) => `Legal: ${l.act} ${l.section}`),
    ...matched.map((m) => `Keyword match: ${m.keyword} (weight ${m.weight})`),
  ].filter(Boolean);

  const llmAnalysis = {
    category,
    intent,
    sentiment: value.sentiment,
    reasoning: value.reasoning || '',
    score: riskScore,
    summary: value.summary || '',
    recommended_action: value.recommended_action || '',
    evidence_confidence: value.evidence_confidence || null,
    signals: Array.isArray(value.signals) ? value.signals : [],
    platform_policies_violated: violatedPolicies,
    bns_sections_violated: legalSections,
  };

  return {
    risk_score: riskScore,
    risk_level: riskLevel,
    sentiment: value.sentiment,
    category,
    intent,
    explanation: value.reasoning || '',
    reasons,
    matched_keywords: matched,
    highlights: keywords,
    legal_sections: legalSections,
    violated_policies: violatedPolicies,
    llm_analysis: llmAnalysis,

    /** Fields written to the Analysis document. */
    analysisFields: {
      risk_score: riskScore,
      risk_level: riskLevel,
      sentiment: value.sentiment,
      sentiment_confidence: value.sentiment_confidence,
      confidence: value.sentiment_confidence,
      category,
      intent,
      explanation: value.reasoning || '',
      summary: value.summary || '',
      recommended_action: value.recommended_action || null,
      signals: value.signals || [],
      // The model's confidence in its own judgement, distinct from `confidence`
      // (the classifier's sentiment score).
      evidence_confidence: value.evidence_confidence || null,
      keyword_context: value.keyword_context || [],
      stance: value.stance,
      stance_confidence: value.stance_confidence,
      matched_keywords: matched,
      reasons,
      highlights: keywords,
      triggered_keywords: keywords,
      legal_sections: legalSections,
      violated_policies: violatedPolicies,
      policy_triggered_keywords: mapping.triggered_keywords || [],
      language: value.language,
      english_text: value.english_text,
      was_translated: value.was_translated,
      analysis_source: 'sentiment-service',
      // Which provider answered, and through which endpoint — the two fields
      // soceye records so a result can be traced back to how it was produced.
      source: value.source || null,
      analyzed_via: 'analyze/intelligence',
      model: value.model || null,
      thresholds,
      ...subScores(category, riskScore),
      llm_analysis: llmAnalysis,
      analyzed_at: new Date(),
    },

    /** Fields written onto the Content document. */
    contentFields: {
      risk_score: riskScore,
      risk_level: riskLevel,
      sentiment: value.sentiment,
      threat_intent: intent,
      threat_reasons: reasons,
      risk_factors: matched.map((m) => ({ keyword: m.keyword, weight: m.weight, category: m.category, context: 'Keyword match' })),
    },
  };
};

module.exports = { mapResult, thresholdsFrom, riskLevelFor, DEFAULT_THRESHOLDS };
