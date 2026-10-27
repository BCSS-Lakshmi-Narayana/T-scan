const mongoose = require('mongoose');

const tenantModel = require('./tenantModel');
const policeRssKeywordSchema = new mongoose.Schema({
  tenant_id:  { type: String, required: true, index: true },
  // Unique PER TENANT (compound index below), not globally.
  keyword:    { type: String, required: true, trim: true, lowercase: true },
  is_active:  { type: Boolean, default: true },
  source:     { type: String, enum: ['user', 'config'], default: 'user' },
  added_by:   { type: String, default: '' },
  updated_by: { type: String, default: '' },
  state:      { type: String, default: '' },
  districts:  { type: [String], default: [] },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
}, { collection: 'police_rsskeywords' });

// Tenant-scoped uniqueness (replaces the old GLOBAL keyword unique index;
// index.js migration drops the stale keyword_1 at startup).
policeRssKeywordSchema.index({ tenant_id: 1, keyword: 1 }, { unique: true });
policeRssKeywordSchema.index({ tenant_id: 1, is_active: 1 });
// District-scoped officer list (user-added keywords; config keywords are tenant-wide)
policeRssKeywordSchema.index({ tenant_id: 1, districts: 1 });

module.exports = tenantModel('PoliceRssKeyword', policeRssKeywordSchema);