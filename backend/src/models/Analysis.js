const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const tenantModel = require('./tenantModel');
const analysisSchema = new mongoose.Schema({
  id: {
    type: String,
    default: uuidv4,
    unique: true
  },
  tenant_id: {
    type: String,
    required: true,
    index: true
  },
  content_id: {
    type: String,
    required: true,
    ref: 'Content'
  },
  // Inherited from the analyzed content's source at creation, for per-district
  // officer scoping of analytics/risk aggregations.
  districts: {
    type: [String],
    default: []
  },
  risk_score: {
    type: Number,
    min: 0,
    max: 100,
    default: 0
  },
  violence_score: {
    type: Number,
    required: true,
    min: 0,
    max: 1000
  },
  threat_score: {
    type: Number,
    required: true,
    min: 0,
    max: 1000
  },
  hate_score: {
    type: Number,
    required: true,
    min: 0,
    max: 1000
  },
  sentiment: {
    type: String,
    enum: ['positive', 'neutral', 'negative'],
    required: true
  },
  risk_level: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    required: true
  },
  triggered_keywords: [{
    type: String
  }],
  topic: {
    type: String
  },
  context: {
    type: String
  },
  summary: {
    type: String
  },
  flagged_lines: [{
    line: Number,
    text: String,
    category: String,
    severity: String,
    reason: String
  }],
  explanation: {
    type: String
  },
  intent: {
    type: String
  },
  confidence: {
    type: Number
  },
  language: {
    type: String
  },
  reasons: [{
    type: String
  }],
  highlights: [{
    type: String
  }],
  legal_sections: {
    type: mongoose.Schema.Types.Mixed,
    default: []
  },
  violated_policies: {
    type: mongoose.Schema.Types.Mixed,
    default: []
  },
  layers: {
    type: mongoose.Schema.Types.Mixed
  },
  threat_model: {
    type: mongoose.Schema.Types.Mixed
  },
  llm_analysis: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  // Sentiment service output (same fields as soceye's analysis_result)
  category: { type: String },
  sentiment_confidence: { type: Number },
  recommended_action: { type: String },
  signals: [{ type: String }],
  keyword_context: { type: mongoose.Schema.Types.Mixed, default: [] },
  stance: { type: String },              // Support | Oppose | Neutral | Unclear
  stance_confidence: { type: Number },
  matched_keywords: { type: mongoose.Schema.Types.Mixed, default: [] },
  policy_triggered_keywords: [{ type: String }],
  english_text: { type: String },
  was_translated: { type: Boolean },
  evidence_confidence: { type: String },
  // Provenance, as soceye records it: which provider answered and
  // through which endpoint.
  source: { type: String },
  analyzed_via: { type: String },
  analysis_source: { type: String },
  model: { type: String },
  thresholds: { type: mongoose.Schema.Types.Mixed },
  analyzed_at: {
    type: Date,
    default: Date.now
  }
});

analysisSchema.index({ content_id: 1 });
// One analysis per content — re-analysis updates it in place.
// Existing duplicates must be removed first (scripts/migrate-sentiment-service.js).
analysisSchema.index({ tenant_id: 1, content_id: 1 }, { unique: true });
analysisSchema.index({ tenant_id: 1, districts: 1, risk_level: 1 }); // district-scoped risk aggregation

module.exports = tenantModel('Analysis', analysisSchema);