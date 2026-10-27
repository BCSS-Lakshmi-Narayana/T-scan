const express = require('express');
const router = express.Router();
const { getKeywords, createKeyword, deleteKeyword } = require('../controllers/keywordController');
const { protect } = require('../middleware/authMiddleware');
const { requireAnyPageAccess } = require('../middleware/rbacMiddleware');

router.get('/', protect, requireAnyPageAccess(['/settings', '/alerts']), getKeywords);
router.post('/', protect, requireAnyPageAccess(['/settings']), createKeyword);
router.post('/scan', protect, requireAnyPageAccess(['/settings']), require('../controllers/keywordController').triggerRescan);
router.delete('/:id', protect, requireAnyPageAccess(['/settings']), deleteKeyword);

module.exports = router;
