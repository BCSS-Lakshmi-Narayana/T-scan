/**
 * tenantContextService — the single source of truth for everything a pipeline needs
 * about ONE tenant. Replaces every `Settings.findOne({ id: 'global_settings' })` read
 * in the background pipelines with per-tenant data.
 *
 * Returns one isolated context object per tenant (settings + keywords + sources +
 * AI context), cached for a short TTL so we don't hammer the DB every scheduler tick.
 *
 * Config: TENANT_CONTEXT_TTL_SEC (default 60).
 *
 * Usage:
 *   const ctxSvc = require('./tenantContextService');
 *   const ctx = await ctxSvc.getContext(tenantId);
 *   ctxSvc.invalidate(tenantId);   // call when a tenant edits settings/keywords
 */

const Tenant = require('../../models/Tenant');
const Settings = require('../../models/Settings');
const Keyword = require('../../models/Keyword');
const Source = require('../../models/Source');

const TTL_MS = Math.max(5000, (Number(process.env.TENANT_CONTEXT_TTL_SEC) || 60) * 1000);
const CACHE_MAX = Number(process.env.TENANT_CONTEXT_CACHE_MAX) || 2000;

const cache = new Map(); // tenant_id -> { value, expiresAt }

const buildAIContext = (tenant) => {
  const pc = tenant?.political_config || {};
  const ac = tenant?.ai_config || {};
  return {
    politician_name: pc.politician_name || '',
    party_name: pc.party_name || '',
    party_aliases: pc.party_aliases || [],
    politician_aliases: pc.politician_aliases || [],
    constituency: pc.constituency || '',
    state: pc.state || tenant?.location_config?.state_name || '',
    // opposition is a future-config field; empty for now so analysis stays neutral if unset
    opposition: pc.opposition || [],
    model: ac.model || process.env.OLLAMA_MODEL || 'gpt-4',
    temperature: ac.temperature,
    system_prompt: ac.system_prompt || '',
    sentiment_context: ac.sentiment_context || '',
    analysis_focus_areas: ac.analysis_focus_areas || [],
    // Per-tenant LLM classification prompt override (Super Admin → AI Prompts).
    // Empty string = use the built-in default (see promptTemplateService).
    classification_prompt: ac.classification_prompt || '',
  };
};

const loadContext = async (tenantId) => {
  const [tenant, settings, keywordDocs, sourceDocs] = await Promise.all([
    Tenant.findOne({ id: tenantId }).lean(),
    Settings.findOne({ tenant_id: tenantId, district: '' }).lean(),
    Keyword.find({ tenant_id: tenantId, is_active: true }).lean(),
    Source.find({ tenant_id: tenantId, is_active: true }).lean(),
  ]);

  if (!tenant) return null;

  const keywords = (keywordDocs || []).map((k) => ({
    keyword: k.keyword,
    category: k.category,
    language: k.language,
    weight: k.weight,
    // Needed so analysis can apply a district's keywords only to that district's
    // content (services/sentiment/sentiment.keywords filters on this). Empty = tenant-wide keyword.
    districts: k.districts || [],
  }));

  return {
    tenant_id: tenantId,
    slug: tenant.slug,
    type: tenant.type,
    name: tenant.name,
    status: tenant.status,
    feature_flags: tenant.feature_flags || {},
    settings: settings || {},
    keywords,                                   // [{keyword, category, language, weight}]
    keywordStrings: keywords.map((k) => k.keyword).filter(Boolean),
    sources: sourceDocs || [],                  // [{platform, identifier, ...}]
    aiContext: buildAIContext(tenant),
    location_config: tenant.location_config || {},
  };
};

/**
 * Get a tenant's context (cached). Returns null if the tenant no longer exists.
 * @param {string} tenantId
 * @param {{force?:boolean}} [opts]
 */
const getContext = async (tenantId, opts = {}) => {
  if (!tenantId) return null;
  const now = Date.now();
  const hit = cache.get(tenantId);
  if (!opts.force && hit && hit.expiresAt > now) return hit.value;

  const value = await loadContext(tenantId);
  // Bound memory so the cache can't grow without limit as tenant count rises.
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  // Cache even null briefly to avoid repeated lookups for deleted tenants
  cache.set(tenantId, { value, expiresAt: now + TTL_MS });
  return value;
};

const invalidate = (tenantId) => {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
};

module.exports = { getContext, invalidate, TTL_MS };
