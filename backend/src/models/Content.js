const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const tenantModel = require('./tenantModel');
const { analysisStatusFields, applyAnalysisStatusIndexes } = require('./analysisStatusFields');
const contentSchema = new mongoose.Schema({
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
    required: false,
    ref: 'Source'
  },
  // District(s) this content belongs to — inherited from the Source it was
  // fetched from at ingestion. Drives per-district officer isolation the same
  // way Grievance/Source/POI carry districts. Empty for source-less content
  // (e.g. event/keyword-search) — such content is tenant-wide (admin-only view).
  districts: {
    type: [String],
    default: []
  },
  state: {
    type: String,
    default: ''
  },
  platform: {
    type: String,
    enum: ['youtube', 'x', 'instagram', 'facebook'],
    required: true
  },
  content_type: {
    type: String,
    enum: ['post', 'reel', 'story', 'highlight', 'video', 'tweet'],
    default: 'post'
  },
  content_id: {
    type: String,
    required: true
  },
  content_url: {
    type: String,
    required: true
  },
  text: {
    type: String,
    required: true,
    default: ''
  },
  scraped_content: {
    type: String
  },
  media: {
    type: [
      {
        type: { type: String, enum: ['photo', 'video', 'animated_gif'], default: 'photo' },
        url: String,
        video_url: String,
        preview: String,
        preview_url: String,
        // Original Instagram CDN URLs (kept for availability checks)
        original_url: { type: String, default: null },
        original_video_url: { type: String, default: null },
        original_preview: { type: String, default: null },
        original_preview_url: { type: String, default: null },
        // S3 permanent copies (survive CDN expiry / author deletion)
        s3_url: { type: String, default: null },
        s3_key: { type: String, default: null },
        s3_preview: { type: String, default: null },
        s3_preview_key: { type: String, default: null }
      }
    ],
    default: []
  },
  // Whether all media items have been archived to S3
  is_media_archived: {
    type: Boolean,
    default: false
  },
  // â”€â”€ Content Availability Tracking â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Whether the original post/reel/story has been deleted by the author
  is_deleted: {
    type: Boolean,
    default: false
  },
  deleted_at: {
    type: Date,
    default: null
  },
  // Whether the content has expired (e.g. Instagram stories after 24h)
  is_expired: {
    type: Boolean,
    default: false
  },
  expired_at: {
    type: Date,
    default: null
  },
  // Last time we checked if the original URL is still live
  last_availability_check: {
    type: Date,
    default: null
  },
  // Status of the content on the original platform
  availability_status: {
    type: String,
    enum: ['available', 'deleted', 'expired', 'unknown'],
    default: 'available'
  },
  is_repost: {
    type: Boolean,
    default: false
  },
  original_author: {
    type: String // For Reposts: The handle
  },
  original_author_name: {
    type: String
  },
  original_author_avatar: {
    type: String
  },
  quoted_content: {
    type: {
      text: String,
      author_name: String,
      author_handle: String,
      profile_image_url: String,
      media: [{
        type: { type: String, enum: ['photo', 'video', 'animated_gif'], default: 'photo' },
        url: String,
        video_url: String,
        preview: String,
        preview_url: String,
        original_url: { type: String, default: null },
        original_video_url: { type: String, default: null },
        original_preview: { type: String, default: null },
        original_preview_url: { type: String, default: null },
        s3_url: { type: String, default: null },
        s3_key: { type: String, default: null },
        s3_preview: { type: String, default: null },
        s3_preview_key: { type: String, default: null }
      }],
      created_at: Date
    },
    default: null
  },
  // URL Card Previews (link unfurling)
  url_cards: [{
    url: String,
    expanded_url: String,
    display_url: String,
    title: String,
    description: String,
    image: String
  }],
  author: {
    type: String,
    required: true
  },
  author_handle: {
    type: String,
    required: true
  },
  published_at: {
    type: Date,
    required: true
  },

  // Geotag / place info extracted from RapidAPI post payloads.
  // `name` is shown as a chip in the post UI; lat/lng/country are stored for
  // downstream map / analytics use.
  location: {
    type: {
      name: { type: String, default: null },
      address: { type: String, default: null },
      city: { type: String, default: null },
      country: { type: String, default: null },
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      place_id: { type: String, default: null },
      // Origin of the location data â€” tells the UI whether to label it
      // "Posted from" (precise geotag) or "Author location" (profile string).
      // Values: 'tweet_place' | 'tweet_coordinates' | 'author_profile' |
      //         'instagram_post' | 'facebook_place' | 'media_exif'
      source: { type: String, default: null }
    },
    default: null
  },

  // Whether the per-post geotag lookup has already run for this content.
  // Needed because "no location" and "not looked up yet" are otherwise
  // indistinguishable: most Instagram posts carry no geotag, so without this
  // the enrichment below would re-call the paid detail endpoint on every scan,
  // forever. Mirrors the status marker media_location already uses.
  location_checked: { type: Boolean, default: false },

  // Result of running every media item through the EXIF/GPS extraction
  // pipeline. Most social-media images have EXIF stripped so this will
  // typically settle at status='checked_no_gps'. When GPS *is* present we
  // also reverse-geocode to fill in name/city/country and copy the result
  // into the primary `location` field with source='media_exif'.
  // Status values:
  //   'pending'         â€” not yet processed
  //   'extracted'       â€” at least one media item had GPS
  //   'checked_no_gps'  â€” extraction ran but no GPS found
  //   'no_media'        â€” content has no images/videos to scan
  //   'failed'          â€” extraction errored (network, decode, etc.)
  media_location: {
    type: {
      status: { type: String, default: 'pending' },
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      name: { type: String, default: null },
      source_media_url: { type: String, default: null },
      checked_at: { type: Date, default: null },
      error: { type: String, default: null }
    },
    default: () => ({ status: 'pending' })
  },

  // Optional linkage for event-based monitoring
  event_ids: {
    type: [String],
    default: []
  },
  // Video Metadata
  duration: { type: String }, // ISO 8601 duration
  thumbnails: {
    default: { url: String, width: Number, height: Number },
    medium: { url: String, width: Number, height: Number },
    high: { url: String, width: Number, height: Number }
  },
  tags: [String],
  category_id: String,

  // Intelligence & Risk
  risk_score: { type: Number, default: 0 }, // 0-100
  risk_level: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'low'
  },
  threat_intent: { type: String }, // e.g. Violence, Political, Neutral
  threat_reasons: [String],        // e.g. ["Detected 'kill'", "Violence detected"]
  risk_factors: [{
    keyword: String,
    weight: Number,
    category: String,
    context: String
  }],
  sentiment: {
    type: String,
    enum: ['positive', 'neutral', 'negative'],
    default: 'neutral'
  },
  // Sentiment-service work tracking. `sentiment`/`risk_*` above hold defaults until
  // analysis_status is 'done' — read that, not the defaults, to know if it was analysed.
  ...analysisStatusFields,

  engagement: {
    views: { type: Number, default: 0 },
    likes: { type: Number, default: 0 },
    comments: { type: Number, default: 0 },
    retweets: { type: Number, default: 0 }
  },
  retweet_network: {
    last_synced_at: { type: Date, default: null },
    last_observed_retweet_count: { type: Number, default: 0 },
    unique_retweeter_count: { type: Number, default: 0 }
  },
  // Engagement History for Velocity Tracking
  engagement_history: [{
    timestamp: { type: Date, default: Date.now },
    views: Number,
    likes: Number,
    comments: Number
  }],
  raw_data: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  created_at: {
    type: Date,
    default: Date.now
  }
});

// NOTE: index will be migrated at runtime in backend/src/index.js (fixIndexes)
// Tenant-scoped uniqueness: the same public post (platform+content_id) can exist
// once PER TENANT, so each tenant monitoring an overlapping source keeps its own copy.
contentSchema.index({ tenant_id: 1, platform: 1, content_id: 1 }, { unique: true });
contentSchema.index({ content_id: 1 }); // Standalone for $expr lookups
contentSchema.index({ platform: 1, source_id: 1, published_at: -1 });
contentSchema.index({ platform: 1, source_id: 1, content_id: 1 });
contentSchema.index({ source_id: 1, id: 1 }); // category/source -> content id pre-resolution
contentSchema.index({ 'risk_factors.keyword': 1, id: 1 }); // keyword -> content id pre-resolution
contentSchema.index({ platform: 1, risk_level: 1 });
contentSchema.index({ source_id: 1, risk_level: 1 });
contentSchema.index({ platform: 1, content_type: 1, published_at: -1 });
contentSchema.index({ platform: 1, source_id: 1, content_type: 1, published_at: -1 });
contentSchema.index({ event_ids: 1, published_at: -1 }); // Event dashboard pagination
// District-scoped officer reads (content feeds/analytics): { tenant_id, districts: { $in } } sorted by published_at desc
contentSchema.index({ tenant_id: 1, districts: 1, published_at: -1 });
contentSchema.index({ is_deleted: 1 });
contentSchema.index({ published_at: -1 }); // General sort index for unfiltered listings
applyAnalysisStatusIndexes(contentSchema);

module.exports = tenantModel('Content', contentSchema);