/**
 * Add tenant_id to a query filter
 * Usage: Alert.findOne(withTenant(req, { status: 'active' }))
 */
const withTenant = (req, filter = {}) => {
  if (!req.tenantId) {
    return filter;
  }
  return {
    ...filter,
    tenant_id: req.tenantId
  };
};

/**
 * Add tenant_id to multiple query filters
 */
const withTenantMulti = (req, filters = []) => {
  if (!req.tenantId) {
    return filters;
  }
  return filters.map(filter => ({
    ...filter,
    tenant_id: req.tenantId
  }));
};

module.exports = { withTenant, withTenantMulti };
