const express = require('express');
const {
    getPolicies,
    getPolicy,
    createPolicy,
    updatePolicy,
    deletePolicy,
    bulkUploadPolicies
} = require('../controllers/policyController');
const { protect } = require('../middleware/authMiddleware');
const { requireAnyPageAccess } = require('../middleware/rbacMiddleware');

const router = express.Router();

// Policy Manager lives under the Settings page — gate to /settings page access
// (admin/superadmin bypass inside requireAnyPageAccess). Tenant scope is applied in
// the controller via withTenant(req).
router.use(protect, requireAnyPageAccess(['/settings']));

router
    .route('/')
    .get(getPolicies)
    .post(createPolicy);

router
    .route('/bulk-upload')
    .post(bulkUploadPolicies);

router
    .route('/:id')
    .get(getPolicy)
    .put(updatePolicy)
    .delete(deletePolicy);

module.exports = router;
