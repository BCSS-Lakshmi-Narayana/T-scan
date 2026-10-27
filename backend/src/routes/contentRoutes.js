const express = require('express');
const router = express.Router();
const { getContent, getContentFeed, getContentDetail, getContentStats, checkContentAvailability, getUnavailableContent } = require('../controllers/contentController');
const { protect } = require('../middleware/authMiddleware');
const { requireAnyPageAccess } = require('../middleware/rbacMiddleware');

// '/monitors', '/x-monitor', etc. are dead/legacy nav entries (see rbacConfig.js) —
// they were never registered in ALL_PAGES, so a per-platform feature gate keyed to
// '/monitors' can never be satisfied by a non-admin user's real permissions. The
// actual live pages that fetch content are Alerts and Profile (POI detail).
const CONTENT_ALLOWED_PAGES = [
  '/alerts',
  '/person-of-interest',
  '/content',
  '/intel-processed',
  '/monitors',
  '/x-monitor',
  '/facebook-monitor',
  '/instagram-monitor',
  '/youtube-monitor'
];

router.use(protect, requireAnyPageAccess(CONTENT_ALLOWED_PAGES));

router.get('/', getContent);
router.get('/feed', getContentFeed);
router.get('/stats', getContentStats);
router.get('/unavailable', getUnavailableContent);
router.post('/check-availability', checkContentAvailability);
router.get('/:id', getContentDetail);

module.exports = router;
