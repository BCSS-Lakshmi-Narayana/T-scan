const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const tenantModel = require('./tenantModel');
const historyLogSchema = new mongoose.Schema({
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
  module: {
    type: String,
    required: true
  },
  action: {
    type: String,
    enum: ['create', 'update', 'delete'],
    required: true
  },
  record_id: {
    type: String
  },
  record_label: {
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
  performed_by_id: {
    type: String
  },
  performed_by_name: {
    type: String
  },
  performed_by_email: {
    type: String
  },
  performed_by_role: {
    type: String
  },
  changes: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  created_at: {
    type: Date,
    default: Date.now
  }
}, { collection: 'history_logs' });

historyLogSchema.index({ tenant_id: 1, created_at: -1 });
historyLogSchema.index({ tenant_id: 1, module: 1 });
historyLogSchema.index({ tenant_id: 1, action: 1 });
historyLogSchema.index({ tenant_id: 1, districts: 1 });
// District-scoped officer read: { tenant_id, districts: { $in } } sorted by created_at desc
historyLogSchema.index({ tenant_id: 1, districts: 1, created_at: -1 });

module.exports = tenantModel('HistoryLog', historyLogSchema);