const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const tenantModel = require('./tenantModel');
const comprehensiveReportSchema = new mongoose.Schema({
  id: { type: String, default: uuidv4, unique: true },
  tenant_id: {
    type: String,
    required: true,
    index: true
  },
  report_date: { type: Date, required: true, index: true },
  date_key: { type: String, required: true }, // uniqueness is tenant-scoped via the compound index below
  date_range: {
    start: { type: Date, required: true },
    end: { type: Date, required: true }
  },
  generated_at: { type: Date, default: Date.now },
  status: { type: String, enum: ['generating', 'completed', 'failed'], default: 'generating' },

  // A. Dial-100 Calls
  dial100_calls: {
    total_count: { type: Number, default: 0 },
    trend_percentage: { type: Number, default: 0 },
    by_category: [{ category: String, count: Number }],
    by_jurisdiction: [{ jurisdiction: String, count: Number }],
    response_time_avg: { type: Number, default: 0 },
    critical_incidents: { type: Number, default: 0 },
    ai_summary: { type: String, default: '' }
  },

  // B. Grievances
  grievances: {
    total_count: { type: Number, default: 0 },
    under_review: { type: Number, default: 0 },
    pending: { type: Number, default: 0 },
    closed: { type: Number, default: 0 },
    by_type: { criticism: Number, suggestion: Number, grievance: Number },
    by_platform: [{ platform: String, count: Number }],
    by_status: [{ status: String, count: Number }],
    top_tagged_accounts: [{ account: String, count: Number }],
    ai_summary: { type: String, default: '' }
  },

  // C. Events
  events: {
    total_count: { type: Number, default: 0 },
    human_trafficking: { type: Number, default: 0 },
    public_unrest: { type: Number, default: 0 },
    other_categorized: { type: Number, default: 0 },
    by_platform: [{ platform: String, fetched: Number, relevant: Number }],
    top_events: [{
      event_id: String, event_name: String, content_count: Number,
      platforms: [String], event_type: String, timestamp: Date,
      source_platforms: [String], reach: Number, risk_score: Number,
      geo_location: String, related_profiles: [String], media_preview: String,
      engagement_metrics: { views: Number, likes: Number, shares: Number, comments: Number }
    }],
    ai_insights: { type: String, default: '' },
    ai_observations: { type: String, default: '' }
  },

  // D. Alerts
  alerts: {
    total_count: { type: Number, default: 0 },
    top_5_critical: [{
      alert_id: String, title: String, priority: String, category: String,
      risk_score: Number, created_at: Date, platform: String, status: String
    }],
    priority_scoring: { high: Number, medium: Number, low: Number },
    by_category: [{ category: String, count: Number }],
    by_platform: [{ platform: String, count: Number }],
    escalated_count: { type: Number, default: 0 },
    ai_intelligence_summary: { type: String, default: '' },

    // Top Profiles
    top_profiles: [{
      profile_id: String, name: String, handle: String, platform: String,
      profile_image: String, category: String, influence_score: Number,
      threat_score: Number
    }],

    // Viral Posts
    viral_posts: [{
      post_id: String, content_preview: String, platform: String,
      engagement: { views: Number, likes: Number, shares: Number, comments: Number },
      virality_score: Number, ai_explanation: String
    }],

    // Top 50 Alert Summaries
    alert_summaries: [{
      alert_id: String, title: String, category: String, ai_summary: String,
      threat_level: String, related_keywords: [String], related_profiles: [String],
      timestamp: Date, status: String, analyst_remarks: String
    }]
  },

  // E. Escalated to Investigation
  escalations: {
    total_count: { type: Number, default: 0 },
    under_action: { type: Number, default: 0 },
    pending: { type: Number, default: 0 },
    closed: { type: Number, default: 0 },
    by_status: [{ status: String, count: Number }],
    ai_recommendation: { type: String, default: '' }
  },

  // F. Profiles
  profiles: {
    added_count: { type: Number, default: 0 },
    deleted_count: { type: Number, default: 0 },
    newly_active: { type: Number, default: 0 },
    high_risk: { type: Number, default: 0 },
    total_monitoring: { type: Number, default: 0 },
    by_platform: [{ platform: String, active: Number, deleted: Number }],
    by_category: [{ category: String, count: Number }],
    high_risk_profiles: [{
      poi_id: String, name: String, platform: String, handle: String,
      alert_count: Number, profile_image: String
    }]
  },

  // G. Top 10 Keywords / Trends
  keywords_trends: [{
    keyword: String, frequency: Number, sentiment: String,
    trend: String, platforms: [String], risk_level: String
  }],

  // AI Executive Summary
  executive_summary: { type: String, default: '' },
  threat_highlights: { type: String, default: '' },
  escalation_recommendations: { type: String, default: '' },
  intelligence_observations: { type: String, default: '' },

  // Summary Statistics
  summary_statistics: {
    total_content_processed: { type: Number, default: 0 },
    threat_rate_percentage: { type: Number, default: 0 },
    sentiment_breakdown: { positive: Number, negative: Number, neutral: Number },
    viral_posts_count: { type: Number, default: 0 }
  },

  pdf_url: { type: String, default: '' }
}, { timestamps: true });

comprehensiveReportSchema.index({ report_date: -1 });
comprehensiveReportSchema.index({ tenant_id: 1, date_key: 1 }, { unique: true });
comprehensiveReportSchema.index({ status: 1, report_date: -1 });

module.exports = tenantModel('ComprehensiveReport', comprehensiveReportSchema);