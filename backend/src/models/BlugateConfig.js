const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const tenantModel = require('./tenantModel');

/**
 * A tenant's BluGate credentials — one record per tenant.
 *
 * BluGate issues each tenant a single API key and client code, and the same pair
 * authenticates every platform (X, Instagram, Facebook, YouTube). The gateway
 * meters that tenant's usage centrally, so there is nothing per-platform about
 * the credential itself.
 *
 * This is a tenantModel, so the record lives in the tenant's OWN database
 * (police_tenant_<slug> under TENANT_DB_MODE=per-tenant). That is the isolation:
 * one tenant's key is only reachable from inside that tenant's scope, and there
 * is no shared collection where one tenant could read another's.
 *
 * Credentials are never read from the environment. An env fallback would let an
 * unconfigured tenant quietly spend another tenant's quota, which is exactly what
 * per-tenant keys exist to prevent — so a missing record fails closed.
 *
 * Exactly one document per tenant: `tenant_id` is uniquely indexed, and the
 * controller upserts on it rather than creating rows.
 */

const blugateConfigSchema = new mongoose.Schema(
  {
    id: { type: String, default: uuidv4, unique: true, required: true, index: true },
    tenant_id: { type: String, required: true, unique: true, index: true },

    // AES-256-GCM ciphertext — see utils/platformSecrets. Never returned to a
    // client; responses carry *_set / *_invalid booleans instead.
    blugate_api_key: { type: String, default: null },
    client_code: { type: String, default: null },

    // Optional per-tenant gateway override. Normally blank, so the base URL comes
    // from configuration shared by all tenants. Exists so one tenant can be pointed
    // at a different BluGate deployment (staging, a regional instance) without a
    // code change or redeploy.
    base_url: { type: String, default: '' },

    // Which platforms this tenant actually monitors. The credential is shared, but
    // a tenant that does not use YouTube should not have YouTube scans attempted —
    // disabling here makes those calls fail closed instead of burning quota.
    platforms: {
      x: { type: Boolean, default: true },
      instagram: { type: Boolean, default: true },
      facebook: { type: Boolean, default: true },
      youtube: { type: Boolean, default: true },
    },

    // Master switch: turns off every platform without discarding the credential.
    is_active: { type: Boolean, default: true },

    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },
  },
  { collection: 'blugate_config' }
);

blugateConfigSchema.pre('save', function (next) {
  this.updated_at = Date.now();
  next();
});

// Exported bare. Nothing may be assigned onto this: it is a Proxy that resolves
// the tenant's connection on every property access, so even a harmless-looking
// `module.exports.X = …` would try to resolve one at require time, when no tenant
// is in scope. The list of supported platforms lives in the endpoint catalogue
// (services/blugate/blugate.endpoints), which is its single source of truth.
module.exports = tenantModel('BlugateConfig', blugateConfigSchema);
