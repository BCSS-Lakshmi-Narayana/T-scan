const express = require('express');
const router = express.Router();
const {
  getAnalyticsOverview,
  getTrends,
  getUnifiedReportsAnalytics
} = require('../controllers/analyticsController');
const { protect } = require('../middleware/authMiddleware');
const { requireAnyPageAccess } = require('../middleware/rbacMiddleware');

// Analytics are district-scoped per domain in the controller (Source/Content/
// Analysis/Report by `districts`, Alert via its Source, grievance-derived reports
// via their grievance). Officers see only their own district's aggregates; admins
// see the whole tenant.
router.use(protect, requireAnyPageAccess(['/analytics', '/unified-reports', '/intel-processed']));

router.get('/overview', getAnalyticsOverview);
router.get('/trends', getTrends);
router.get('/unified-reports', getUnifiedReportsAnalytics);

module.exports = router;
