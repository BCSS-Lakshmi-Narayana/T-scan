const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const tenantModel = require('./tenantModel');
const sourceSchema = new mongoose.Schema({
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
  platform: {
    type: String,
    enum: ['youtube', 'x', 'instagram', 'facebook'],
    required: true
  },
  identifier: {
    type: String,
    required: true
  },
  platform_user_id: {
    type: String,
    default: ''
  },
  old_identifiers: {
    type: [String],
    default: []
  },
  display_name: {
    type: String,
    required: true
  },
  display_name_normalized: {
    type: String,
    default: ''
  },
  profile_image_url: {
    type: String
  },
  category: {
    type: String,
    default: 'unknown'
  },
  priority: {
    type: String,
    enum: ['high', 'medium', 'low'],
    default: 'medium'
  },
  is_active: {
    type: Boolean,
    default: true
  },
  is_verified: {
    type: Boolean,
    default: false
  },
  created_by: {
    type: String,
    required: true
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  state: {
    type: String,
    default: ''
  },
  districts: {
    type: [String],
    default: []
  },
  updated_by: {
    type: String,
    default: ''
  },
  updated_at: {
    type: Date,
    default: Date.now
  },
  risk_level: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'low'
  },
  last_checked: {
    type: Date
  },
  last_identity_refresh_at: {
    type: Date,
    default: null
  },
  follower_count: {
    type: String,
    default: ''
  },
  joined_date: {
    type: String,
    default: ''
  },
  // YouTube Specific Metadata
  youtube_metadata: {
    upload_playlist_id: String,
    channel_branding_settings: mongoose.Schema.Types.Mixed,
    default_language: String,
    country: String
  },
  // Statistics Tracking
  statistics: {
    subscriber_count: { type: Number, default: 0 },
    video_count: { type: Number, default: 0 },
    view_count: { type: Number, default: 0 },
    hidden_subscriber_count: { type: Boolean, default: false }
  },
  // Historic Stats for Growth Tracking
  history: [{
    date: { type: Date, default: Date.now },
    subscriber_count: Number,
    video_count: Number,
    view_count: Number
  }]
});

// Compound index to prevent duplicates
sourceSchema.index({ platform: 1, identifier: 1 }, { unique: true });
sourceSchema.index({ platform: 1, platform_user_id: 1 });
sourceSchema.index({ category: 1 }); // Used by source category filter
sourceSchema.index({ category: 1, id: 1 }); // category -> source ids pre-resolution
sourceSchema.index({ display_name_normalized: 1 }); // For fancy-Unicode search
sourceSchema.index({ created_at: -1 }); // Sort performance on listing
sourceSchema.index({ display_name: 1 }); // Text search on raw name
sourceSchema.index({ is_active: 1, created_at: -1 }); // Active sources sorted
sourceSchema.index({ platform: 1, category: 1 }); // Common filter combo
sourceSchema.index({ platform: 1, is_active: 1 }); // Platform + active filter
// Tenant-leading indexes for fast tenant-scoped listing & pagination (admin + app)
sourceSchema.index({ tenant_id: 1, created_at: -1 }); // tenant list sorted (paginated)
sourceSchema.index({ tenant_id: 1, platform: 1, created_at: -1 }); // tenant + platform list (paginated)
sourceSchema.index({ tenant_id: 1, category: 1 }); // tenant + category filter
// District-scoped officer list: { tenant_id, districts: { $in } } sorted by created_at desc
sourceSchema.index({ tenant_id: 1, districts: 1, created_at: -1 });

// Auto-normalize display_name before save
sourceSchema.pre('save', function (next) {
  if (this.isModified('display_name') || !this.display_name_normalized) {
    this.display_name_normalized = (this.display_name || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }
  next();
});

module.exports = tenantModel('Source', sourceSchema);