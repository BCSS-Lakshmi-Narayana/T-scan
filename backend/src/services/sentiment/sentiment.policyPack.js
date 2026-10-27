/**
 * Builds the category taxonomy sent with each request (soceye's buildPolicyPack).
 *
 * Sourced only from this tenant's own policy mappings, narrowed to the post's
 * district(s). Never a merged or global list, so one tenant's categories can
 * never shape another tenant's classification.
 */

const mappingService = require('../mappingService');

const UNKNOWN_LABEL = 'Normal';
const MAX_CATEGORIES = 128; // service rejects larger packs

const NORMAL_CATEGORY = {
  id: UNKNOWN_LABEL,
  definition: 'Harmless or neutral content. Use when nothing else applies.',
  severity: 'Low',
  keywords: [],
};

/**
 * @param {string} tenantId
 * @param {string[]|null} [districts] restrict to policies that apply to these districts
 * @returns {object} policy pack; only Normal when the tenant has no mappings
 */
const buildPolicyPack = (tenantId, districts = null) => {
  if (!tenantId) throw new Error('buildPolicyPack requires a tenantId');

  const scoped = Array.isArray(districts) ? districts.filter(Boolean) : [];
  const all = mappingService.getTenantCategories(tenantId, scoped.length ? scoped : null) || [];
  // Content without a district (events, searches) gets tenant-wide policies only:
  // a district's own policy must never classify content that isn't that district's.
  const mappings = scoped.length
    ? all
    : all.filter((m) => !(Array.isArray(m.districts) && m.districts.filter(Boolean).length));

  const seen = new Set();
  const categories = [];
  for (const m of mappings) {
    const id = String(m.category_id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    categories.push({
      id,
      definition: String(m.definition || '').slice(0, 500),
      severity: String(m.severity_level || ''),
      keywords: Array.isArray(m.keywords) ? m.keywords.slice(0, 40).map(String) : [],
    });
  }

  const rest = categories.filter((c) => c.id !== UNKNOWN_LABEL).slice(0, MAX_CATEGORIES - 1);
  const normal = categories.find((c) => c.id === UNKNOWN_LABEL) || NORMAL_CATEGORY;
  return { name: 'police-policy-mapping', unknown_label: UNKNOWN_LABEL, categories: [...rest, normal] };
};

/** Stable key for a post's district scope (dispatcher bucket). */
const districtSignature = (districts) => {
  const list = Array.isArray(districts) ? districts.filter(Boolean).map(String) : [];
  return list.length ? [...new Set(list)].sort().join('|') : '_tenant';
};

module.exports = { buildPolicyPack, districtSignature, UNKNOWN_LABEL };
