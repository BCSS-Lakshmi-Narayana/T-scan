const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const tenantModel = require('./tenantModel');
const viralCampaignSchema = new mongoose.Schema(
  {
    id: { type: String, default: uuidv4, unique: true, required: true, index: true },
    tenant_id: { type: String, required: true, index: true },
    type: { type: String, enum: ['political', 'police'] },
    requested_by: String,
    updated_by: String,
    title: String,
    description: String,
    content_url: String,
    content_type: { type: String, enum: ['post', 'video', 'reel', 'story'] },
    target_platforms: [String],
    target_reach: Number,
    budget: Number,            // budget requested by the tenant
    location: String,          // optional geographic targeting the tenant wants
    state: String,
    districts: { type: [String], default: [] },
    deadline: Date,
    status: {
      type: String,
      enum: ['pending', 'open', 'assigned', 'in_progress', 'completed', 'cancelled', 'rejected'],
      default: 'pending'
    },
    // Super-admin review fields (set when the request is validated → auction).
    offer_type: { type: String, enum: ['auction', 'fixed'], default: 'auction' },
    approved_budget: Number,   // money the super admin sets (may differ from requested)
    fixed_amount: Number,      // payout when offer_type === 'fixed'
    linked_campaign_id: String,// the Super Admin InfluencerCampaign _id once in auction
    rejection_reason: String,
    assigned_influencer_id: String,
    influencer_accepted_at: Date,
    results: {
      posts: Number,
      reach: Number,
      likes: Number,
      comments: Number,
      actual_reach: Number,
      impressions: Number,
      engagement_rate: Number,
      completed_at: Date
    },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now }
  },
  { collection: 'viralcampaigns' }
);

viralCampaignSchema.pre('save', function (next) {
  this.updated_at = Date.now();
  next();
});

// District-scoped officer list: { tenant_id, districts: { $in } } sorted by created_at desc
viralCampaignSchema.index({ tenant_id: 1, districts: 1, created_at: -1 });

module.exports = tenantModel('ViralCampaign', viralCampaignSchema);