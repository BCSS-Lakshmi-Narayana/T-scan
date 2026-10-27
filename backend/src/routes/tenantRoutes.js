const express = require('express');
const router = express.Router();
const { getTenantConfig } = require('../controllers/tenantController');
const { protect } = require('../middleware/authMiddleware');

// Public endpoint - for login page to fetch tenant branding (no auth required)
router.get('/public-config', getTenantConfig);

// Protected endpoint - require authentication
router.get('/config', protect, getTenantConfig);
// Tenant-facing branding customization removed (now managed via Super Admin).

module.exports = router;
