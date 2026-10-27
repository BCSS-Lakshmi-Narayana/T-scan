const Settings = require('../models/Settings');

/**
 * Per-district settings resolution.
 *
 * A tenant has one DEFAULT settings document (district: '') owned by the State
 * Admin, plus optional per-district overrides (district: 'Hyderabad') owned by
 * that district's officer. Resolution is always:
 *
 *      district override  ->  else the tenant default
 *
 * so a district that has never customised anything transparently follows the
 * state-wide configuration, and existing single-doc tenants keep working.
 *
 * Used by the analysis pipeline so a piece of content is scored against the
 * thresholds of the district it belongs to.
 */

// Short-lived cache so a monitoring sweep doesn't re-query settings per item.
// Keyed by `${tenantId}::${district}`.
const CACHE_TTL_MS = 30 * 1000;
const _cache = new Map();

const cacheKey = (tenantId, district) => `${tenantId || ''}::${district || ''}`;

const invalidate = (tenantId, district) => {
  if (!tenantId) { _cache.clear(); return; }
  if (district === undefined) {
    // Drop every entry for this tenant (default + all district overrides).
    for (const key of _cache.keys()) {
      if (key.startsWith(`${tenantId}::`)) _cache.delete(key);
    }
    return;
  }
  _cache.delete(cacheKey(tenantId, district));
};

/**
 * Resolve the settings document that applies to `district` within `tenantId`.
 * Falls back to the tenant default when the district has no override.
 * @returns {Promise<object|null>} lean settings doc, or null if the tenant has none yet
 */
const getSettingsForDistrict = async (tenantId, district = '') => {
  if (!tenantId) return null;
  const normalized = String(district || '').trim();
  const key = cacheKey(tenantId, normalized);

  const hit = _cache.get(key);
  if (hit && (Date.now() - hit.time) < CACHE_TTL_MS) return hit.doc;

  let doc = null;
  if (normalized) {
    doc = await Settings.findOne({ tenant_id: tenantId, district: normalized }).lean();
  }
  if (!doc) {
    doc = await Settings.findOne({ tenant_id: tenantId, district: '' }).lean();
  }

  _cache.set(key, { doc, time: Date.now() });
  return doc;
};

/**
 * Resolve settings for a piece of content/source that may carry several
 * districts. Uses the first district that has its own override; otherwise the
 * tenant default. (In practice content carries a single district.)
 */
const getSettingsForDistricts = async (tenantId, districts = []) => {
  const list = Array.isArray(districts) ? districts.filter(Boolean) : [];
  if (!list.length) return getSettingsForDistrict(tenantId, '');

  for (const d of list) {
    const doc = await Settings.findOne({ tenant_id: tenantId, district: String(d).trim() }).lean();
    if (doc) return doc;
  }
  return getSettingsForDistrict(tenantId, '');
};

module.exports = { getSettingsForDistrict, getSettingsForDistricts, invalidate };
