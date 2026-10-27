const express = require('express');
const router = express.Router();
const ragController = require('../controllers/ragController');
const { protect, authorize } = require('../middleware/authMiddleware');
const { requireFeatureAccess } = require('../middleware/rbacMiddleware');

// All RAG routes require authentication
router.use(protect);

// Harmless metadata — available to any authenticated user.
router.get('/health', ragController.health);
router.get('/collections', ragController.collections);

// The RAG/AI corpus (Python vector store + Mongo context builder) now carries
// per-chunk/per-doc district metadata (see rag_pipeline/api_server.py's
// _with_district_scope / _scoped_source_ids / _scoped_grievance_ids, and
// vector_store.py's cosine_search `districts` param). ragController.js sends
// req.user.districts (null for admin) on every one of these calls, so the AI
// Assistant, top-alerts widgets, and async job polling below are safe for
// District Officers — each one is scoped to their own district(s), never the
// whole tenant. Only the operational/admin endpoints (bulk ingest, job-queue
// management, raw pipeline stats) stay admin-only below.
router.post('/query', ragController.query);
router.post('/query/async', ragController.queryAsync);
// On-demand concept scans; scoped to the caller's tenant + districts like /query.
router.post('/scan', ragController.scanStart);
router.get('/scan/:id', ragController.scanStatus);
router.delete('/scan/:id', ragController.scanCancel);
router.get('/jobs/:id', ragController.getJob); // polling the officer's OWN just-submitted job
router.post('/top-alerts/by-category', ragController.topAlertsByCategory);
// v2 assistant. Unlike the routes above, these enforce the AI Assistant's own
// RBAC feature server-side (requireFeatureAccess also loads req.rbac, whose
// permissions are forwarded to the policy gate).
router.get('/v2/status', ragController.v2Status);
router.post('/v2/query', requireFeatureAccess('/ai-assistant', 'ai_chat'), ragController.queryV2);
router.post('/v2/feedback', requireFeatureAccess('/ai-assistant', 'ai_chat'), ragController.v2Feedback);
router.get('/v2/analysis/:id', requireFeatureAccess('/ai-assistant', 'ai_chat'), ragController.v2AnalysisStatus);
router.delete('/v2/analysis/:id', requireFeatureAccess('/ai-assistant', 'ai_chat'), ragController.v2AnalysisCancel);
router.get('/top-alerts/cached', ragController.topAlertsCached);

router.use(authorize('admin'));

router.get('/jobs', ragController.listJobs);
router.delete('/jobs/:id', ragController.deleteJob);
router.post('/ingest', ragController.ingest);
router.get('/stats', ragController.stats);

module.exports = router;
