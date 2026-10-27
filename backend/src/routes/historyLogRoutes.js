const express = require('express');
const router = express.Router();
const { getHistoryLogs } = require('../controllers/historyLogController');
const { protect } = require('../middleware/authMiddleware');
const { requireAnyPageAccess } = require('../middleware/rbacMiddleware');

router.get('/', protect, requireAnyPageAccess(['/history-log']), getHistoryLogs);

module.exports = router;
