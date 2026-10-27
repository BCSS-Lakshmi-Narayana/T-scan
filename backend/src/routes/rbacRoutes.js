const express = require('express');
const router = express.Router();
const {
    getAllPages,
    getAllUsers,
    createUser,
    getUserPermissions,
    updateUserPermissions,
    getMyPermissions,
    updateUser,
    updateUserStatus,
    deleteUser,
    bulkDeleteUsers,
    getLoginHistory
} = require('../controllers/rbacController');
const { protect, authorize } = require('../middleware/authMiddleware');
const { loadUserPermissions, requireFeatureAccess } = require('../middleware/rbacMiddleware');

// All routes require authentication
router.use(protect);

// Current user's own permissions (any authenticated user)
router.get('/my-permissions', getMyPermissions);

// Access Management routes — admins always pass (isSuperAdmin bypass in
// requireFeatureAccess); non-admin officers need /settings enabled plus the
// specific sub-permission granted (see rbacConfig.js "Tabs Settings" /
// "Access Management" groups). The controllers themselves additionally block
// a non-admin from creating/editing/deleting an admin account or promoting
// anyone to admin, regardless of these grants.
const canView = [authorize('admin', 'level-1'), loadUserPermissions, requireFeatureAccess('/settings', 'access_management_tab_access')];
router.get('/pages', ...canView, getAllPages);
router.get('/users', ...canView, getAllUsers);
router.post('/users', authorize('admin', 'level-1'), loadUserPermissions, requireFeatureAccess('/settings', 'add_user'), createUser);
router.put('/users/:userId', authorize('admin', 'level-1'), loadUserPermissions, requireFeatureAccess('/settings', 'edit_user'), updateUser);
router.patch('/users/:userId/status', authorize('admin', 'level-1'), loadUserPermissions, requireFeatureAccess('/settings', 'edit_user'), updateUserStatus);
router.delete('/users/:userId', authorize('admin', 'level-1'), loadUserPermissions, requireFeatureAccess('/settings', 'delete_user'), deleteUser);
router.post('/users/bulk-delete', authorize('admin', 'level-1'), loadUserPermissions, requireFeatureAccess('/settings', 'delete_user'), bulkDeleteUsers);
router.get('/login-history', ...canView, getLoginHistory);
router.get('/permissions/:userId', authorize('admin', 'level-1'), loadUserPermissions, requireFeatureAccess('/settings', 'assign_permissions'), getUserPermissions);
router.put('/permissions/:userId', authorize('admin', 'level-1'), loadUserPermissions, requireFeatureAccess('/settings', 'assign_permissions'), updateUserPermissions);

module.exports = router;
