const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const tenantModel = require('./tenantModel');
const alertSchema = new mongoose.Schema({
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
  source_id: {
    type: String,
    required: false,
    ref: 'Source'
  },
  content_ref_id: {
    type: String,
    default: null
  },
  source_category: {
    type: String,
    default: null
  },
  matched_keywords_normalized: {
    type: [String],
    default: []
  },
  event_id: {
    type: String,
    default: null
  },
  analysis_id: {
    type: String,
    ref: 'Analysis'
  },
  // Alert type classification
  alert_type: {
    type: String,
    enum: ['keyword_risk', 'ai_risk', 'velocity', 'new_post'],
    default: 'keyword_risk'
  },
  // Priority classification for velocity alerts
  priority: {
    type: String,
    enum: ['LOW', 'MEDIUM', 'HIGH'],
    default: 'MEDIUM'
  },
  // Velocity-specific data
  velocity_data: {
    metric: { type: String },
    current_value: { type: Number },
    previous_value: { type: Number },
    velocity: { type: Number },
    time_window_minutes: { type: Number },
    threshold_triggered: { type: Number }
  },
  risk_level: {
    type: String,
    enum: ['low', 'medium', 'high'],
    required: true,
    lowercase: true
  },
  // Threat detection details for display
  threat_details: {
    intent: { type: String },           // e.g., "Violence", "Political"
    reasons: [{ type: String }],         // Array of reasons why flagged
    highlights: [{ type: String }],      // Flagged keywords/phrases
    risk_score: { type: Number },        // 0-100
    confidence: { type: Number }         // AI confidence
  },
  violated_policies: {
    type: mongoose.Schema.Types.Mixed,
    default: []
  },
  legal_sections: {
    type: mongoose.Schema.Types.Mixed,
    default: []
  },
  complaint_text: {
    type: String
  },
  classification_explanation: {
    type: String
  },
  title: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  content_url: {
    type: String,
    required: true
  },
  platform: {
    type: String,
    enum: ['youtube', 'x', 'instagram', 'facebook'],
    required: true
  },
  author: {
    type: String,
    required: true
  },
  author_handle: {
    type: String
  },
  status: {
    type: String,
    enum: ['active', 'acknowledged', 'resolved', 'false_positive', 'escalated', 'all'],
    default: 'active'
  },
  // Append-only log of status transitions — powers the Alert Workflow KPI.
  // Each entry records who moved the alert to which status and when.
  status_history: {
    type: [{
      to: { type: String },
      from: { type: String, default: null },
      changed_by: { type: String, default: null },       // User.id
      changed_by_email: { type: String, default: null },
      at: { type: Date, default: Date.now }
    }],
    default: []
  },
  content_published_at: {
    type: Date,
    default: null
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  acknowledged_by: {
    type: String,
    ref: 'User'
  },
  acknowledged_at: {
    type: Date
  },
  is_read: {
    type: Boolean,
    default: false
  },
  is_priority: {
    type: Boolean,
    default: false
  },
  priority_reason: {
    type: String,
    default: ''
  },
  notes: {
    type: String
  },
  is_investigation: {
    type: Boolean,
    default: false
  },
  // Side-by-side analysis results for verification
  ml_analysis: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  llm_analysis: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  }
});

// Performance Indexes â€” sorted by content_published_at (actual post date on platform)
alertSchema.index({ status: 1, content_published_at: -1 });
alertSchema.index({ risk_level: 1, content_published_at: -1 });
alertSchema.index({ platform: 1, content_published_at: -1 });
alertSchema.index({ status: 1, platform: 1, content_published_at: -1 });
alertSchema.index({ status: 1, alert_type: 1, content_published_at: -1 });
alertSchema.index({ status: 1, platform: 1, alert_type: 1, content_published_at: -1 });
alertSchema.index({ status: 1, risk_level: 1, content_published_at: -1 });
alertSchema.index({ alert_type: 1, content_published_at: -1 });
alertSchema.index({ content_id: 1 });
alertSchema.index({ source_id: 1 });
alertSchema.index({ is_read: 1, content_published_at: -1 });
// NOTE: `id` already has `unique: true` at field level, which creates its own unique index.
alertSchema.index({ status: 1, content_published_at: -1, id: -1 });
alertSchema.index({ status: 1, platform: 1, content_published_at: -1, id: -1 });
alertSchema.index({ status: 1, alert_type: 1, content_published_at: -1, id: -1 });
alertSchema.index({ status: 1, risk_level: 1, content_published_at: -1, id: -1 });
alertSchema.index({ status: 1, source_category: 1, content_published_at: -1, id: -1 });
alertSchema.index({ status: 1, matched_keywords_normalized: 1, content_published_at: -1, id: -1 });
alertSchema.index({ status: 1, platform: 1, source_category: 1, content_published_at: -1, id: -1 });
alertSchema.index({ status: 1, platform: 1, risk_level: 1, alert_type: 1, content_published_at: -1, id: -1 });
alertSchema.index({ content_ref_id: 1 });
// Legacy index for created_at (used by unread queries, etc.)
alertSchema.index({ status: 1, created_at: -1 });

module.exports = tenantModel('Alert', alertSchema);