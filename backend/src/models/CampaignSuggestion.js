const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const tenantModel = require('./tenantModel');
/**
 * CampaignSuggestion — an AI-generated awareness-campaign idea derived from THIS tenant's
 * own grievances + alerts. Tenant-scoped (tenant_id) and generated on demand by the Super
 * Admin. Each suggestion is tagged with sentiment + intent (counter a negative trend /
 * amplify a positive one) and scored by impact + urgency so the operator can prioritise.
 */
const campaignSuggestionSchema = new mongoose.Schema(
  {
    id: { type: String, default: uuidv4, unique: true, index: true },
    tenant_id: { type: String, required: true, index: true },
    type: { type: String, enum: ['political', 'police'] },

    title: { type: String, required: true },
    summary: { type: String, default: '' },
    sentiment: { type: String, enum: ['positive', 'negative', 'neutral', 'mixed'], default: 'mixed' },
    intent: { type: String, enum: ['amplify', 'counter'], default: 'amplify' },

    impact_score: { type: Number, default: 0 },   // 0–100
    urgency_score: { type: Number, default: 0 },   // 0–100
    priority: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },

    suggested_message: { type: String, default: '' },
    suggested_news: { type: [String], default: [] },
    target_platforms: { type: [String], default: [] },
    recommended_niche: { type: String, default: '' }, // used by Super Admin for influencer matching
    rationale: { type: String, default: '' },

    evidence: {
      grievance_count: { type: Number, default: 0 },
      alert_count: { type: Number, default: 0 },
      top_topics: { type: [String], default: [] },
      sample_texts: { type: [String], default: [] },
    },

    status: { type: String, enum: ['new', 'dismissed', 'converted'], default: 'new', index: true },
    linked_campaign_id: { type: String },

    generated_at: { type: Date, default: Date.now },
    created_at: { type: Date, default: Date.now },
  },
  { collection: 'campaign_suggestions' }
);

module.exports = tenantModel('CampaignSuggestion', campaignSuggestionSchema);