const express = require('express');
const router = express.Router();
const sourceController = require('../controllers/sourceController');
const { 
  getSources, 
  createSource, 
  updateSource, 
  deleteSource, 
  manualCheck, 
  toggleSourceStatus, 
  scanNow, 
  scanAllSources, 
  createSourcesBulk, 
  getInstagramProfile,
  resolveSourceIdentity,
  refreshSourceIdentity,
  getMonitoringUsage
} = sourceController;

const { protect } = require('../middleware/authMiddleware');
const { authorize, requirePermission, requireAnyPageAccess } = require('../middleware/rbacMiddleware');

router.use(protect);

// Officers (level-1) with the Alerts/Profile page enabled via Access Management
// must be able to add profiles — requirePermission('manage:sources') hard-blocks
// level-1 regardless of what's granted, so gate creation on page access instead.
router.route('/')
  .get(getSources)
  .post(requireAnyPageAccess(['/alerts', '/person-of-interest']), createSource);

router.post('/bulk', requirePermission('manage:sources'), createSourcesBulk);
router.post('/scan-all', requirePermission('manage:sources'), scanAllSources);
router.post('/resolve-identity', requireAnyPageAccess(['/alerts', '/person-of-interest']), resolveSourceIdentity);

// Get escalation counts per source (count of Reports by matching handle to source identifier)
router.get('/escalation-counts', async (req, res) => {
  try {
    const Report = require('../models/Report');
    const Source = require('../models/Source');

    // Get all report counts grouped by handle (lowercased)
    const reportsByHandle = await Report.aggregate([
      { $match: { 'target_user_details.handle': { $ne: null } } },
      { $group: { _id: { $toLower: '$target_user_details.handle' }, count: { $sum: 1 } } }
    ]);

    // Build a lookup map: lowercase handle -> count (strip @ prefix too)
    const handleMap = {};
    reportsByHandle.forEach(r => {
      const raw = r._id || '';
      handleMap[raw] = (handleMap[raw] || 0) + r.count;
      const stripped = raw.replace(/^@/, '');
      if (stripped !== raw) handleMap[stripped] = (handleMap[stripped] || 0) + r.count;
    });

    // Get all sources and match by identifier
    const sources = await Source.find({}, { id: 1, identifier: 1 }).lean();
    const counts = {};
    sources.forEach(s => {
      const id = (s.identifier || '').toLowerCase();
      const count = handleMap[id] || handleMap['@' + id] || 0;
      if (count > 0) counts[s.id] = count;
    });

    res.json(counts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Officer's monitoring volume usage vs limits (fixed path — before '/:id').
router.get('/monitoring-usage', getMonitoringUsage);

router.route('/:id')
  .put(updateSource)
  .delete(deleteSource);

router.post('/:id/check', manualCheck);
router.post('/:id/scan', scanNow);
router.post('/:id/refresh-identity', refreshSourceIdentity);
router.put('/:id/toggle', toggleSourceStatus);
// '/monitors' is a dead/legacy page path (never registered in ALL_PAGES), so a
// feature gate keyed to it can never be satisfied by a non-admin user's real
// permissions — dropped in favor of the page-level access already enforced above.
router.get('/:id/instagram-profile', getInstagramProfile);

module.exports = router;
