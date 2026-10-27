const express = require('express');
const router = express.Router();
const { getOsintToolsConfig } = require('../controllers/osintToolsController');
const { protect } = require('../middleware/authMiddleware');

router.use(protect);

router.get('/config', getOsintToolsConfig);

module.exports = router;
