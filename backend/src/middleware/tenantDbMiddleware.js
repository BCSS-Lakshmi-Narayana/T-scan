/**
 * Puts the resolved tenant's database in scope for the rest of the request.
 *
 * Runs immediately after tenantMiddleware, which turns the request host into
 * req.tenant. Everything downstream — controllers, services, the models they
 * require — reads that tenant's database without being passed a connection.
 */
const { forTenant, isPerTenant, dbNameFor } = require('../config/tenantConnections');
const { runWithTenant } = require('../config/tenantContext');

const tenantDbMiddleware = (req, res, next) => {
  const tenant = req.tenant;

  // No tenant on the request means tenantMiddleware let it through as a public
  // or control-plane route; those read the default connection.
  if (!tenant) return next();

  let connection;
  try {
    connection = forTenant(tenant);
  } catch (error) {
    console.error(`[tenantDbMiddleware] ${tenant.slug || tenant.id}: ${error.message}`);
    return res.status(503).json({ error: 'Tenant database unavailable' });
  }

  req.db = connection;
  req.tenantDbName = isPerTenant() ? dbNameFor(tenant) : connection.name;

  runWithTenant({ tenant, tenantId: tenant.id, connection }, next);
};

module.exports = tenantDbMiddleware;
