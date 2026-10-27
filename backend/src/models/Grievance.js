const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const tenantModel = require('./tenantModel');
const { analysisStatusFields, applyAnalysisStatusIndexes } = require('./analysisStatusFields');
const createGrievanceMediaItemDefinition = () => ({
  type: { type: String, enum: ['photo', 'video', 'animated_gif'] },
  url: { type: String },
  video_url: { type: String },
  preview_url: { type: String },
  original_url: { type: String, default: null },
  original_video_url: { type: String, default: null },
  original_preview_url: { type: String, default: null },
  s3_url: { type: String, default: null },
  s3_key: { type: String, default: null },
  s3_preview: { type: String, default: null },
  s3_preview_key: { type: String, default: null }
});

const createGrievanceContextPostDefinition = () => ({
  tweet_id: { type: String },
  tweet_url: { type: String },
  posted_by: {
    handle: { type: String },
    display_name: { type: String },
    profile_image_url: { type: String },
    is_verified: { type: Boolean, default: false }
  },
  content: {
    text: { type: String },
    full_text: { type: String },
    media: [createGrievanceMediaItemDefinition()]
  },
  post_date: { type: Date }
});

/**
 * Grievance Model
 * Stores grievance posts from monitored X/Facebook government sources
 */
const grievanceSchema = new mongoose.Schema({
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
  complaint_code: {
    type: String
  },
  // Canonical external post ID.
  // For X: raw tweet id.
  // For Facebook: prefixed ids (e.g., facebook:post:<id>, facebook:comment:<id>).
  tweet_id: {
    type: String,
    required: true
  },
  // The government account that was tagged
  tagged_account: {
    type: String,
    required: true
  },
  tagged_account_normalized: {
    type: String,
    default: ''
  },
  // Denormalized from the monitored GrievanceSource at ingestion time, so
  // grievances can be district-scoped for officers the same way as other modules.
  state: {
    type: String,
    default: ''
  },
  districts: {
    type: [String],
    default: []
  },
  // Reference to GrievanceSource
  grievance_source_id: {
    type: String,
    ref: 'GrievanceSource'
  },
  // Source platform
  platform: {
    type: String,
    enum: ['x', 'facebook', 'whatsapp'],
    default: 'x'
  },
  complainant_phone: {
    type: String
  },
  source_ref: {
    type: String
  },
  whatsapp_message_sid: {
    type: String
  },
  // Author information
  posted_by: {
    handle: { type: String, required: true },
    display_name: { type: String },
    profile_image_url: { type: String },
    is_verified: { type: Boolean, default: false },
    follower_count: { type: Number, default: 0 }
  },
  // Post content
  content: {
    text: { type: String, required: true },
    full_text: { type: String },
    media: [createGrievanceMediaItemDefinition()]
  },
  // Context about the original post when this grievance is a reply/quote.
  // This enables showing both the tagged reply and the original post in the UI.
  context: {
    in_reply_to: createGrievanceContextPostDefinition(),
    reposted_from: createGrievanceContextPostDefinition(),
    quoted: createGrievanceContextPostDefinition(),
    thread_parent: createGrievanceContextPostDefinition(),
    thread_chain: [createGrievanceContextPostDefinition()]
  },
  // Tweet URL
  tweet_url: {
    type: String,
    required: true
  },
  // Engagement metrics
  engagement: {
    likes: { type: Number, default: 0 },
    retweets: { type: Number, default: 0 },
    replies: { type: Number, default: 0 },
    views: { type: Number, default: 0 },
    quotes: { type: Number, default: 0 }
  },
  // Timestamps
  post_date: {
    type: Date,
    required: true
  },
  detected_date: {
    type: Date,
    default: Date.now
  },
  workflow_status: {
    type: String,
    enum: ['received', 'reviewed', 'action_taken', 'closed', 'converted_to_fir'],
    default: 'received'
  },
  workflow_history: [{
    from: { type: String },
    to: { type: String, enum: ['received', 'reviewed', 'action_taken', 'closed', 'converted_to_fir'] },
    at: { type: Date, default: Date.now },
    by: { type: String },
    note: { type: String }
  }],
  workflow_timestamps: {
    received_at: { type: Date },
    reviewed_at: { type: Date },
    action_taken_at: { type: Date },
    closed_at: { type: Date },
    fir_converted_at: { type: Date }
  },
  escalation_count: {
    type: Number,
    default: 0
  },
  escalation_history: [{
    reason: { type: String },
    note: { type: String },
    by: { type: String },
    at: { type: Date, default: Date.now }
  }],
  fir_converted_at: {
    type: Date
  },
  fir_converted_by: {
    type: String
  },
  fir_number: {
    type: String
  },
  // Classification status
  classification: {
    type: String,
    enum: ['unclassified', 'acknowledged', 'complaint'],
    default: 'unclassified'
  },
  // For acknowledged items - reason for acknowledgment
  acknowledgment: {
    reason: { type: String },
    acknowledged_by: { type: String },
    acknowledged_at: { type: Date },
    notes: { type: String }
  },
  // For complaints - action details
  complaint: {
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'medium'
    },
    status: {
      type: String,
      enum: ['pending', 'sent', 'reviewed', 'case_booked'],
      default: 'pending'
    },
    // Unique report number: X-GRV-DD-MM-YY-SERIAL
    report_number: { type: String },
    // PDF report path/URL
    report_url: { type: String },
    // Action details
    action_taken: { type: String },
    action_taken_by: { type: String },
    action_taken_at: { type: Date },
    // Sharing history
    shared_with: [{
      contact_number: { type: String },
      shared_at: { type: Date },
      shared_by: { type: String },
      method: { type: String, enum: ['whatsapp', 'download'] }
    }],
    // Internal notes
    notes: { type: String },
    // Category of complaint
    category: { type: String }
  },
  // Criticism workflow tracking
  criticism: {
    report_id: { type: String },
    unique_code: { type: String },
    category: { type: String },
    remarks: { type: String },
    message: { type: String },
    media_s3_urls: [{ type: String }],
    action_taken_at: { type: Date },
    shared_at: { type: Date },
    shared_via: { type: String },
    informed_to: {
      name: { type: String },
      phone: { type: String },
      department: { type: String }
    }
  },
  // Grievance (G) workflow tracking
  grievance_workflow: {
    report_id: { type: String },
    unique_code: { type: String },
    status: { type: String, enum: ['PENDING', 'ESCALATED', 'CLOSED'], default: 'PENDING' },
    category: { type: String },
    shared_at: { type: Date },
    informed_to: {
      type: {
        name: { type: String, default: '' },
        phone: { type: String, default: '' },
        department: { type: String, default: '' }
      },
      default: () => ({})
    }
  },
  // Query (Q) workflow tracking
  query_workflow: {
    report_id: { type: String },
    unique_code: { type: String },
    status: { type: String, enum: ['PENDING', 'CLOSED'], default: 'PENDING' },
    category: { type: String },
    shared_at: { type: Date },
    informed_to: {
      type: {
        name: { type: String, default: '' },
        phone: { type: String, default: '' },
        department: { type: String, default: '' }
      },
      default: () => ({})
    }
  },
  // Suggestion (S) workflow tracking
  suggestion: {
    report_id: { type: String },
    unique_code: { type: String },
    category: { type: String },
    remarks: { type: String },
    message: { type: String },
    media_s3_urls: [{ type: String }],
    action_taken_at: { type: Date },
    shared_at: { type: Date },
    shared_via: { type: String },
    informed_to: {
      name: { type: String },
      phone: { type: String },
      department: { type: String }
    }
  },
  // AI analysis, written by services/sentiment (grievance target) from the
  // sentiment service result. `urgency` mirrors risk_level so existing readers
  // (intelligence dashboard, campaign suggestions) keep working.
  analysis: {
    sentiment: { type: String, enum: ['positive', 'negative', 'neutral'] },
    sentiment_confidence: { type: Number },
    urgency: { type: String, enum: ['low', 'medium', 'high', 'critical'] },
    keywords: [{ type: String }],
    summary: { type: String },
    category: { type: String },
    intent: { type: String },
    risk_score: { type: Number },
    risk_level: { type: String, enum: ['low', 'medium', 'high'] },
    reasoning: { type: String },
    recommended_action: { type: String },
    stance: { type: String },
    language: { type: String },
    english_text: { type: String },
    triggered_keywords: [{ type: String }],
    violated_policies: { type: mongoose.Schema.Types.Mixed, default: [] },
    legal_sections: { type: mongoose.Schema.Types.Mixed, default: [] },
    llm_analysis: { type: mongoose.Schema.Types.Mixed, default: null },
    model: { type: String },
    analysis_source: { type: String },
    // Parity with the Analysis document the content pipeline writes: a grievance
    // stores the same block inline (it gets no Analysis row, because Command
    // Center aggregates that collection bare and would count grievances as
    // monitored posts). Keep these in step with models/Analysis.js.
    explanation: { type: String },
    confidence: { type: Number },
    stance_confidence: { type: Number },
    signals: [{ type: String }],
    keyword_context: { type: mongoose.Schema.Types.Mixed, default: [] },
    matched_keywords: { type: mongoose.Schema.Types.Mixed, default: [] },
    policy_triggered_keywords: [{ type: String }],
    reasons: [{ type: String }],
    highlights: [{ type: String }],
    evidence_confidence: { type: String },
    // Provenance, as soceye records it: which provider answered and
    // through which endpoint.
    source: { type: String },
    analyzed_via: { type: String },
    was_translated: { type: Boolean },
    thresholds: { type: mongoose.Schema.Types.Mixed },
    violence_score: { type: Number },
    threat_score: { type: Number },
    hate_score: { type: Number },
    analyzed_at: { type: Date }
  },
  // Sentiment-pipeline work tracking (claim, retry, recovery) — same fields as Content/Comment.
  ...analysisStatusFields,
  // Is this grievance currently visible/active
  is_active: {
    type: Boolean,
    default: true
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  updated_at: {
    type: Date,
    default: Date.now
  }
});

// Pre-save middleware
grievanceSchema.pre('save', function (next) {
  this.updated_at = new Date();
  this.tagged_account_normalized = String(this.tagged_account || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();
  next();
});

// Compound unique: one tweet_id per tenant (allows same tweet across tenants)
grievanceSchema.index({ tweet_id: 1, tenant_id: 1 }, { unique: true });

// Indexes for efficient queries
grievanceSchema.index({ platform: 1 });
grievanceSchema.index({ tagged_account: 1 });
grievanceSchema.index({ classification: 1 });
grievanceSchema.index({ 'complaint.status': 1 });
grievanceSchema.index({ complaint_code: 1 }, { unique: true, sparse: true });
grievanceSchema.index({ workflow_status: 1, post_date: -1 });
grievanceSchema.index({ platform: 1, workflow_status: 1, post_date: -1 });
grievanceSchema.index({ whatsapp_message_sid: 1 }, { unique: true, sparse: true });
grievanceSchema.index({ post_date: -1 });
grievanceSchema.index({ detected_date: -1 });
grievanceSchema.index({ 'posted_by.handle': 1 });
grievanceSchema.index({ 'complaint.report_number': 1 });
grievanceSchema.index({ is_active: 1, workflow_status: 1, post_date: -1, id: -1 });
grievanceSchema.index({ is_active: 1, platform: 1, workflow_status: 1, post_date: -1, id: -1 });
grievanceSchema.index({ is_active: 1, grievance_source_id: 1, workflow_status: 1, post_date: -1, id: -1 });
grievanceSchema.index({ is_active: 1, classification: 1, 'complaint.status': 1, post_date: -1 });
grievanceSchema.index({ is_active: 1, tagged_account_normalized: 1, post_date: -1 });
grievanceSchema.index({ 'criticism.unique_code': 1 }, { sparse: true });
grievanceSchema.index({ 'grievance_workflow.status': 1, post_date: -1 });
grievanceSchema.index({ is_active: 1, 'grievance_workflow.status': 1, post_date: -1, id: -1 });
grievanceSchema.index({ 'query_workflow.unique_code': 1 }, { sparse: true });
grievanceSchema.index({ 'query_workflow.status': 1, post_date: -1 });
grievanceSchema.index({ 'suggestion.unique_code': 1 }, { sparse: true });
// District-scoped officer list: { tenant_id, districts: { $in }, ... } sorted by post_date desc, id desc
grievanceSchema.index({ tenant_id: 1, districts: 1, post_date: -1, id: -1 });
applyAnalysisStatusIndexes(grievanceSchema);
// Grievance list/dashboard filters on the analysis result.
grievanceSchema.index({ tenant_id: 1, 'analysis.sentiment': 1, post_date: -1 });
grievanceSchema.index({ tenant_id: 1, 'analysis.risk_level': 1, post_date: -1 });

// Virtual for generating report number
grievanceSchema.methods.generateReportNumber = async function () {
  const date = new Date();
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = String(date.getFullYear()).slice(-2);

  // Get serial number for today
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const count = await mongoose.model('Grievance').countDocuments({
    'complaint.report_number': { $exists: true, $ne: null },
    'complaint.action_taken_at': { $gte: startOfDay, $lte: endOfDay }
  });

  const serial = String(count + 1).padStart(3, '0');
  return `X-GRV-${day}-${month}-${year}-${serial}`;
};

module.exports = tenantModel('Grievance', grievanceSchema);