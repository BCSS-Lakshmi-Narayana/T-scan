const express = require('express');
const router = express.Router();
const { getOverview, getGeo } = require('../controllers/commandCenterController');
const { protect } = require('../middleware/authMiddleware');
const { requireAnyPageAccess } = require('../middleware/rbacMiddleware');

// The command centre is the dashboard, so it is gated on dashboard access.
// Every figure inside is tenant-scoped and district-scoped in the controller:
// a State Admin sees the whole tenant (narrowed by the global district filter),
// a District Officer is hard-clamped to their own assigned districts.
router.use(protect, requireAnyPageAccess(['/dashboard']));

router.get('/overview', getOverview);
// District boundaries, restricted to the districts the caller may see.
router.get('/geo', getGeo);

module.exports = router;
