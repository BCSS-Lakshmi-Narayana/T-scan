const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const searchTrendsController = require('../controllers/searchTrendsController');

// Submit a trends request (cache → queue → sync fallback)
router.get('/', protect, searchTrendsController.getSearchTrends);

// Poll a queued job's status
router.get('/status/:jobId', protect, searchTrendsController.getJobStatus);

module.exports = router;
