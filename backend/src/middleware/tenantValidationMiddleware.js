const { findActiveTenantById } = require('../services/tenantLookupService');

const tenantValidationMiddleware = async (req, res, next) => {
  console.log(`[tenantValidation] ${req.method} ${req.path} - TenantId: ${req.tenantId}`);
  try {
    const tenantId = req.tenantId;

    if (!tenantId) {
      console.log('[tenantValidation] No tenant ID provided');
      return res.status(401).json({ error: 'No tenant ID in request' });
    }

    const tenant = await findActiveTenantById(tenantId);

    if (!tenant) {
      console.log('[tenantValidation] Tenant not found or inactive:', tenantId);
      return res.status(403).json({ error: 'Tenant not found or inactive' });
    }

    console.log('[tenantValidation] Tenant validated:', tenant.name);
    req.tenant = tenant;
    next();
  } catch (error) {
    console.error('[tenantValidation] Error:', error.message);
    return res.status(500).json({ error: 'Tenant validation failed' });
  }
};

module.exports = tenantValidationMiddleware;
