const mongoose = require('mongoose');

const tenantModel = require('./tenantModel');
const platformPolicySchema = new mongoose.Schema({
  tenant_id: {
    type: String,
    required: true,
    index: true
  },
    platform: {
        type: String,
        enum: ['x', 'youtube', 'instagram', 'general'],
        required: true
    },
    policy_name: {
        type: String,
        required: true
    },
    policy_id: {
        type: String,
        required: true,
        unique: true
    },
    description: {
        type: String,
        required: true
    },
    keywords: {
        type: [String],
        default: []
    },
    is_active: {
        type: Boolean,
        default: true
    },
    created_at: {
        type: Date,
        default: Date.now
    }
});

module.exports = tenantModel('PlatformPolicy', platformPolicySchema);