const express = require('express');
const router = express.Router();
const {
    getAlerts,
    getAlertById,
    getAlertsByIds,
    updateAlert,
    getAlertStats,
    getAlertSummary,
    getDashboardStats,
    getUnreadCount,
    markAllAsRead,
    investigateLink,
    translateAlertContent,
    getSimilarEscalatedAlerts,
    changeAlertCategory,
    getWorkflowKpi
} = require('../controllers/alertController');
const { protect } = require('../middleware/authMiddleware');
const { requireAnyPageAccess, requireFeatureAccess, authorize } = require('../middleware/rbacMiddleware');

const normalizeAlertStatus = (value) => {
    if (!value || typeof value !== 'string') return null;
    const normalized = value.toLowerCase();
    if (normalized === 'falsepositive' || normalized === 'false-positive') return 'false_positive';
    if (normalized === 'resolved') return 'acknowledged';
    return normalized;
};

const resolveAlertStatusFromQuery = (req) => (
    normalizeAlertStatus(req.query.status || req.query.status_filter || req.query.tab) || 'active'
);

const resolveAlertStatusFromBody = (req) => (
    normalizeAlertStatus(req.body.status || req.body.next_status)
);

// Dashboard-shared READ endpoints: accessible to users with EITHER /alerts OR /dashboard
// page access (the Dashboard landing page widgets call these). Registered BEFORE the
// broad /alerts gate so a dashboard-only user (e.g. level-1) isn't 403'd. Writes below
// stay protected by the /alerts page gate + feature gates.
router.get('/dashboard-stats', protect, requireAnyPageAccess(['/alerts', '/dashboard']), getDashboardStats);
router.get('/unread', protect, requireAnyPageAccess(['/alerts', '/dashboard']), getUnreadCount);
// Alert Workflow KPI (dashboard widget) — accessible to /alerts OR /dashboard users.
// Workflow KPI is a per-user (tenant-wide) performance breakdown — restricted to
// admin so a district officer never sees other districts' officers' names/stats.
router.get('/workflow-kpi', protect, requireAnyPageAccess(['/alerts', '/dashboard']), authorize('admin'), getWorkflowKpi);

router.use(protect, requireAnyPageAccess(['/alerts']));

router.get('/', requireFeatureAccess('/alerts', resolveAlertStatusFromQuery), getAlerts);
router.get('/stats', getAlertStats);
router.get('/summary', getAlertSummary);
router.post('/investigate', requireFeatureAccess('/alerts', () => 'active'), (req, res, next) => {
    console.log('[AlertRoutes] POST /investigate reached');
    investigateLink(req, res, next);
});
router.post('/public-investigate', (req, res) => {
    console.log('[AlertRoutes] POST /public-investigate reached');
    investigateLink(req, res);
});
router.post('/translate', translateAlertContent);
router.post('/bulk', getAlertsByIds);
router.get('/debug', (req, res) => res.json({ version: '1.0.2', timestamp: new Date() }));
router.get('/:id', getAlertById);
router.put('/read', requireFeatureAccess('/alerts', () => 'active'), markAllAsRead);
router.put('/:id/change-category', changeAlertCategory);
router.put('/:id', requireFeatureAccess('/alerts', resolveAlertStatusFromBody, { allowWhenMissing: true }), updateAlert);
router.post('/similar', getSimilarEscalatedAlerts);

module.exports = router;
