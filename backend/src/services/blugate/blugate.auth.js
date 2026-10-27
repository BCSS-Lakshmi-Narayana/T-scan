/**
 * Resolving a tenant's BluGate credentials.
 *
 * This is the only place credentials are read. They come from the single
 * BlugateConfig record in the tenant's own database — never from the
 * environment, so two tenants can never share a key and an unconfigured tenant
 * cannot quietly spend someone else's quota.
 *
 * One credential pair serves every platform; BluGate issues it per tenant, not
 * per platform. What IS per-platform is whether the tenant monitors that
 * platform at all, which the record carries as a set of flags.
 *
 * Callers do not pass a tenant id: the tenant is already in scope
 * (AsyncLocalStorage, see config/tenantContext), which is the same mechanism
 * every other model in this backend resolves through. Background work must wrap
 * itself in runWithTenant, exactly as it already does to read Sources or Alerts.
 */

const BlugateConfig = require('../../models/BlugateConfig');
const { decryptSecret } = require('../../utils/platformSecrets');
const { getTenantId } = require('../../config/tenantContext');

/**
 * Credentials are read on nearly every outbound call, so a short cache keeps a
 * monitoring cycle from re-reading the same record hundreds of times. It is
 * deliberately brief: a key rotated in Super Admin should take effect in
 * seconds, not on the next restart.
 */
const TTL_MS = Number(process.env.BLUGATE_CREDENTIALS_TTL_MS) || 60000;
const cache = new Map(); // tenantId -> { value, at }

/** Drop cached credentials so the next call re-reads the database. */
const invalidate = (tenantId = null) => {
  if (!tenantId) return cache.clear();
  cache.delete(tenantId);
};

const configError = (message) => {
  const err = new Error(message);
  err.status = 400;
  err.code = 'BLUGATE_NOT_CONFIGURED';
  return err;
};

/** The tenant's credential record, cached briefly. Throws if unusable. */
const loadConfig = async (label) => {
  const tenantId = getTenantId();
  if (!tenantId) {
    throw configError(
      `BluGate ${label}: no tenant in scope — background work must run inside runWithTenant()`
    );
  }

  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const row = await BlugateConfig.findOne({ tenant_id: tenantId }).lean();
  if (!row) {
    throw configError('BluGate is not configured for this tenant — add the API key and client code in Super Admin → BluGate Keys');
  }
  if (row.is_active === false) {
    throw configError('BluGate is disabled for this tenant');
  }

  const accessKey = decryptSecret(row.blugate_api_key);
  const clientId = decryptSecret(row.client_code);
  if (!accessKey) {
    throw configError('BluGate API key is missing or unreadable — re-enter it in Super Admin → BluGate Keys');
  }
  if (!clientId) {
    throw configError('BluGate client code is missing or unreadable — re-enter it in Super Admin → BluGate Keys');
  }

  const value = {
    auth: { accessKey, clientId },
    baseUrlOverride: String(row.base_url || '').trim(),
    platforms: row.platforms || {},
  };
  cache.set(tenantId, { value, at: Date.now() });
  return value;
};

/**
 * Credentials and gateway override for one platform, for the tenant in scope.
 *
 * Fails closed at every step — no record, disabled tenant, disabled platform, or
 * a credential that will not decrypt all raise rather than returning something
 * partial. Half a credential set would reach the gateway as an authentication
 * failure, which is far more confusing to debug than a message naming what is
 * missing.
 *
 * @param {'x'|'instagram'|'facebook'|'youtube'} slug
 * @param {string} label  platform name used in error messages
 * @returns {Promise<{auth: {accessKey: string, clientId: string}, baseUrlOverride: string}>}
 */
const getPlatformAuth = async (slug, label = slug) => {
  const config = await loadConfig(label);

  // The credential is shared; only the platform's own switch is per-platform.
  if (config.platforms[slug] === false) {
    throw configError(`BluGate ${label} is disabled for this tenant`);
  }

  return { auth: config.auth, baseUrlOverride: config.baseUrlOverride };
};

/** Whether this tenant can currently call that platform, without throwing. */
const isConfigured = async (slug) => {
  try {
    await getPlatformAuth(slug);
    return true;
  } catch (_) {
    return false;
  }
};

module.exports = { getPlatformAuth, isConfigured, invalidate };
