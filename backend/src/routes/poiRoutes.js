const express = require('express');
const router = express.Router();
const {
    getAllPOIs,
    getPOIById,
    createPOI,
    updatePOI,
    deletePOI,
    getLatestReport,
    getPoiBySourceId,
    getPoiStats
} = require('../controllers/poiController');
const { protect } = require('../middleware/authMiddleware');
const { requireAnyPageAccess } = require('../middleware/rbacMiddleware');

// Was previously commented out, which meant `protect` never ran on these routes —
// req.user stayed undefined, so scopedDistrictQuery(req) in getAllPOIs always fell
// back to its "no districts assigned" case and returned every tenant's POIs to
// every officer regardless of their assigned district.
router.use(protect, requireAnyPageAccess(['/person-of-interest', '/alerts']));

router.get('/', getAllPOIs);
router.get('/stats', getPoiStats);
router.get('/by-source/:sourceId', getPoiBySourceId);
router.get('/:id/report/latest', getLatestReport);
router.get('/:id', getPOIById);
router.post('/', createPOI);
router.put('/:id', updatePOI);
router.delete('/:id', deletePOI);

module.exports = router;