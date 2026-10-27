const express = require('express');
const router = express.Router();
const {
    getEvents,
    createEvent,
    updateEvent,
    deleteEvent
} = require('../controllers/ongoingEventController');
const { protect } = require('../middleware/authMiddleware');
const { requireAnyPageAccess } = require('../middleware/rbacMiddleware');

// Dashboard-shared READ (the Managed Ribbon widget on the Dashboard reads ongoing events).
// Allow /dashboard here; writes below stay behind the /events page gate.
router.get('/', protect, requireAnyPageAccess(['/events', '/dashboard']), getEvents);

router.use(protect, requireAnyPageAccess(['/events']));

router.post('/', createEvent);
router.put('/:id', updateEvent);
router.delete('/:id', deleteEvent);

module.exports = router;
