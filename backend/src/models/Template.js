const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const tenantModel = require('./tenantModel');
const templateSchema = new mongoose.Schema({
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
    platform: {
        type: String,
        enum: ['x', 'youtube', 'facebook', 'instagram', 'all'],
        default: 'all'
    },
    state: {
        type: String,
        default: ''
    },
    districts: {
        type: [String],
        default: []
    },
    html_content: {
        type: String,
        required: true
    },
    is_default: {
        type: Boolean,
        default: false
    },
    created_by: {
        type: String,
        ref: 'User'
    },
    updated_by: {
        type: String,
        default: ''
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

templateSchema.index({ districts: 1 });
// District-scoped officer list: { tenant_id, districts: { $in } } sorted by created_at desc
templateSchema.index({ tenant_id: 1, districts: 1, created_at: -1 });

module.exports = tenantModel('Template', templateSchema);