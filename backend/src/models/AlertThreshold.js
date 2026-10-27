const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const tenantModel = require('./tenantModel');
const alertThresholdSchema = new mongoose.Schema({
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
        // Uniqueness is PER TENANT (compound index below), not global — otherwise
        // only one tenant could ever own a given platform's threshold.
    },
    // Unified thresholds - applies to ALL metrics (likes, retweets, comments, views)
    low_threshold: {
        type: Number,
        default: 100
    },
    medium_threshold: {
        type: Number,
        default: 500
    },
    high_threshold: {
        type: Number,
        default: 1000
    },
    // Time window in minutes - alert if post reaches threshold within this time from posting
    time_window_minutes: {
        type: Number,
        default: 60
    },
    is_active: {
        type: Boolean,
        default: true
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

// One threshold per platform PER TENANT.
alertThresholdSchema.index({ tenant_id: 1, platform: 1 }, { unique: true });

module.exports = tenantModel('AlertThreshold', alertThresholdSchema);