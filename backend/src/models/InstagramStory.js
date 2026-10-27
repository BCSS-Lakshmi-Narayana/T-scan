const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const tenantModel = require('./tenantModel');
const instagramStorySchema = new mongoose.Schema({
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
  source_id: {
    type: String,
    ref: 'Source'
  },
  // Instagram story PK / unique identifier from API
  story_pk: {
    type: String,
    required: true
  },
  author: {
    type: String,
    required: true
  },
  author_handle: {
    type: String,
    required: true
  },
  author_avatar: {
    type: String
  },
  // Media type: 'image' or 'video'
  media_type: {
    type: String,
    enum: ['image', 'video'],
    default: 'image'
  },
  // Original media URL from Instagram CDN (may expire)
  original_url: {
    type: String,
    required: true
  },
  // S3 archived URL (persistent)
  s3_url: {
    type: String,
    default: null
  },
  s3_key: {
    type: String,
    default: null
  },
  // Thumbnail / preview image
  thumbnail_url: {
    type: String
  },
  s3_thumbnail_url: {
    type: String,
    default: null
  },
  s3_thumbnail_key: {
    type: String,
    default: null
  },
  // Fast query flag for captured-story filters.
  has_s3_media: {
    type: Boolean,
    default: false
  },
  // Video-specific
  video_duration: {
    type: Number, // seconds
    default: null
  },
  video_versions: [{
    url: String,
    width: Number,
    height: Number,
    type: String
  }],
  // Story lifecycle
  published_at: {
    type: Date,
    required: true
  },
  expires_at: {
    type: Date,
    required: true
  },
  // Whether the story has been viewed by the system
  viewed: {
    type: Boolean,
    default: false
  },
  viewed_at: {
    type: Date,
    default: null
  },
  // Whether original CDN link is still accessible
  is_available: {
    type: Boolean,
    default: true
  },
  // Time when we detected the story was deleted (if before expiry)
  deleted_at: {
    type: Date,
    default: null
  },
  // Whether archived to S3
  is_archived: {
    type: Boolean,
    default: false
  },
  // Last time the original URL was checked for availability
  last_availability_check: {
    type: Date,
    default: null
  },
  // Raw API response data (for debugging / re-processing)
  raw_data: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  // Metadata
  width: Number,
  height: Number,
  caption: String,
  // Risk analysis
  risk_score: {
    type: Number,
    default: 0
  },
  risk_level: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'low'
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

// Indexes
instagramStorySchema.index({ source_id: 1, published_at: -1 });
instagramStorySchema.index({ story_pk: 1 }, { unique: true });
instagramStorySchema.index({ author_handle: 1, published_at: -1 });
instagramStorySchema.index({ expires_at: 1 });
instagramStorySchema.index({ is_available: 1 });
instagramStorySchema.index({ is_archived: 1 });
instagramStorySchema.index({ has_s3_media: 1, published_at: -1 });
instagramStorySchema.index({ is_available: 1, expires_at: 1, published_at: -1 });
instagramStorySchema.index({ source_id: 1, has_s3_media: 1, published_at: -1 });
instagramStorySchema.index({ author_handle: 1, has_s3_media: 1, published_at: -1 });

// Auto-update updated_at
instagramStorySchema.pre('save', function (next) {
  const hasMain = typeof this.s3_url === 'string' && this.s3_url.trim().length > 0;
  const hasThumb = typeof this.s3_thumbnail_url === 'string' && this.s3_thumbnail_url.trim().length > 0;
  this.has_s3_media = hasMain || hasThumb;
  this.updated_at = Date.now();
  next();
});

module.exports = tenantModel('InstagramStory', instagramStorySchema);