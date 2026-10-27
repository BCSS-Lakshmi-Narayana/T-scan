const express = require('express');
const router = express.Router();
const {
    getSources,
    addSource,
    discoverFacebookSources,
    confirmFacebookSources,
    updateSource,
    deleteSource,
    fetchSourceGrievances,
    fetchAllGrievances,
    getGrievances,
    getGrievance,
    acknowledgeGrievance,
    markAsComplaint,
    updateComplaintStatus,
    updateWorkflowStatus,
    convertToFir,
    escalateGrievance,
    ingestWhatsAppWebhook,
    generateReport,
    recordShare,
    getStats,
    getDashboardStats,
    getSettings,
    updateSettings,
    revertGrievance,
    enrichGrievanceContext
} = require('../controllers/grievanceController');
const { protect } = require('../middleware/authMiddleware');
const { GRIEVANCE_FEATURE_ALIASES } = require('../config/rbacConfig');
const { requireAnyPageAccess, requireFeatureAccess } = require('../middleware/rbacMiddleware');

const normalizeGrievanceFeature = (value) => {
    if (!value || typeof value !== 'string') return null;
    const normalized = value.toLowerCase();
    if (normalized === 'total') return 'all';
    if (normalized === 'converted_to_fir') return 'fir';
    return normalized;
};

const resolveGrievanceFeatureFromQuery = (req) => (
    normalizeGrievanceFeature(req.query.status_filter || req.query.tab || req.query.status || req.query.navbarStatus) || 'all'
);

const resolveGrievanceFeatureFromBody = (req) => (
    normalizeGrievanceFeature(req.body.status || req.body.workflow_status || req.body.targetStatus || req.body.next_status)
);

// Public webhook route (must remain unauthenticated)
router.post('/whatsapp/webhook', ingestWhatsAppWebhook);

router.use(protect, requireAnyPageAccess(['/grievances']));

// Stats route (must be before :id routes)
router.get('/stats', getStats);
router.get('/dashboard-stats', getDashboardStats);

// Settings routes
router.route('/settings')
    .get(getSettings)
    .put(updateSettings);

// Source routes
router.route('/sources')
    .get(getSources)
    .post(addSource);

// Facebook page discovery — registered before '/sources/:id' so the words
// 'discover-facebook' / 'confirm-facebook' are not read as a source id.
router.post('/sources/discover-facebook', discoverFacebookSources);
router.post('/sources/confirm-facebook', confirmFacebookSources);

router.route('/sources/:id')
    .put(updateSource)
    .delete(deleteSource);

router.post('/sources/:id/fetch', fetchSourceGrievances);

// Fetch all grievances from all sources
router.post('/fetch-all', fetchAllGrievances);

// Grievance routes
router.route('/')
    .get(requireFeatureAccess('/grievances', resolveGrievanceFeatureFromQuery, { aliases: GRIEVANCE_FEATURE_ALIASES }), getGrievances);

router.route('/:id')
    .get(getGrievance);

// Classification actions
router.put('/:id/acknowledge', requireFeatureAccess('/grievances', () => 'pending'), acknowledgeGrievance);
router.put('/:id/complaint', requireFeatureAccess('/grievances', () => 'pending'), markAsComplaint);
router.put('/:id/status', requireFeatureAccess('/grievances', resolveGrievanceFeatureFromBody, { aliases: GRIEVANCE_FEATURE_ALIASES, allowWhenMissing: true }), updateComplaintStatus);
router.put('/:id/workflow', requireFeatureAccess('/grievances', resolveGrievanceFeatureFromBody, { aliases: GRIEVANCE_FEATURE_ALIASES, allowWhenMissing: true }), updateWorkflowStatus);
router.post('/:id/convert-to-fir', requireFeatureAccess('/grievances', () => 'fir'), convertToFir);
router.post('/:id/escalate', requireFeatureAccess('/grievances', () => 'pending'), escalateGrievance);
router.post('/:id/enrich-context', enrichGrievanceContext);
router.put('/:id/revert', requireFeatureAccess('/grievances', () => 'all'), revertGrievance);

// Report generation and sharing
router.get('/:id/report', requireFeatureAccess('/grievances', () => 'reports'), generateReport);
router.post('/:id/share', requireFeatureAccess('/grievances', () => 'reports'), recordShare);

module.exports = router;
