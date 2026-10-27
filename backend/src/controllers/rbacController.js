const PagePermission = require('../models/PagePermission');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const AuditLog = require('../models/AuditLog');
const { ALL_PAGES, PAGE_FEATURES } = require('../config/rbacConfig');
const { withTenant } = require('../utils/tenantFilter');
const { logHistory } = require('../services/historyLogService');
const { sanitizeLimitsInput, reconcileActiveToLimits, limitsEqual } = require('../utils/monitoringLimits');

// Capabilities a newly-created officer must NOT get by default. Access Management
// is not a page — it's the "Access Management" group of features inside /settings.
// It lists every user in the tenant and allows creating/editing/deleting them and
// reassigning permissions, so granting it to a district officer would expose other
// districts' officers — the exact thing the district isolation model prevents
// everywhere else. An admin can still grant these deliberately afterwards.
const OFFICER_DEFAULT_EXCLUDED_PAGES = new Set([]);
const OFFICER_DEFAULT_EXCLUDED_FEATURES = new Set([
  'access_management_tab_access', // the Access Management tab in Settings
  'add_user',
  'edit_user',
  'delete_user',
  'assign_permissions'
]);

// Default permission set for a new officer: every module enabled with all of its
// features, minus the excluded capabilities above. Without this a new officer
// lands with only /dashboard and the admin has to tick every box by hand.
const buildDefaultOfficerPermissions = () => {
  const permissions = {};
  ALL_PAGES.forEach((page) => {
    if (OFFICER_DEFAULT_EXCLUDED_PAGES.has(page.path)) return;
    permissions[page.path] = {
      enabled: true,
      features: (PAGE_FEATURES[page.path] || [])
        .map((f) => f.id)
        .filter((id) => !OFFICER_DEFAULT_EXCLUDED_FEATURES.has(id))
    };
  });
  return permissions;
};

// The officer's districts must be ones the tenant is actually assigned (from
// Super Admin onboarding) — admins aren't district-scoped, so [] is always valid.
const validDistrictsForTenant = async (req, districts) => {
  if (!districts.length) return true;
  const tenant = await Tenant.findOne({ id: req.tenantId }).select('police_config.state police_config.districts');
  const assigned = tenant?.police_config?.districts || [];
  return districts.every((d) => assigned.includes(d));
};

const PAGE_PATHS = new Set(ALL_PAGES.map((page) => page.path));
const FEATURE_IDS_BY_PAGE = Object.fromEntries(
  Object.entries(PAGE_FEATURES).map(([path, features]) => [path, new Set(features.map((feature) => feature.id))])
);

const normalizePath = (value) => {
  if (!value || typeof value !== 'string') return '/';
  const path = value.replace(/\/+$/, '') || '/';
  return path.startsWith('/') ? path : `/${path}`;
};

const uniqueStrings = (value) => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry) => typeof entry === 'string'))];
};

const buildPermissionsFromAllowedPages = (allowedPages = []) => {
  const permissions = {};
  uniqueStrings(allowedPages).forEach((rawPath) => {
    const pagePath = normalizePath(rawPath);
    if (!PAGE_PATHS.has(pagePath)) return;
    const featureIds = PAGE_FEATURES[pagePath]?.map((feature) => feature.id) || [];
    permissions[pagePath] = { enabled: true, features: featureIds };
  });
  return permissions;
};

// New officers default to the full dashboard (all widgets) rather than none —
// /dashboard became a feature-gated page, so an empty features array would
// otherwise hide every widget until an admin explicitly grants them.
const buildDefaultPermissions = () => ({
  '/dashboard': { enabled: true, features: (PAGE_FEATURES['/dashboard'] || []).map((f) => f.id) }
});

const buildAdminPermissions = () => {
  const permissions = {};
  ALL_PAGES.forEach((page) => {
    permissions[page.path] = {
      enabled: true,
      features: PAGE_FEATURES[page.path]?.map((feature) => feature.id) || []
    };
  });
  return permissions;
};

const normalizePermissionsForRead = (rawPermissions = {}, { fillMissingFeatures = false } = {}) => {
  const permissions = {};
  Object.entries(rawPermissions || {}).forEach(([rawPagePath, rawPermission]) => {
    const pagePath = normalizePath(rawPagePath);
    if (!PAGE_PATHS.has(pagePath)) return;

    const enabled = Boolean(rawPermission?.enabled);
    const featureSet = FEATURE_IDS_BY_PAGE[pagePath];
    let features = uniqueStrings(rawPermission?.features);

    if (featureSet && featureSet.size > 0) {
      features = features.filter((featureId) => featureSet.has(featureId));
      if (enabled && fillMissingFeatures && features.length === 0) {
        features = [...featureSet];
      }
    } else {
      features = [];
    }

    permissions[pagePath] = { enabled, features };
  });
  return permissions;
};

const validateAndNormalizePermissions = (rawPermissions = {}) => {
  const sanitized = {};
  const errors = [];

  Object.entries(rawPermissions || {}).forEach(([rawPagePath, rawPermission]) => {
    const pagePath = normalizePath(rawPagePath);
    if (!PAGE_PATHS.has(pagePath)) {
      errors.push(`Invalid page path: ${rawPagePath}`);
      return;
    }

    if (!rawPermission || typeof rawPermission !== 'object') {
      errors.push(`Invalid permission object for ${pagePath}`);
      return;
    }

    const enabled = Boolean(rawPermission.enabled);
    const featureSet = FEATURE_IDS_BY_PAGE[pagePath];
    let features = uniqueStrings(rawPermission.features);

    if (featureSet && featureSet.size > 0) {
      const invalidFeatures = features.filter((featureId) => !featureSet.has(featureId));
      if (invalidFeatures.length > 0) {
        errors.push(`Invalid feature ids for ${pagePath}: ${invalidFeatures.join(', ')}`);
      }
      features = features.filter((featureId) => featureSet.has(featureId));
      if (enabled && features.length === 0) {
        errors.push(`At least one feature must be enabled for ${pagePath}`);
      }
    } else {
      if (features.length > 0) {
        errors.push(`Page ${pagePath} does not support feature-level permissions`);
      }
      features = [];
    }

    sanitized[pagePath] = { enabled, features };
  });

  return { sanitized, errors };
};

const enabledPagesFromPermissions = (permissions = {}) => (
  Object.entries(permissions)
    .filter(([, permission]) => permission?.enabled)
    .map(([pagePath]) => pagePath)
);

// @access  Private (superadmin only)
const getAllPages = async (req, res) => {
  try {
    const pagesWithFeatures = ALL_PAGES.map((page) => ({
      ...page,
      features: PAGE_FEATURES[page.path] || []
    }));
    res.json(pagesWithFeatures);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Login attempts are recorded on the audit trail (authController), so the most
// recent successful one per user doubles as "last login" without a second field
// on the User document.
const LOGIN_ACTIONS = ['login', 'login_failed'];

const lastLoginByUser = async (req) => {
  const rows = await AuditLog.aggregate([
    { $match: withTenant(req, { resource_type: 'user', action: 'login' }) },
    { $group: { _id: '$user_id', last_login: { $max: '$timestamp' } } }
  ]);
  return rows.reduce((acc, row) => {
    acc[row._id] = row.last_login;
    return acc;
  }, {});
};

// @desc    Get all users (for admin dropdown)
// @route   GET /api/rbac/users
// @access  Private (superadmin only)
const getAllUsers = async (req, res) => {
  try {
    const users = await User.find(withTenant(req))
      .select('id email full_name role state districts is_active created_by created_at monitoring_limits')
      .sort({ full_name: 1 })
      .lean();

    let lastLogins = {};
    try {
      lastLogins = await lastLoginByUser(req);
    } catch (aggError) {
      // A missing/empty audit collection must not break user management.
      console.error(`[rbac] last-login lookup failed: ${aggError.message}`);
    }

    res.json(users.map((u) => ({ ...u, last_login: lastLogins[u.id] || null })));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Login access history for this tenant (optionally one officer)
// @route   GET /api/rbac/login-history
// @access  Private (admin, or officer with access_management_tab_access)
const getLoginHistory = async (req, res) => {
  try {
    const { user_id, status = 'all', days, limit = 200 } = req.query;

    const filter = { resource_type: 'user', action: { $in: LOGIN_ACTIONS } };
    if (status === 'success') filter.action = 'login';
    if (status === 'failed') filter.action = 'login_failed';
    if (user_id) filter.user_id = user_id;

    const dayCount = parseInt(days, 10);
    if (Number.isFinite(dayCount) && dayCount > 0) {
      filter.timestamp = { $gte: new Date(Date.now() - dayCount * 24 * 60 * 60 * 1000) };
    }

    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);

    const logs = await AuditLog.find(withTenant(req, filter))
      .sort({ timestamp: -1 })
      .limit(safeLimit)
      .lean();

    res.json(logs.map((log) => ({
      id: log.id,
      user_id: log.user_id,
      user_name: log.user_name,
      user_email: log.user_email,
      status: log.action === 'login' ? 'success' : 'failed',
      reason: log.details?.reason || null,
      ip: log.details?.ip || null,
      device: log.details?.device || null,
      user_agent: log.details?.user_agent || null,
      timestamp: log.timestamp
    })));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Create a user (admin flow)
// @route   POST /api/rbac/users
// @access  Private (superadmin only)
const createUser = async (req, res) => {
  try {
    const { full_name, email, password, role, state, districts, monitoring_limits } = req.body;

    if (!full_name || !email || !password || !role) {
      return res.status(400).json({ message: 'Please add all fields' });
    }

    if (
      typeof full_name !== 'string' ||
      typeof email !== 'string' ||
      typeof password !== 'string' ||
      typeof role !== 'string' ||
      (state !== undefined && typeof state !== 'string') ||
      (districts !== undefined && !Array.isArray(districts))
    ) {
      return res.status(400).json({ message: 'Invalid field types' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const normalizedName = full_name.trim();
    const normalizedRole = role.trim();
    const normalizedState = String(state || '').trim();
    const normalizedDistricts = (Array.isArray(districts) ? districts : [])
      .map((d) => String(d).trim()).filter(Boolean);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) {
      return res.status(400).json({ message: 'Invalid email' });
    }

    if (password.length < 8 || password.length > 200) {
      return res.status(400).json({ message: 'Password must be 8–200 characters' });
    }

    if (normalizedName.length < 1 || normalizedName.length > 120) {
      return res.status(400).json({ message: 'Invalid full_name length' });
    }

    if (!['admin', 'level-1'].includes(normalizedRole)) {
      return res.status(400).json({ message: 'Invalid role' });
    }

    // Officers granted Access Management sub-permissions can create/manage other
    // officers, but only a true admin can create another admin.
    if (normalizedRole === 'admin' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only an admin can create another admin' });
    }

    // State is stored for every user (including admins, from the tenant's single
    // assigned state). Districts are only mandatory for non-admin roles — admins
    // aren't district-scoped.
    if (!normalizedState) {
      return res.status(400).json({ message: 'State is required' });
    }
    if (normalizedRole !== 'admin' && normalizedDistricts.length === 0) {
      return res.status(400).json({ message: 'At least one district is required for this role' });
    }

    if (!(await validDistrictsForTenant(req, normalizedDistricts))) {
      return res.status(400).json({ message: 'One or more districts are not assigned to this tenant' });
    }

    const userExists = await User.findOne({ email: normalizedEmail });
    if (userExists) {
      return res.status(400).json({ message: 'User already exists' });
    }

    const bcrypt = require('bcryptjs');
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = await User.create({
      email: normalizedEmail,
      password: hashedPassword,
      full_name: normalizedName,
      role: normalizedRole,
      state: normalizedState,
      districts: normalizedRole === 'admin' ? [] : normalizedDistricts,
      tenant_id: req.tenantId,
      created_by: req.user.id,
      // Per-officer monitoring volume caps (District Officers only). Absent =>
      // system defaults apply. Admins are never capped, so never store it for them.
      monitoring_limits: normalizedRole === 'admin' ? null : sanitizeLimitsInput(monitoring_limits),
    });

    // Seed default module permissions for officers (admins get everything via
    // their role and need no PagePermission doc). Best-effort: a failure here must
    // not roll back the created user — the admin can still assign permissions.
    if (normalizedRole !== 'admin') {
      try {
        const defaultPermissions = buildDefaultOfficerPermissions();
        await PagePermission.create({
          tenant_id: req.tenantId,
          user_id: user.id,
          permissions: defaultPermissions,
          allowed_pages: Object.keys(defaultPermissions),
          updated_by: req.user?.email || req.user?.id || ''
        });
      } catch (permErr) {
        console.error(`[rbac] Failed to seed default permissions for ${user.email}:`, permErr.message);
      }
    }

    logHistory(req, { module: 'users', action: 'create', recordId: user.id, recordLabel: user.full_name || user.email, state: user.state, districts: user.districts, changes: { full_name: user.full_name, email: user.email, role: user.role, state: user.state, districts: user.districts } });

    return res.status(201).json({
      message: 'User created successfully',
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        state: user.state,
        districts: user.districts,
        created_by: user.created_by,
        created_at: user.created_at,
      }
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: 'Email already exists' });
    }
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Get permissions for a specific user
// @route   GET /api/rbac/permissions/:userId
// @access  Private (superadmin only)
const getUserPermissions = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findOne({ ...withTenant(req), id: userId });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const permissionDoc = await PagePermission.findOne({ ...withTenant(req), user_id: userId });

    if (!permissionDoc) {
      const defaultPermissions = buildDefaultPermissions();
      return res.json({
        user_id: userId,
        allowed_pages: enabledPagesFromPermissions(defaultPermissions),
        permissions: defaultPermissions,
        has_custom_permissions: false
      });
    }

    const permissions = permissionDoc.permissions
      ? normalizePermissionsForRead(permissionDoc.permissions, { fillMissingFeatures: true })
      : buildPermissionsFromAllowedPages(permissionDoc.allowed_pages || []);

    res.json({
      user_id: userId,
      allowed_pages: enabledPagesFromPermissions(permissions),
      permissions,
      has_custom_permissions: true,
      updated_by: permissionDoc.updated_by,
      updated_at: permissionDoc.updated_at
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Set/update permissions for a specific user
// @route   PUT /api/rbac/permissions/:userId
// @access  Private (superadmin only)
const updateUserPermissions = async (req, res) => {
  try {
    const { userId } = req.params;
    const { permissions } = req.body;

    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
      return res.status(400).json({ message: 'permissions must be an object' });
    }

    const user = await User.findOne({ ...withTenant(req), id: userId });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.role === 'admin') {
      return res.status(403).json({ message: 'Cannot modify admin permissions' });
    }

    // An officer with the "Assign Module Permissions" grant can update other
    // officers' permissions, but not their own — otherwise the grant becomes a
    // self-service way to unlock more pages/features for themselves.
    if (req.user.role !== 'admin' && user.id === req.user.id) {
      return res.status(403).json({ message: 'You cannot modify your own permissions here' });
    }

    const { sanitized, errors } = validateAndNormalizePermissions(permissions);
    if (errors.length > 0) {
      return res.status(400).json({
        message: 'Invalid permissions payload',
        errors
      });
    }

    const allowedPages = enabledPagesFromPermissions(sanitized);

    // Tenant-scoped: the filter's tenant_id is auto-applied to the doc on upsert.
    const permissionDoc = await PagePermission.findOneAndUpdate(
      { ...withTenant(req), user_id: userId },
      {
        user_id: userId,
        allowed_pages: allowedPages,
        permissions: sanitized,
        updated_by: req.user.id,
        updated_at: new Date()
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({
      message: 'Permissions updated successfully',
      user_id: userId,
      allowed_pages: permissionDoc.allowed_pages,
      permissions: permissionDoc.permissions,
      has_custom_permissions: true,
      updated_by: permissionDoc.updated_by,
      updated_at: permissionDoc.updated_at
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get permissions for the currently logged-in user
// @route   GET /api/rbac/my-permissions
// @access  Private
const getMyPermissions = async (req, res) => {
  try {
    if (req.user.role === 'admin') {
      const permissions = buildAdminPermissions();
      return res.json({
        allowed_pages: enabledPagesFromPermissions(permissions),
        permissions,
        is_admin: true
      });
    }

    const permissionDoc = await PagePermission.findOne({ ...withTenant(req), user_id: req.user.id });
    if (!permissionDoc) {
      const defaultPermissions = buildDefaultPermissions();
      return res.json({
        allowed_pages: enabledPagesFromPermissions(defaultPermissions),
        permissions: defaultPermissions,
        has_custom_permissions: false
      });
    }

    let permissions = permissionDoc.permissions
      ? normalizePermissionsForRead(permissionDoc.permissions, { fillMissingFeatures: true })
      : buildPermissionsFromAllowedPages(permissionDoc.allowed_pages || []);

    if (Object.keys(permissions).length === 0) {
      permissions = buildDefaultPermissions();
    }

    res.json({
      allowed_pages: enabledPagesFromPermissions(permissions),
      permissions,
      has_custom_permissions: true
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Shared guard for activate/deactivate. Returns an error message when the change
// would lock the tenant out (last active admin), lock the caller out of their own
// account, or let an officer act on an admin — otherwise null.
const validateStatusChange = async (req, user, nextActive) => {
  if (user.role === 'admin' && req.user.role !== 'admin') {
    return 'Only an admin can change an admin account';
  }
  if (nextActive) return null;

  if (user.id === req.user.id) {
    return 'You cannot deactivate your own account';
  }
  if (user.role === 'admin') {
    const activeAdmins = await User.countDocuments({ ...withTenant(req), role: 'admin', is_active: true });
    if (activeAdmins <= 1) {
      return 'Cannot deactivate the last active admin in this tenant';
    }
  }
  return null;
};

// @desc    Activate / deactivate a user (an inactive user cannot log in)
// @route   PATCH /api/rbac/users/:userId/status
// @access  Private (admin, or officer with edit_user)
const updateUserStatus = async (req, res) => {
  try {
    const { userId } = req.params;
    const { is_active } = req.body;

    if (typeof is_active !== 'boolean') {
      return res.status(400).json({ message: 'is_active must be a boolean' });
    }

    const user = await User.findOne({ ...withTenant(req), id: userId });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const statusError = await validateStatusChange(req, user, is_active);
    if (statusError) {
      return res.status(400).json({ message: statusError });
    }

    user.is_active = is_active;
    user.updated_by = req.user?.email || req.user?.id || '';
    user.updated_at = new Date();
    await user.save();

    logHistory(req, {
      module: 'users',
      action: 'update',
      recordId: user.id,
      recordLabel: user.full_name || user.email,
      state: user.state,
      districts: user.districts,
      changes: { is_active: user.is_active }
    });

    res.json({
      message: `User ${is_active ? 'activated' : 'deactivated'} successfully`,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        is_active: user.is_active
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update user details (name, email, role, password)
// @route   PUT /api/rbac/users/:userId
// @access  Private (superadmin only)
const updateUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { full_name, email, role, password, state, districts, monitoring_limits, is_active } = req.body;

    const user = await User.findOne({ ...withTenant(req), id: userId });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // An officer using Access Management's "Edit User" grant can edit other
    // officers, but not their own account through this admin-facing endpoint —
    // otherwise the grant becomes a self-service role/permission escalation path.
    if (req.user.role !== 'admin' && user.id === req.user.id) {
      return res.status(403).json({ message: 'You cannot edit your own account here' });
    }

    // Officers granted Access Management sub-permissions can edit other officers,
    // but only a true admin can touch an existing admin's account or promote
    // someone to admin.
    if (req.user.role !== 'admin' && (user.role === 'admin' || role === 'admin')) {
      return res.status(403).json({ message: 'Only an admin can create or modify an admin account' });
    }

    // Prevent downgrading the last admin (basic safeguard)
    if (user.role === 'admin' && role !== 'admin') {
      const adminCount = await User.countDocuments({ ...withTenant(req), role: 'admin' });
      if (adminCount <= 1) {
        return res.status(400).json({ message: 'Cannot change the role of the last admin in this tenant' });
      }
    }

    const effectiveRole = role || user.role;
    if (state !== undefined || districts !== undefined) {
      const normalizedState = String(state !== undefined ? state : user.state || '').trim();
      const normalizedDistricts = (Array.isArray(districts) ? districts : (districts !== undefined ? [] : user.districts || []))
        .map((d) => String(d).trim()).filter(Boolean);

      // State is stored for every user, including admins. Districts are only
      // mandatory for non-admin roles — admins aren't district-scoped.
      if (!normalizedState) {
        return res.status(400).json({ message: 'State is required' });
      }
      if (effectiveRole !== 'admin' && normalizedDistricts.length === 0) {
        return res.status(400).json({ message: 'At least one district is required for this role' });
      }
      if (!(await validDistrictsForTenant(req, normalizedDistricts))) {
        return res.status(400).json({ message: 'One or more districts are not assigned to this tenant' });
      }
      user.state = normalizedState;
      user.districts = effectiveRole === 'admin' ? [] : normalizedDistricts;
    } else if (effectiveRole === 'admin' && role) {
      // Role changed to admin without an explicit state/districts payload — keep
      // the stored state, just drop district scoping.
      user.districts = [];
    }

    if (typeof is_active === 'boolean' && is_active !== user.is_active) {
      const statusError = await validateStatusChange(req, user, is_active);
      if (statusError) {
        return res.status(400).json({ message: statusError });
      }
      user.is_active = is_active;
    }

    user.full_name = full_name || user.full_name;
    // Normalize email so it matches the login lookup (lowercase + trim).
    if (email) user.email = String(email).toLowerCase().trim();
    user.role = role || user.role;

    // Per-officer monitoring caps. Only meaningful for District Officers; if the
    // account is (or becomes) an admin, clear any stored caps since admins are
    // never enforced. Only touch the field when the admin actually submitted it.
    let limitsChanged = false;
    if (monitoring_limits !== undefined) {
      if (effectiveRole === 'admin') {
        user.monitoring_limits = null;
      } else {
        const nextLimits = sanitizeLimitsInput(monitoring_limits);
        // Only treat this as a change (and thus run auto-pause reconciliation)
        // when the submitted caps actually DIFFER from what's stored. The edit
        // modal always includes monitoring_limits in the payload, so without
        // this an unrelated edit (e.g. renaming the officer) would spuriously
        // reconcile active profiles/events down to defaults.
        if (!limitsEqual(nextLimits, user.monitoring_limits)) {
          user.monitoring_limits = nextLimits;
          limitsChanged = true;
        }
      }
    }

    // Only update password if provided
    if (password && password.trim() !== '') {
      const bcrypt = require('bcryptjs');
      const salt = await bcrypt.genSalt(10);
      user.password = await bcrypt.hash(password, salt);
    }

    user.updated_by = req.user?.email || req.user?.id || '';
    user.updated_at = new Date();
    await user.save();

    // Auto-pause reconciliation: if the admin lowered a cap below what's already
    // active for this officer, bring the active count under the new cap by
    // pausing the newest excess. Best-effort — a failure here must not fail the
    // save (the caps are still persisted and enforced on the next activation).
    let reconciled = { paused_profiles: 0, paused_events: 0 };
    if (limitsChanged) {
      try {
        reconciled = await reconcileActiveToLimits(req, user);
      } catch (reconcileErr) {
        console.error(`[rbac] monitoring-limit reconciliation failed for ${user.email}:`, reconcileErr.message);
      }
    }

    logHistory(req, { module: 'users', action: 'update', recordId: user.id, recordLabel: user.full_name || user.email, state: user.state, districts: user.districts, changes: { full_name: user.full_name, email: user.email, role: user.role, state: user.state, districts: user.districts } });

    res.json({
      message: 'User updated successfully',
      reconciled,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        state: user.state,
        districts: user.districts
      }
    });

  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: 'Email already exists' });
    }
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete a user
// @route   DELETE /api/rbac/users/:userId
// @access  Private (superadmin only)
const deleteUser = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findOne({ ...withTenant(req), id: userId });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Officers granted Access Management sub-permissions can delete other
    // officers, but only a true admin can delete an admin account.
    if (user.role === 'admin' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only an admin can delete an admin account' });
    }

    if (user.role === 'admin') {
      const adminCount = await User.countDocuments({ ...withTenant(req), role: 'admin' });
      if (adminCount <= 1) {
        return res.status(400).json({ message: 'Cannot delete the last admin in this tenant' });
      }
    }

    // Prevent self-deletion
    if (user.id === req.user.id) {
      return res.status(400).json({ message: 'Cannot delete your own account' });
    }

    await User.findOneAndDelete({ ...withTenant(req), id: userId });

    // Cleanup related permissions
    await PagePermission.findOneAndDelete({ ...withTenant(req), user_id: userId });

    logHistory(req, { module: 'users', action: 'delete', recordId: userId, recordLabel: user.full_name || user.email, state: user.state, districts: user.districts, changes: { full_name: user.full_name, email: user.email, role: user.role } });

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete several users at once
// @route   POST /api/rbac/users/bulk-delete
// @access  Private (admin, or officer with delete_user)
// Partial success is the norm here: undeletable rows (yourself, an admin when
// the caller isn't one, the last admin, ids from another tenant) are reported
// back as `skipped` rather than failing the whole batch.
const bulkDeleteUsers = async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.user_ids) ? uniqueStrings(req.body.user_ids) : [];
    if (ids.length === 0) {
      return res.status(400).json({ message: 'user_ids must be a non-empty array' });
    }

    const users = await User.find({ ...withTenant(req), id: { $in: ids } }).lean();
    const found = new Map(users.map((u) => [u.id, u]));
    const adminCount = await User.countDocuments({ ...withTenant(req), role: 'admin' });
    const adminsRequested = users.filter((u) => u.role === 'admin').length;

    const deleted = [];
    const skipped = [];

    for (const id of ids) {
      const user = found.get(id);
      if (!user) {
        skipped.push({ id, reason: 'User not found' });
        continue;
      }
      if (user.id === req.user.id) {
        skipped.push({ id, name: user.full_name, reason: 'Cannot delete your own account' });
        continue;
      }
      if (user.role === 'admin' && req.user.role !== 'admin') {
        skipped.push({ id, name: user.full_name, reason: 'Only an admin can delete an admin account' });
        continue;
      }
      // Every admin in the batch must leave at least one admin behind.
      if (user.role === 'admin' && adminCount - adminsRequested < 1) {
        skipped.push({ id, name: user.full_name, reason: 'Cannot delete the last admin in this tenant' });
        continue;
      }

      await User.findOneAndDelete({ ...withTenant(req), id });
      await PagePermission.findOneAndDelete({ ...withTenant(req), user_id: id });
      deleted.push(id);

      logHistory(req, {
        module: 'users',
        action: 'delete',
        recordId: id,
        recordLabel: user.full_name || user.email,
        state: user.state,
        districts: user.districts,
        changes: { full_name: user.full_name, email: user.email, role: user.role, bulk: true }
      });
    }

    res.json({
      message: `${deleted.length} user(s) deleted`,
      deleted_count: deleted.length,
      deleted,
      skipped
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};


module.exports = {
  createUser,
  getAllPages,
  getAllUsers,
  getUserPermissions,
  updateUserPermissions,
  getMyPermissions,
  updateUser,
  updateUserStatus,
  deleteUser,
  bulkDeleteUsers,
  getLoginHistory,
  ALL_PAGES,
  PAGE_FEATURES
};
