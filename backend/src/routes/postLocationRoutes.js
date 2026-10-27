const express = require('express');
const router = express.Router();
const { lookupPostLocation } = require('../controllers/postLocationController');

router.post('/lookup', lookupPostLocation);
router.get('/lookup', lookupPostLocation);

module.exports = router;
