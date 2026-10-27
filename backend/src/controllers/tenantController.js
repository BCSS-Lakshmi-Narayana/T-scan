const Tenant = require('../models/Tenant');

const getTenantConfig = async (req, res) => {
  try {
    if (!req.tenantId) {
      return res.status(400).json({ message: 'No tenant ID found' });
    }

    const tenant = await Tenant.findOne({ id: req.tenantId });

    if (!tenant) {
      return res.status(404).json({ message: 'Tenant not found' });
    }

    res.json({
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name || 'Your App',
      type: tenant.type,
      branding: tenant.branding || {},
      political_config: tenant.political_config || {},
      police_config: tenant.police_config || {}
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// NOTE: Tenant-facing branding customization was removed — branding is now
// configured centrally from the Super Admin. getTenantConfig remains so the app
// can still DISPLAY the configured branding (logo, app name, colors, etc.).

module.exports = { getTenantConfig };
