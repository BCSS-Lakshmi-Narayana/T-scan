const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const tenantModel = require('./tenantModel');
const retweetRelationshipSchema = new mongoose.Schema(
  {
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
      default: 'x',
      enum: ['x']
    },
    source_id: {
      type: String,
      required: true,
      ref: 'Source'
    },
    source_identifier: {
      type: String,
      required: true
    },
    source_display_name: {
      type: String
    },
    source_category: {
      type: String,
      default: 'unknown'
    },
    original_tweet_id: {
      type: String,
      required: true
    },
    content_ref_id: {
      type: String,
      default: null
    },
    original_author_handle: {
      type: String,
      required: true
    },
    original_author_name: {
      type: String,
      default: null
    },
    retweeter_id: {
      type: String,
      default: null
    },
    retweeter_handle: {
      type: String,
      required: true
    },
    retweeter_name: {
      type: String,
      default: null
    },
    retweeter_avatar: {
      type: String,
      default: null
    },
    retweeter_verified: {
      type: Boolean,
      default: false
    },
    first_seen_at: {
      type: Date,
      default: Date.now
    },
    last_seen_at: {
      type: Date,
      default: Date.now
    },
    last_retweeted_at: {
      type: Date,
      default: null
    },
    observation_count: {
      type: Number,
      default: 1
    }
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: 'updated_at'
    }
  }
);

retweetRelationshipSchema.index(
  { source_id: 1, original_tweet_id: 1, retweeter_handle: 1 },
  { unique: true }
);
// Optimized indexes for summary queries (top retweeters / by tweet) with minimal overlap
retweetRelationshipSchema.index({ source_id: 1, platform: 1, last_seen_at: -1, retweeter_handle: 1 });
retweetRelationshipSchema.index({ source_id: 1, platform: 1, last_seen_at: -1, original_tweet_id: 1 });
// Targeted lifetime lookup by handle set
retweetRelationshipSchema.index({ source_id: 1, platform: 1, retweeter_handle: 1, original_tweet_id: 1 });

module.exports = tenantModel('RetweetRelationship', retweetRelationshipSchema);