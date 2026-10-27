const mongoose = require('mongoose');

const tenantModel = require('./tenantModel');
const PolicyMappingSchema = new mongoose.Schema({
  tenant_id: {
    type: String,
    required: true,
    index: true
  },
    category_id: {
        type: String,
        required: true,
        trim: true
    },
    definition: {
        type: String,
        required: true,
        description: "Description used for LLM Prompt context"
    },
    legal_sections: [{
        id: String,
        code: String,
        title: String,
        url: String
    }],
    platform_policies: {
        type: Map,
        of: [{
            id: String,
            name: String,
            url: String
        }],
        default: {}
    },
    keywords: [{
        type: String,
        trim: true
    }],
    severity_level: {
        type: String,
        enum: ['Low', 'Medium', 'High'],
        default: 'Medium'
    },
    is_active: {
        type: Boolean,
        default: true
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
    districts: [{
        type: String,
        trim: true
    }],
    created_at: {
        type: Date,
        default: Date.now
    },
    updated_at: {
        type: Date,
        default: Date.now
    }
});

// Category ids are unique PER TENANT (not globally) — each police tenant owns its
// own set of policy/section mappings. (The legacy global `category_id_1` unique
// index is dropped by scripts/seed_policy_mappings.js.)
PolicyMappingSchema.index({ tenant_id: 1, category_id: 1 }, { unique: true });
// District-scoped officer list: { tenant_id, districts: { $in } } sorted by category_id asc
PolicyMappingSchema.index({ tenant_id: 1, districts: 1, category_id: 1 });

// Update timestamp on save
PolicyMappingSchema.pre('save', function (next) {
    this.updated_at = Date.now();
    next();
});

module.exports = tenantModel('PolicyMapping', PolicyMappingSchema);