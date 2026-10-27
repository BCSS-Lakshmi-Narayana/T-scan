const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const tenantModel = require('./tenantModel');
// Single active session for a District Officer (role 'level-1'). Populated only
// for enforced roles; null/absent for admins and superadmins. `_id: false` — it
// is a plain embedded record, not its own document.
const activeSessionSchema = new mongoose.Schema({
  session_id: { type: String, default: null },      // also embedded in the JWT as `sid`
  device: { type: String, default: '' },            // "Chrome on Windows" (best-effort UA parse)
  user_agent: { type: String, default: '' },        // raw UA (truncated), for support/audit
  ip: { type: String, default: '' },
  login_at: { type: Date, default: null },
  last_active_at: { type: Date, default: null },
  expires_at: { type: Date, default: null },         // mirrors the access-token 24h lifetime
}, { _id: false });

// Per-officer monitoring VOLUME caps, set by the State Admin in Access Management
// (District Officers / role 'level-1' only; admins are exempt). These ration the
// shared social-API quota: an officer may STAGE any number of monitoring profiles
// but only a capped number may be ACTIVE (fetching) per platform, plus caps on
// actively-monitored manual events and keywords per event. `null`/absent on a
// field means "use the system default" (see utils/monitoringLimits.js) — so
// existing officers and un-configured officers keep working with generous
// defaults, never a hard break.
const monitoringLimitsSchema = new mongoose.Schema({
  per_platform: {
    x: { type: Number, default: null, min: 0 },
    instagram: { type: Number, default: null, min: 0 },
    facebook: { type: Number, default: null, min: 0 },
    youtube: { type: Number, default: null, min: 0 },
  },
  max_active_events: { type: Number, default: null, min: 0 },
  max_keywords_per_event: { type: Number, default: null, min: 0 },
}, { _id: false });

const userSchema = new mongoose.Schema({
  id: {
    type: String,
    default: uuidv4,
    unique: true
  },
  email: {
    type: String,
    required: true,
    unique: true
  },
  password: {
    type: String,
    required: true
  },
  full_name: {
    type: String,
    required: true
  },
  role: {
    type: String,
    enum: ['superadmin', 'admin', 'level-1'],
    default: 'level-1'
  },
  tenant_id: {
    type: String,
    index: true
  },
  // State + districts this officer is scoped to, from the tenant's assignment
  // (police_config.state / police_config.districts). Blank for admins, who see
  // the whole tenant.
  state: {
    type: String,
    default: ''
  },
  districts: {
    type: [String],
    default: []
  },
  is_active: {
    type: Boolean,
    default: true
  },
  // id of the User who created this account (via the admin-facing "New Officer" /
  // Access Management flow). Blank for the tenant's original onboarding admin.
  created_by: {
    type: String,
    default: ''
  },
  updated_by: {
    type: String,
    default: ''
  },
  updated_at: {
    type: Date,
    default: Date.now
  },
  refreshToken: {
    type: String,
    default: ''
  },
  refreshTokenExpiresAt: {
    type: Date
  },
  passwordResetToken: {
    type: String,
    default: null
  },
  passwordResetExpires: {
    type: Date,
    default: null
  },
  passwordChangedAt: {
    type: Date
  },
  // The user's single active session (District Officers only). `select: false`
  // keeps it OUT of every normal query result by default — so it can never leak
  // through getMe, admin user-lists, or any existing controller. The three
  // places that genuinely need it (login, the refresh flow, and the auth
  // middlewares) opt in explicitly with `.select('+active_session')`.
  active_session: {
    type: activeSessionSchema,
    default: null,
    select: false
  },
  // Per-officer monitoring volume caps (District Officers only). Additive and
  // optional — absent means "use system defaults", so nothing existing breaks.
  monitoring_limits: {
    type: monitoringLimitsSchema,
    default: null
  },
  created_at: {
    type: Date,
    default: Date.now
  }
});

module.exports = tenantModel('User', userSchema);