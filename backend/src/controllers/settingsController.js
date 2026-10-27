const Settings = require('../models/Settings');
const { createAuditLog } = require('../services/auditService');
const { requestedDistrictFrom, scopedDistrictQuery } = require('../utils/scopedDistricts');
const settingsResolver = require('../services/settingsResolver');

// In-memory cache for settings (avoids DB round-trip on every GET).
// Keyed per tenant AND district — a district officer and the State Admin must
// never be served each other's configuration from the cache.
const _settingsCache = new Map(); // `${tenantId}::${district}` -> { doc, time }
const SETTINGS_CACHE_TTL = 30000; // 30 seconds

const settingsCacheKey = (tenantId, district) => `${tenantId || ''}::${district || ''}`;

const invalidateSettingsCache = (tenantId, district) => {
  if (!tenantId) { _settingsCache.clear(); settingsResolver.invalidate(); return; }
  if (district === undefined) {
    for (const key of _settingsCache.keys()) {
      if (key.startsWith(`${tenantId}::`)) _settingsCache.delete(key);
    }
  } else {
    _settingsCache.delete(settingsCacheKey(tenantId, district));
  }
  settingsResolver.invalidate(tenantId, district);
};

/**
 * Which settings document this caller owns / is viewing.
 *   admin   -> the globally-selected district (navbar) if set, else '' = the
 *              tenant-wide DEFAULT that every district inherits.
 *   officer -> their OWN district. An officer can never read or write another
 *              district's configuration, nor the tenant default.
 * Returns '' for the tenant default.
 */
const effectiveSettingsDistrict = (req) => {
  const requested = requestedDistrictFrom(req);
  if (req.user?.role === 'admin') return requested || '';

  const own = req.user?.districts || [];
  if (!own.length) return '';
  // Honour an explicit selection only when it's one of the officer's own.
  if (requested && own.includes(requested)) return requested;
  return own[0];
};

// @desc    Get settings
// @route   GET /api/settings
// @access  Private
const getSettings = async (req, res) => {
  try {
    // Per tenant AND district — see effectiveSettingsDistrict.
    const district = effectiveSettingsDistrict(req);
    const _cached = _settingsCache.get(settingsCacheKey(req.tenantId, district));
    if (_cached && (Date.now() - _cached.time) < SETTINGS_CACHE_TTL) {
      return res.status(200).json(_cached.doc);
    }

    // District override if this district has customised anything, else the
    // tenant-wide default (so a district inherits state config until it edits).
    let settings = await settingsResolver.getSettingsForDistrict(req.tenantId, district);

    if (!settings) {
      const created = await Settings.create({ tenant_id: req.tenantId, district: '' });
      settings = created.toObject();
      invalidateSettingsCache(req.tenantId);
    }

    // Ensure UI-facing fields are present even for older docs
    const doc = settings;
    if (doc.risk_threshold_high === undefined) doc.risk_threshold_high = doc.high_risk_threshold ?? 70;
    if (doc.risk_threshold_medium === undefined) doc.risk_threshold_medium = doc.medium_risk_threshold ?? 40;
    if (doc.monitoring_interval_minutes === undefined) doc.monitoring_interval_minutes = 5;

    // Ensure api_config defaults for older docs
    const CATEGORIES = ['political', 'communal', 'trouble_makers', 'defamation', 'narcotics', 'history_sheeters', 'others'];
    const defaultCategoryFreqs = {};
    for (const c of CATEGORIES) defaultCategoryFreqs[c] = 60;

    const defaultApiConfig = {
      monitoring: {
        enabled: true,
        frequencies: {
          x: { ...defaultCategoryFreqs },
          instagram: { ...defaultCategoryFreqs },
          facebook: { ...defaultCategoryFreqs },
          youtube: { ...defaultCategoryFreqs }
        }
      },
      events: { x: 60, instagram: 60, facebook: 60, youtube: 60, enabled: true },
      grievances: { x: 60, facebook: 60, enabled: true }
    };
    if (!doc.api_config) {
      doc.api_config = defaultApiConfig;
    } else {
      // Migrate old flat monitoring → new frequencies structure
      if (!doc.api_config.monitoring) {
        doc.api_config.monitoring = defaultApiConfig.monitoring;
      } else {
        if (doc.api_config.monitoring.enabled === undefined) doc.api_config.monitoring.enabled = true;
        if (!doc.api_config.monitoring.frequencies) {
          doc.api_config.monitoring.frequencies = defaultApiConfig.monitoring.frequencies;
        } else {
          for (const plat of ['x', 'instagram', 'facebook', 'youtube']) {
            if (!doc.api_config.monitoring.frequencies[plat]) {
              doc.api_config.monitoring.frequencies[plat] = { ...defaultCategoryFreqs };
            } else {
              for (const cat of CATEGORIES) {
                if (doc.api_config.monitoring.frequencies[plat][cat] === undefined) {
                  doc.api_config.monitoring.frequencies[plat][cat] = 60;
                }
              }
            }
          }
        }
      }
      for (const mod of ['events', 'grievances']) {
        if (!doc.api_config[mod]) {
          doc.api_config[mod] = defaultApiConfig[mod];
        } else {
          for (const key of Object.keys(defaultApiConfig[mod])) {
            if (doc.api_config[mod][key] === undefined) {
              doc.api_config[mod][key] = defaultApiConfig[mod][key];
            }
          }
        }
      }
    }

    // Cache the built response (per tenant + district)
    _settingsCache.set(settingsCacheKey(req.tenantId, district), { doc, time: Date.now() });

    res.status(200).json(doc);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update settings
// @route   PUT /api/settings
// @access  Private (Admin/Analyst only)
const updateSettings = async (req, res) => {
  try {
    // 'admin' is the tenant's full-access role (per rbacMiddleware) and edits the
    // tenant default (or a selected district). 'level-1' officers may edit ONLY
    // their own district's configuration — enforced by effectiveSettingsDistrict
    // below, which never returns another district for an officer.
    if (!['superadmin', 'admin', 'analyst', 'level-1'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Insufficient permissions' });
    }

    const district = effectiveSettingsDistrict(req);

    // An officer must always write to a district document, never the tenant-wide
    // default — otherwise their edit would change configuration for every district.
    if (req.user.role === 'level-1' && !district) {
      return res.status(403).json({ message: 'No district assigned — cannot edit configuration' });
    }

    const updateDoc = { ...req.body, updated_at: new Date() };

    // Never let the request body reassign identity / tenant ownership or hop to
    // another district. The doc is always located by req.tenantId + the resolved
    // district; these must not be overwritten (defense-in-depth — matters for the
    // super-admin delegated update path too).
    delete updateDoc.tenant_id;
    delete updateDoc._id;
    delete updateDoc.id;
    delete updateDoc.district;

    // Normalize threshold field names (UI uses risk_threshold_*; backend uses *_risk_threshold)
    if (updateDoc.risk_threshold_high !== undefined) {
      updateDoc.high_risk_threshold = updateDoc.risk_threshold_high;
    }
    if (updateDoc.risk_threshold_medium !== undefined) {
      updateDoc.medium_risk_threshold = updateDoc.risk_threshold_medium;
    }

    // Also keep UI fields aligned if backend fields are provided
    if (updateDoc.high_risk_threshold !== undefined && updateDoc.risk_threshold_high === undefined) {
      updateDoc.risk_threshold_high = updateDoc.high_risk_threshold;
    }
    if (updateDoc.medium_risk_threshold !== undefined && updateDoc.risk_threshold_medium === undefined) {
      updateDoc.risk_threshold_medium = updateDoc.medium_risk_threshold;
    }

    // Upsert the (tenant, district) document. The first time a district saves,
    // this creates its override; before that the district inherited the default.
    const settings = await Settings.findOneAndUpdate(
      { tenant_id: req.tenantId, district },
      { $set: updateDoc, $setOnInsert: { tenant_id: req.tenantId, district } },
      { new: true, upsert: true }
    );

    // Invalidate every cached view for this tenant: a change to the tenant default
    // also changes what districts without an override resolve to.
    invalidateSettingsCache(req.tenantId);

    await createAuditLog(req.user, 'update', 'settings', district || 'tenant_default', updateDoc);

    res.status(200).json(settings);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all settings page data in one call (settings + keywords + thresholds + templates)
// @route   GET /api/settings/all
// @access  Private
const getAllSettingsData = async (req, res) => {
  try {
    const Keyword = require('../models/Keyword');
    const AlertThreshold = require('../models/AlertThreshold');
    const Template = require('../models/Template');

    // Same per-tenant + per-district scoping as getSettings.
    const district = effectiveSettingsDistrict(req);

    // If settings cache is fresh, use it; otherwise fetch from DB
    let settingsDoc;
    const _cachedAll = _settingsCache.get(settingsCacheKey(req.tenantId, district));
    if (_cachedAll && (Date.now() - _cachedAll.time) < SETTINGS_CACHE_TTL) {
      settingsDoc = _cachedAll.doc;
    } else {
      // Fetch settings and build the doc (same logic as getSettings)
      let settings = await settingsResolver.getSettingsForDistrict(req.tenantId, district);
      if (!settings) {
        const created = await Settings.create({ tenant_id: req.tenantId, district: '' });
        settings = created.toObject();
        invalidateSettingsCache(req.tenantId);
      }
      const doc = settings;
      if (doc.risk_threshold_high === undefined) doc.risk_threshold_high = doc.high_risk_threshold ?? 70;
      if (doc.risk_threshold_medium === undefined) doc.risk_threshold_medium = doc.medium_risk_threshold ?? 40;
      if (doc.monitoring_interval_minutes === undefined) doc.monitoring_interval_minutes = 5;

      const CATEGORIES = ['political', 'communal', 'trouble_makers', 'defamation', 'narcotics', 'history_sheeters', 'others'];
      const defaultCategoryFreqs = {};
      for (const c of CATEGORIES) defaultCategoryFreqs[c] = 60;
      const defaultApiConfig = {
        monitoring: { enabled: true, frequencies: { x: { ...defaultCategoryFreqs }, instagram: { ...defaultCategoryFreqs }, facebook: { ...defaultCategoryFreqs }, youtube: { ...defaultCategoryFreqs } } },
        events: { x: 60, instagram: 60, facebook: 60, youtube: 60, enabled: true },
        grievances: { x: 60, facebook: 60, enabled: true }
      };
      if (!doc.api_config) {
        doc.api_config = defaultApiConfig;
      } else {
        if (!doc.api_config.monitoring) doc.api_config.monitoring = defaultApiConfig.monitoring;
        else {
          if (doc.api_config.monitoring.enabled === undefined) doc.api_config.monitoring.enabled = true;
          if (!doc.api_config.monitoring.frequencies) doc.api_config.monitoring.frequencies = defaultApiConfig.monitoring.frequencies;
          else {
            for (const plat of ['x', 'instagram', 'facebook', 'youtube']) {
              if (!doc.api_config.monitoring.frequencies[plat]) doc.api_config.monitoring.frequencies[plat] = { ...defaultCategoryFreqs };
              else { for (const cat of CATEGORIES) { if (doc.api_config.monitoring.frequencies[plat][cat] === undefined) doc.api_config.monitoring.frequencies[plat][cat] = 60; } }
            }
          }
        }
        for (const mod of ['events', 'grievances']) {
          if (!doc.api_config[mod]) doc.api_config[mod] = defaultApiConfig[mod];
          else { for (const key of Object.keys(defaultApiConfig[mod])) { if (doc.api_config[mod][key] === undefined) doc.api_config[mod][key] = defaultApiConfig[mod][key]; } }
        }
      }
      _settingsCache.set(settingsCacheKey(req.tenantId, district), { doc, time: Date.now() });
      settingsDoc = doc;
    }

    // Fetch keywords, thresholds, templates in parallel (single DB round-trip batch).
    // Keywords and Templates are district-owned, so they must be scoped the same way
    // their own module endpoints scope them — otherwise this bulk endpoint would
    // hand an officer every district's keywords/templates. AlertThreshold has no
    // district concept (tenant-wide viral thresholds), so it stays tenant-scoped.
    const districtScope = scopedDistrictQuery(req);
    const [keywords, thresholds, templates] = await Promise.all([
      Keyword.find({ tenant_id: req.tenantId, ...districtScope }).limit(1000).lean(),
      AlertThreshold.find({ tenant_id: req.tenantId }).sort({ platform: 1 }).lean(),
      Template.find({ tenant_id: req.tenantId, ...districtScope }).sort({ created_at: -1 }).lean()
    ]);

    res.status(200).json({
      settings: settingsDoc,
      keywords,
      thresholds,
      templates
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getSettings,
  updateSettings,
  getAllSettingsData
};
