const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const influencerSchema = new mongoose.Schema(
  {
    id: { type: String, default: uuidv4, unique: true, required: true, index: true },
    name: { type: String, required: true },
    handle: String,
    platform: { type: String, enum: ['x', 'instagram', 'youtube', 'facebook', 'tiktok'] },
    followers_count: Number,
    category: [String],
    language: [String],
    location: String,
    rate_per_story: Number,
    rate_per_post: Number,
    rate_per_reel: Number,
    verified: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'inactive', 'blacklisted'], default: 'active' },
    profile_url: String,
    avatar_url: String,
    created_at: { type: Date, default: Date.now }
  },
  { collection: 'influencers' }
);

module.exports = mongoose.model('Influencer', influencerSchema);
