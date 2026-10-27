const bcrypt = require('bcryptjs');
const User = require('../models/User');

// @desc    Create new user (tenant admin creating users for their tenant)
// @route   POST /api/users
// @access  Private (tenant_admin only)
const createUser = async (req, res) => {
  try {
    const { email, password, full_name, role } = req.body;
    const tenantId = req.tenantId;

    // Validate required fields
    if (!email || !password || !full_name) {
      return res.status(400).json({ message: 'Please provide email, password, and full_name' });
    }

    // Validate requester is tenant_admin
    const requester = await User.findOne({ id: req.user.id });
    if (!requester || requester.role !== 'tenant_admin') {
      return res.status(403).json({ message: 'Only tenant admins can create users' });
    }

    // Normalize email so it matches the login lookup (lowercase + trim).
    const normalizedEmail = String(email).toLowerCase().trim();

    // Verify user doesn't already exist
    const userExists = await User.findOne({ email: normalizedEmail });
    if (userExists) {
      return res.status(400).json({ message: 'User already exists' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create user with tenant_id automatically set from JWT
    const user = await User.create({
      email: normalizedEmail,
      password: hashedPassword,
      full_name: String(full_name).trim(),
      role: role || 'level-1',
      tenant_id: tenantId,
      is_active: true
    });

    res.status(201).json({
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      tenant_id: user.tenant_id,
      is_active: user.is_active,
      created_at: user.created_at
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all users for current tenant
// @route   GET /api/users
// @access  Private (tenant_admin only)
const getUsers = async (req, res) => {
  try {
    const tenantId = req.tenantId;

    const requester = await User.findOne({ id: req.user.id });
    if (!requester || requester.role !== 'tenant_admin') {
      return res.status(403).json({ message: 'Only tenant admins can view users' });
    }

    // Scope to the requester's tenant
    const users = await User.find({ tenant_id: tenantId }).select('-password');

    res.json(users);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update user details
// @route   PUT /api/users/:userId
// @access  Private (tenant_admin only)
const updateUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { full_name, role, is_active } = req.body;
    const tenantId = req.tenantId;

    // Verify requester is tenant_admin
    const requester = await User.findOne({ id: req.user.id });
    if (!requester || requester.role !== 'tenant_admin') {
      return res.status(403).json({ message: 'Only tenant admins can update users' });
    }

    // Verify target user exists and belongs to same tenant
    const user = await User.findOne({ id: userId, tenant_id: tenantId });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Update allowed fields
    if (full_name) user.full_name = full_name;
    if (role) user.role = role;
    if (typeof is_active === 'boolean') user.is_active = is_active;

    await user.save();

    res.json({
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      is_active: user.is_active,
      tenant_id: user.tenant_id
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete user
// @route   DELETE /api/users/:userId
// @access  Private (tenant_admin only)
const deleteUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const tenantId = req.tenantId;

    // Verify requester is tenant_admin
    const requester = await User.findOne({ id: req.user.id });
    if (!requester || requester.role !== 'tenant_admin') {
      return res.status(403).json({ message: 'Only tenant admins can delete users' });
    }

    // Verify target user exists and belongs to same tenant
    const user = await User.findOne({ id: userId, tenant_id: tenantId });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Prevent deleting yourself
    if (user.id === req.user.id) {
      return res.status(400).json({ message: 'Cannot delete your own account' });
    }

    await User.deleteOne({ id: userId, tenant_id: tenantId });

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  createUser,
  getUsers,
  updateUser,
  deleteUser
};
