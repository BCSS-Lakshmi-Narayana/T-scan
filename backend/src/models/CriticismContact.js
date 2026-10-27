const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const tenantModel = require('./tenantModel');
/**
 * CriticismContact Model
 * Stores contacts used for sharing criticism reports (police departments, officers etc.)
 */
const criticismContactSchema = new mongoose.Schema({
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
  name: {
    type: String,
    required: true
  },
  phone: {
    type: String,
    required: true
  },
  department: {
    type: String,
    default: ''
  },
  designation: {
    type: String,
    default: ''
  },
  is_active: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'criticism_contacts'
});

criticismContactSchema.index({ is_active: 1, name: 1 });

module.exports = tenantModel('CriticismContact', criticismContactSchema);