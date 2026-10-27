const express = require('express');
const router = express.Router();
const { createUser, getUsers, updateUser, deleteUser } = require('../controllers/userController');
const { protect, authorize } = require('../middleware/authMiddleware');

// All routes require authentication
router.use(protect);

// Create new user (tenant admin only)
router.post('/', authorize('admin', 'tenant_admin'), createUser);

// Get all users for current tenant (tenant admin only)
router.get('/', authorize('admin', 'tenant_admin'), getUsers);

// Update user details (tenant admin only)
router.put('/:userId', authorize('admin', 'tenant_admin'), updateUser);

// Delete user (tenant admin only)
router.delete('/:userId', authorize('admin', 'tenant_admin'), deleteUser);

module.exports = router;
