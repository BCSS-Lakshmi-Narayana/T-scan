const express = require('express');
const router = express.Router();

const {
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  archiveEvent,
  pauseEvent,
  resumeEvent,
  deleteEvent,
  getEventDashboard,
  getEventContent,
  runEventScan,
  generateKeywords,
  getMonitoringInterval,
  updateMonitoringInterval,
  getEventsReport,
  generateEventReportPdf
} = require('../controllers/eventController');

const { protect, authorize } = require('../middleware/authMiddleware');
const { requireAnyPageAccess } = require('../middleware/rbacMiddleware');

// Dashboard-shared READ: the Dashboard widget lists events, so allow /dashboard access
// here (registered before the broad /events gate). Event writes below keep /events + role gates.
router.get('/', protect, requireAnyPageAccess(['/events', '/dashboard']), listEvents);

router.use(protect, requireAnyPageAccess(['/events']));

router.get('/report', getEventsReport);
router.get('/:id', getEvent);
router.get('/:id/dashboard', getEventDashboard);
router.get('/:id/content', getEventContent);

router.post('/', authorize('superadmin', 'admin', 'analyst', 'level-1'), createEvent);
router.get('/monitoring-interval', getMonitoringInterval);
router.put('/monitoring-interval', authorize('superadmin', 'admin', 'analyst', 'level-1'), updateMonitoringInterval);
router.post('/generate-keywords', authorize('superadmin', 'admin', 'analyst', 'level-1'), generateKeywords);
router.put('/:id', authorize('superadmin', 'admin', 'analyst', 'level-1'), updateEvent);
router.post('/:id/archive', authorize('superadmin', 'admin', 'analyst', 'level-1'), archiveEvent);
router.post('/:id/pause', authorize('superadmin', 'admin', 'analyst', 'level-1'), pauseEvent);
router.post('/:id/resume', authorize('superadmin', 'admin', 'analyst', 'level-1'), resumeEvent);
router.post('/:id/run', authorize('superadmin', 'admin', 'analyst', 'level-1'), runEventScan);
router.post('/:id/generate-report-pdf', authorize('superadmin', 'admin', 'analyst', 'level-1'), generateEventReportPdf);
router.delete('/:id', authorize('superadmin', 'admin', 'analyst', 'level-1'), deleteEvent);

module.exports = router;
