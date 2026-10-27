const express = require('express');
const router = express.Router();
const {
  getAlertsIntelligence,
  getGrievancesIntelligence,
  getProfilesIntelligence
} = require('../controllers/intelligenceDashboardController');
const { protect } = require('../middleware/authMiddleware');
const { requireAnyPageAccess } = require('../middleware/rbacMiddleware');

router.use(protect, requireAnyPageAccess(['/analytics', '/unified-reports', '/intelligence-dashboard']));

router.get('/alerts', getAlertsIntelligence);
router.get('/grievances', getGrievancesIntelligence);
router.get('/profiles', getProfilesIntelligence);

module.exports = router;
