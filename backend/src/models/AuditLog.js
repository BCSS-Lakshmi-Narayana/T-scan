const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const tenantModel = require('./tenantModel');
const auditLogSchema = new mongoose.Schema({
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
  user_id: {
    type: String,
    required: true
  },
  user_email: {
    type: String,
    required: true
  },
  user_name: {
    type: String
  },
  action: {
    type: String,
    required: true
  },
  resource_type: {
    type: String,
    required: true
  },
  resource_id: {
    type: String
  },
  details: {
    type: mongoose.Schema.Types.Mixed
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
});

// Access Management > Login History reads this collection filtered by action and
// sorted newest-first, and the user list derives "last login" the same way.
auditLogSchema.index({ tenant_id: 1, action: 1, timestamp: -1 });

module.exports = tenantModel('AuditLog', auditLogSchema);