const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const tenantModel = require('./tenantModel');
const keywordSchema = new mongoose.Schema({
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
  keyword: {
    type: String,
    required: true
  },
  category: {
    type: String,
    enum: ['violence', 'threat', 'hate', 'other'],
    required: true
  },
  language: {
    type: String,
    enum: ['en', 'hi', 'te', 'all'],
    default: 'en'
  },
  is_active: {
    type: Boolean,
    default: true
  },
  weight: {
    type: Number,
    default: 50
  },
  created_by: {
    type: String,
    default: ''
  },
  updated_by: {
    type: String,
    default: ''
  },
  state: {
    type: String,
    default: ''
  },
  districts: {
    type: [String],
    default: []
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

// Keyword uniqueness is PER TENANT (not global) — two tenants may use the same
// keyword. Requires dropping the legacy global `keyword_1` unique index (see
// scripts/migrate-keyword-tenant-unique-index.js).
keywordSchema.index({ tenant_id: 1, keyword: 1 }, { unique: true });
keywordSchema.index({ tenant_id: 1, category: 1 }); // tenant + category filter
// District-scoped officer list
keywordSchema.index({ tenant_id: 1, districts: 1 });

module.exports = tenantModel('Keyword', keywordSchema);