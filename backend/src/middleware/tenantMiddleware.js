const { findTenantBySlug, findTenantByDomain } = require('../services/tenantLookupService');

// Resolve the tenant slug from the request host.
//  - Real subdomain (e.g. "hydpolice.policesaga.com" -> "hydpolice") always wins.
//  - When there is NO usable subdomain — localhost, a bare IP (IP-based testing),
//    the apex domain, or "www" — fall back to the X-Tenant-Slug header or the
//    DEFAULT_TENANT_SLUG env var. This fallback only fires without a subdomain, so
//    production subdomain requests can never be spoofed via the header.
const hostOf = (req) => (req.headers.host || '').split(':')[0].toLowerCase(); // strip port

const resolveSlugFromHost = (req) => {
  const host = hostOf(req);
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const labels = host.split('.');
  const hasSubdomain = !isIp && labels.length >= 3 && labels[0] !== 'www';
  if (hasSubdomain) return labels[0];
  return req.headers['x-tenant-slug'] || process.env.DEFAULT_TENANT_SLUG || null;
};

const tenantMiddleware = async (req, res, next) => {
  try {
    // An explicit domain on the tenant record wins over every convention below.
    // It is the only rule that can name a host the subdomain scheme cannot
    // express — a vanity domain, or plain "localhost" so a developer can switch
    // which tenant local requests land on by editing one column.
    const host = hostOf(req);
    let tenant = host ? await findTenantByDomain(host) : null;

    if (!tenant) {
      const slug = resolveSlugFromHost(req);

      if (!slug) {
        console.log('[tenantMiddleware] No tenant slug resolved from host:', req.headers.host);
        return res.status(400).json({ error: 'Unable to resolve tenant' });
      }

      tenant = await findTenantBySlug(slug);

      if (!tenant) {
        console.log('[tenantMiddleware] Tenant not found for slug:', slug, '(host:', req.headers.host + ')');
        return res.status(403).json({ error: 'Tenant not found' });
      }
    }

    // Set tenantId on request (use UUID id, not slug)
    req.tenantId = tenant.id;
    req.tenantSlug = tenant.slug;
    // The resolved record itself — tenantDbMiddleware reads db_name from it to
    // pick the database this request should run against.
    req.tenant = tenant;

    next();
  } catch (error) {
    console.error('[tenantMiddleware] Error:', error.message);
    res.status(500).json({ error: 'Tenant resolution failed' });
  }
};

module.exports = tenantMiddleware;
