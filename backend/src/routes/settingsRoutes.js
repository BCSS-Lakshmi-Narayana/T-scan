const express = require('express');
const router = express.Router();
const { getSettings, updateSettings, getAllSettingsData } = require('../controllers/settingsController');
const { addAccount, getAccounts, deleteAccount, resetBrowser } = require('../controllers/accountController');
const { protect } = require('../middleware/authMiddleware');
const { requireAnyPageAccess } = require('../middleware/rbacMiddleware');

router.use(protect, requireAnyPageAccess(['/settings']));

// Combined endpoint — returns settings + keywords + thresholds + templates in one call
router.get('/all', getAllSettingsData);

router.route('/')
  .get(getSettings)
  .put(updateSettings);

router.route('/accounts')
  .post(addAccount)
  .get(getAccounts);

router.route('/accounts/:id')
  .delete(deleteAccount);

router.route('/accounts/reset')
  .post(resetBrowser);

module.exports = router;
