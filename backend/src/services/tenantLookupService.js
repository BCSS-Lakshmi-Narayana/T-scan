/**
 * tenantLookupService
 * ─────────────────────────────────────────────────────────────────────
 * Slim, cached tenant lookups for the per-request middleware chain.
 *
 * Why this exists: a tenant document is large — `location_config` carries the
 * location-tagging vocabulary (`assembly_segments[].villages`) and
 * `city_to_district_map`, which together run to hundreds of kilobytes on a
 * configured tenant. The middleware chain was loading that whole document on
 * every request, twice: tenantMiddleware resolves the host's tenant, and
 * tenantValidationMiddleware re-checks the JWT's tenant a few frames later.
 * Neither reads a single one of those heavy fields.
 *
 * Projecting to the scalars the chain actually needs makes the query small;
 * caching removes it from the hot path entirely.
 *
 * The heavy sub-documents are still read where they are genuinely needed —
 * callers that want `location_config` or `feature_flags` query the Tenant model
 * directly and are not routed through here.
 */

const Tenant = require('../models/Tenant');

// Everything the middleware chain touches: tenant identity + activation state,
// plus db_name — tenantDbMiddleware resolves the tenant's database from this
// same cached document, so routing costs no extra query on the hot path.
const SLIM_PROJECTION = { id: 1, slug: 1, type: 1, name: 1, status: 1, plan: 1, db_name: 1, domain: 1 };

const TTL_MS = Number(process.env.TENANT_CACHE_TTL_MS || 60000);
const bySlug = new Map();
const byId = new Map();
const byDomain = new Map();

const fresh = (entry) => entry && Date.now() - entry.at < TTL_MS;

const findTenantBySlug = async (slug) => {
  if (!slug) return null;
  const hit = bySlug.get(slug);
  if (fresh(hit)) return hit.doc;
  const doc = await Tenant.findOne({ slug }, SLIM_PROJECTION).lean();
  bySlug.set(slug, { doc, at: Date.now() });
  return doc;
};

/**
 * Exact-host lookup for tenants that declare their own `domain`. Runs on every
 * request ahead of the subdomain rule, so misses are cached too — otherwise the
 * common case (no tenant uses a custom domain) would add a database round trip
 * to each request rather than removing one.
 */
const findTenantByDomain = async (domain) => {
  if (!domain) return null;
  const key = String(domain).toLowerCase();
  const hit = byDomain.get(key);
  if (fresh(hit)) return hit.doc;
  const doc = await Tenant.findOne({ domain: key }, SLIM_PROJECTION).lean();
  byDomain.set(key, { doc, at: Date.now() });
  return doc;
};

/** Active-only lookup used to validate the JWT's tenant on each request. */
const findActiveTenantById = async (id) => {
  if (!id) return null;
  const hit = byId.get(id);
  if (fresh(hit)) return hit.doc;
  const doc = await Tenant.findOne({ id, status: { $in: ['trial', 'active'] } }, SLIM_PROJECTION).lean();
  byId.set(id, { doc, at: Date.now() });
  return doc;
};

/**
 * Drops cached copies of a tenant. Call after any write that changes tenant
 * identity, status or configuration, so a suspension or a domain change is not
 * served from cache for up to the TTL.
 */
const invalidateTenant = (tenant) => {
  // The domain cache also holds negative entries keyed by hosts that matched no
  // tenant, so a targeted invalidation cannot know which of those a newly set
  // domain would have hit. Clearing it wholesale is what makes editing `domain`
  // take effect on the next request instead of after the TTL.
  if (!tenant) { bySlug.clear(); byId.clear(); byDomain.clear(); return; }
  if (typeof tenant === 'string') { byId.delete(tenant); bySlug.delete(tenant); byDomain.clear(); return; }
  if (tenant.id) byId.delete(tenant.id);
  if (tenant.slug) bySlug.delete(tenant.slug);
  byDomain.clear();
};

module.exports = { findTenantBySlug, findTenantByDomain, findActiveTenantById, invalidateTenant, SLIM_PROJECTION };
