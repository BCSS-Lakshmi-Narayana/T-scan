const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const tenantModel = require('./tenantModel');
const { analysisStatusFields, applyAnalysisStatusIndexes } = require('./analysisStatusFields');
const commentSchema = new mongoose.Schema({
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
    content_id: {
        type: String,
        required: true,
        ref: 'Content'
    },
    video_id: { // Direct reference for easier querying
        type: String,
        required: true
    },
    comment_id: { // YouTube Comment ID
        type: String,
        required: true,
        unique: true
    },
    author_channel_id: {
        type: String,
        required: true
    },
    author_display_name: {
        type: String,
        required: true
    },
    author_profile_image: {
        type: String
    },
    text: {
        type: String,
        required: true,
        default: ''
    },
    like_count: {
        type: Number,
        default: 0
    },
    published_at: {
        type: Date,
        required: true
    },
    updated_at: {
        type: Date
    },

    // Intelligence
    sentiment: {
        type: String,
        enum: ['positive', 'neutral', 'negative'],
        default: 'neutral'
    },
    threat_score: {
        type: Number,
        default: 0
    },
    is_threat: {
        type: Boolean,
        default: false
    },
    ...analysisStatusFields,

    // Structure
    parent_id: { // If reply, ID of parent comment
        type: String,
        default: null
    },

    created_at: {
        type: Date,
        default: Date.now
    }
});

commentSchema.index({ video_id: 1, published_at: -1 });
applyAnalysisStatusIndexes(commentSchema);

module.exports = tenantModel('Comment', commentSchema);