const mongoose = require('mongoose');

const tenantModel = require('./tenantModel');
const policeNewsArticleSchema = new mongoose.Schema({
  tenant_id:         { type: String, required: true, index: true },
  title:             { type: String, required: true },
  title_english:     { type: String },
  summary:           { type: String },
  summary_english:   { type: String },
  content:           { type: String },
  // Unique PER TENANT (compound index below), not globally, so two tenants can
  // independently store the same article (one tenant's RSS no longer blocks another's).
  source_url:        { type: String, required: true },
  source_name:       { type: String },
  source_domain:     { type: String },
  source_type:       { type: String, default: 'rss' },
  image_url:         { type: String },
  language:          { type: String, default: 'en' },
  category:          { type: String, default: 'general' },
  detected_location: { type: mongoose.Schema.Types.Mixed },
  keywords_matched:  [{ type: String }],
  relevance_score:   { type: Number, default: 0 },
  published_date:    { type: Date },
  scraped_at:        { type: Date, default: Date.now },
  is_translated:     { type: Boolean, default: false },
}, { timestamps: false, collection: 'police_newsarticles' });

// Tenant-scoped uniqueness (replaces the old GLOBAL source_url unique index;
// index.js migration drops the stale source_url_1 at startup).
policeNewsArticleSchema.index({ tenant_id: 1, source_url: 1 }, { unique: true });
policeNewsArticleSchema.index({ scraped_at: -1 });
policeNewsArticleSchema.index({ 'detected_location.district': 1 });

module.exports = tenantModel('PoliceNewsArticle', policeNewsArticleSchema);