const express = require('express');
const router = express.Router();
const { getAuditLogs } = require('../controllers/auditController');
const { protect } = require('../middleware/authMiddleware');
const { requireAnyPageAccess } = require('../middleware/rbacMiddleware');

router.get('/', protect, requireAnyPageAccess(['/audit-logs']), getAuditLogs);

module.exports = router;
