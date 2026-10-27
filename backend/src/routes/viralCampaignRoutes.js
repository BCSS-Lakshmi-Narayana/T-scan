const express = require('express');
const router = express.Router();

const {
  listMyRequests,
  getRequest,
  createRequest,
  cancelRequest,
} = require('../controllers/viralCampaignController');

const { protect, authorize } = require('../middleware/authMiddleware');
const { requireAnyPageAccess } = require('../middleware/rbacMiddleware');

router.use(protect, requireAnyPageAccess(['/viral-campaigns']));

const canManage = authorize('superadmin', 'admin', 'tenant_admin', 'analyst', 'level-1');

router.get('/', listMyRequests);
router.get('/:id', getRequest);
router.post('/', canManage, createRequest);
router.put('/:id/cancel', canManage, cancelRequest);

module.exports = router;
