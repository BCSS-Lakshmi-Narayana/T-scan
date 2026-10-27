const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const tenantSchema = new mongoose.Schema(
  {
    id: { type: String, default: uuidv4, unique: true, required: true, index: true },
    slug: { type: String, unique: true, required: true, index: true },
    type: { type: String, enum: ['political', 'police'], required: true },
    name: { type: String, required: true },
    status: { type: String, enum: ['trial', 'active', 'suspended', 'terminated'], default: 'trial' },
    plan: { type: String, enum: ['starter', 'professional', 'enterprise'], default: 'starter' },
    // The host this tenant answers on, matched against the request's Host header
    // before any subdomain rule is tried (see middleware/tenantMiddleware.js).
    // Empty means "resolve me by subdomain slug", which is what every tenant did
    // before this field existed.
    //
    // Store the hostname only — no scheme, no port, no path ("hydpolice.saga.in",
    // not "https://hydpolice.saga.in:8001"). Matching is case-insensitive and the
    // port is stripped from the request before comparing, so a value with a port
    // in it would simply never match.
    //
    // Set it to "localhost" to point local development at this tenant without
    // touching any config: the request host on localhost is exactly that, so this
    // tenant wins over DEFAULT_TENANT_SLUG.
    domain: { type: String, default: '', trim: true, lowercase: true, index: true },
    // Which database holds this tenant's data. Left empty it is derived from the
    // slug (config/tenantConnections.dbNameFor); set explicitly, a tenant can be
    // moved without a code change. Ignored while TENANT_DB_MODE is "shared".
    db_name: { type: String, default: '' },
    // Stamped once the tenant's own database has collections and indexes built.
    db_provisioned_at: { type: Date },

    client_name: String,
    client_email: String,
    client_phone: String,
    admin_user_id: String,

    branding: {
      app_name: String,
      tagline: String,
      logo_url: String,
      politician_photo_url: String,
      favicon_url: String,
      primary_color: { type: String, default: '#FF6B00' },
      secondary_color: String,
      accent_color: String,
      dark_mode_default: { type: Boolean, default: false }
    },

    political_config: {
      politician_name: String,
      party_name: String,
      party_logo_url: String,
      constituency: String,
      state: String,
      monitoring_languages: [String],
      default_keywords: [String],
      location_keywords: [String],
      ai_context: String
    },

    police_config: {
      department_name: String,
      department_aliases: [String],
      state: String,
      districts: [String],
      commandant_name: String,
      jurisdiction_type: String,
      ai_context: String
    },

    location_config: {
      region_type: { type: String, enum: ['state', 'district', 'constituency', 'custom'] },
      region_name: String,
      country: { type: String, default: 'India' },
      state_name: String,
      state_code: String,
      geojson_url: String,
      geojson_local_file: String,
      city_to_district_map: mongoose.Schema.Types.Mixed,
      districts: [String],
      constituencies: [String],
      assembly_segments: [{ name: String, district: String, aliases: [String] }],
      generic_location_terms: [String],
      primary_locations: [String],
      secondary_locations: [String]
    },

    ai_config: {
      model: { type: String, default: 'gpt-4' },
      temperature: { type: Number, default: 0.7 },
      max_tokens: { type: Number, default: 2000 },
      system_prompt: String,
      sentiment_context: String,
      analysis_focus_areas: [String],
      entity_recognition_context: String,
      // Per-tenant LLM classification prompt (configured in Super Admin → AI Prompts).
      // When set (non-empty), it REPLACES the built-in default prompt. Supports
      // {{CATEGORIES}}, {{CATEGORY_DEFINITIONS}}, {{CONTENT}} placeholders filled at
      // runtime (see promptTemplateService). Empty = use the built-in default.
      classification_prompt: String
    },

    feature_flags: {
      enable_location_tagging: { type: Boolean, default: true },
      enable_ai_analysis: { type: Boolean, default: true },
      enable_sentiment_analysis: { type: Boolean, default: true },
      enable_map_visualization: { type: Boolean, default: true },
      enable_grievance_workflow: { type: Boolean, default: true },
      enable_real_time_alerts: { type: Boolean, default: true },
      enable_report_generation: { type: Boolean, default: true },
      enable_media_transcription: { type: Boolean, default: true }
    },

    onboarding: {
      wizard_completed: { type: Boolean, default: false },
      branding_set: { type: Boolean, default: false },
      location_set: { type: Boolean, default: false },
      ai_set: { type: Boolean, default: false },
      first_login_done: { type: Boolean, default: false },
      tutorials_dismissed: [String]
    },

    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },
    trial_ends_at: Date
  },
  { collection: 'tenants' }
);

tenantSchema.pre('save', function (next) {
  this.updated_at = Date.now();
  next();
});

// ── Cache invalidation ──────────────────────────────────────────────────────
// Tenant documents are read on every request through slim, cached lookups
// (services/tenantLookupService). Invalidating here rather than at each of the
// write sites means a status change, a suspension or a domain edit can never be
// served stale because one call site forgot.
// Required lazily: that service requires this model, so a top-level import
// would be circular.
const invalidateTenantCaches = (doc) => {
  if (!doc) return;
  try { require('../services/tenantLookupService').invalidateTenant(doc); } catch (_) { /* non-fatal */ }
};

tenantSchema.post('save', function (doc) { invalidateTenantCaches(doc); });
tenantSchema.post('findOneAndUpdate', function (doc) { invalidateTenantCaches(doc); });
tenantSchema.post('findOneAndDelete', function (doc) { invalidateTenantCaches(doc); });
// updateOne/updateMany yield a write result, not the document, so there is no
// id/slug to target — clear everything. These are rare (bulk admin edits, and
// the db_name stamp at the end of provisioning).
tenantSchema.post(['updateOne', 'updateMany', 'deleteOne', 'deleteMany'], function () {
  try { require('../services/tenantLookupService').invalidateTenant(); } catch (_) { /* non-fatal */ }
});

// ── Product scoping ─────────────────────────────────────────────────────────
// The tenant registry is one collection shared by every Saga product and the
// Super Admin, so this collection holds political and state tenants too. This
// app owns only police tenants, and nothing here should ever see the others:
// tenantMiddleware resolves a request by slug alone, so an unscoped lookup would
// happily resolve another product's tenant and serve its data through this app.
//
// Scoping the model rather than the ~25 call sites means a query added later is
// scoped by default instead of by remembering to. An explicit `type` in a query
// still wins, so a deliberate cross-product lookup remains possible.
const OWNED_TYPES = ['police'];

function scopeToOwnedTypes(next) {
  const query = this.getQuery();
  if (query.type === undefined) this.where({ type: { $in: OWNED_TYPES } });
  next();
}

// Query middleware only — document middleware ('save', document.deleteOne) acts
// on a record this app already loaded through a scoped query.
for (const op of ['find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace',
  'countDocuments', 'distinct', 'updateOne', 'updateMany', 'replaceOne']) {
  tenantSchema.pre(op, scopeToOwnedTypes);
}
for (const op of ['deleteOne', 'deleteMany']) {
  tenantSchema.pre(op, { query: true, document: false }, scopeToOwnedTypes);
}

// Aggregation does not go through query middleware, so it needs its own guard:
// prepend a $match stage unless the pipeline already filters on type itself.
tenantSchema.pre('aggregate', function (next) {
  const pipeline = this.pipeline();
  const alreadyScoped = pipeline.some((stage) => stage && stage.$match && stage.$match.type !== undefined);
  if (!alreadyScoped) pipeline.unshift({ $match: { type: { $in: OWNED_TYPES } } });
  next();
});

// estimatedDocumentCount() reads collection metadata and accepts no filter, so
// there is no way to scope it — it would report every product's tenants as this
// one's. Refuse rather than answer wrongly; countDocuments() is scoped and is
// what a caller actually wants on a shared registry.
tenantSchema.statics.estimatedDocumentCount = function estimatedDocumentCount() {
  throw new Error(
    '[Tenant] estimatedDocumentCount() cannot be scoped to a product — it would count ' +
    'every tenant in the shared registry, not just ' + OWNED_TYPES.join('/') + '. Use countDocuments() instead.'
  );
};

module.exports = mongoose.model('Tenant', tenantSchema);
module.exports.OWNED_TYPES = OWNED_TYPES;
