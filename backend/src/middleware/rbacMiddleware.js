const PagePermission = require('../models/PagePermission');
const { ALL_PAGES, PAGE_FEATURES } = require('../config/rbacConfig');

const PAGE_PATHS = new Set(ALL_PAGES.map((page) => page.path));
const FEATURE_IDS_BY_PAGE = Object.fromEntries(
  Object.entries(PAGE_FEATURES).map(([pagePath, features]) => [pagePath, new Set(features.map((feature) => feature.id))])
);

const MONITOR_PLATFORM_TO_FEATURE = {
  x: 'x',
  twitter: 'x',
  facebook: 'facebook',
  instagram: 'instagram',
  youtube: 'youtube'
};

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

const buildDefaultPermissions = () => ({
  '/dashboard': { enabled: true, features: [] }
});

const buildSuperAdminPermissions = () => {
  const permissions = {};
  ALL_PAGES.forEach((page) => {
    permissions[page.path] = {
      enabled: true,
      features: PAGE_FEATURES[page.path]?.map((feature) => feature.id) || []
    };
  });
  return permissions;
};

const normalizePermissions = (rawPermissions = {}, { fillMissingFeatures = false } = {}) => {
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

const enabledPagesFromPermissions = (permissions = {}) => (
  Object.entries(permissions)
    .filter(([, permission]) => permission?.enabled)
    .map(([pagePath]) => pagePath)
);

const denyPageAccess = (res, requiredPages = []) => res.status(403).json({
  code: 'RBAC_PAGE_DENIED',
  message: 'You do not have access to this module',
  required_pages: requiredPages
});

const denyFeatureAccess = (res, pagePath, featureId) => res.status(403).json({
  code: 'RBAC_FEATURE_DENIED',
  message: 'You do not have access to this feature',
  page: pagePath,
  feature: featureId
});

const ensureRbacLoaded = async (req) => {
  if (req.rbac) return req.rbac;

  if (!req.user) {
    const error = new Error('Not authorized');
    error.status = 401;
    throw error;
  }

  // 'admin' is the tenant's full-access application role (everything). 'superadmin'
  // is kept as a legacy alias so existing top-role users keep full access.
  if (req.user.role === 'admin' || req.user.role === 'superadmin') {
    const permissions = buildSuperAdminPermissions();
    req.rbac = {
      isSuperAdmin: true,
      permissions,
      allowedPages: enabledPagesFromPermissions(permissions)
    };
    return req.rbac;
  }

  const permissionDoc = await PagePermission.findOne({ user_id: req.user.id }).lean();
  let permissions;

  if (!permissionDoc) {
    permissions = buildDefaultPermissions();
  } else {
    permissions = permissionDoc.permissions
      ? normalizePermissions(permissionDoc.permissions, { fillMissingFeatures: true })
      : buildPermissionsFromAllowedPages(permissionDoc.allowed_pages || []);

    if (Object.keys(permissions).length === 0) {
      permissions = buildDefaultPermissions();
    }
  }

  req.rbac = {
    isSuperAdmin: false,
    permissions,
    allowedPages: enabledPagesFromPermissions(permissions)
  };

  return req.rbac;
};

const loadUserPermissions = async (req, res, next) => {
  try {
    await ensureRbacLoaded(req);
    next();
  } catch (error) {
    if (error.status === 401) {
      return res.status(401).json({ message: 'Not authorized' });
    }
    return res.status(500).json({ message: 'Failed to load RBAC permissions' });
  }
};

const hasPageAccess = (req, pagePath) => {
  if (req.rbac?.isSuperAdmin) return true;
  const normalizedPagePath = normalizePath(pagePath);
  return Boolean(req.rbac?.permissions?.[normalizedPagePath]?.enabled);
};

const hasFeatureAccess = (req, pagePath, featureId) => {
  if (req.rbac?.isSuperAdmin) return true;

  const normalizedPagePath = normalizePath(pagePath);
  const pagePermission = req.rbac?.permissions?.[normalizedPagePath];
  if (!pagePermission?.enabled) return false;

  const featureSet = FEATURE_IDS_BY_PAGE[normalizedPagePath];
  if (!featureSet || featureSet.size === 0) return true;
  if (!featureId || typeof featureId !== 'string') return false;

  return Array.isArray(pagePermission.features) && pagePermission.features.includes(featureId);
};

const resolveValue = (resolver, req) => {
  if (typeof resolver === 'function') return resolver(req);
  return resolver;
};

const requireAnyPageAccess = (allowedPages = []) => async (req, res, next) => {
  try {
    await ensureRbacLoaded(req);
  } catch (error) {
    if (error.status === 401) return res.status(401).json({ message: 'Not authorized' });
    return res.status(500).json({ message: 'Failed to evaluate RBAC permissions' });
  }

  if (req.rbac.isSuperAdmin) return next();
  if (allowedPages.some((pagePath) => hasPageAccess(req, pagePath))) return next();

  return denyPageAccess(res, allowedPages);
};

const requireFeatureAccess = (pagePath, featureResolver, options = {}) => async (req, res, next) => {
  try {
    await ensureRbacLoaded(req);
  } catch (error) {
    if (error.status === 401) return res.status(401).json({ message: 'Not authorized' });
    return res.status(500).json({ message: 'Failed to evaluate RBAC permissions' });
  }

  if (req.rbac.isSuperAdmin) return next();
  if (!hasPageAccess(req, pagePath)) return denyPageAccess(res, [pagePath]);

  let featureId = resolveValue(featureResolver, req);
  if (featureId === null || typeof featureId === 'undefined' || featureId === '') {
    if (options.allowWhenMissing) return next();
    return denyFeatureAccess(res, pagePath, 'unknown');
  }

  featureId = String(featureId).toLowerCase();
  if (options.aliases && options.aliases[featureId]) {
    featureId = options.aliases[featureId];
  }

  if (hasFeatureAccess(req, pagePath, featureId)) return next();
  return denyFeatureAccess(res, pagePath, featureId);
};

const requirePlatformFeatureAccess = (pagePath, platformResolver) => async (req, res, next) => {
  try {
    await ensureRbacLoaded(req);
  } catch (error) {
    if (error.status === 401) return res.status(401).json({ message: 'Not authorized' });
    return res.status(500).json({ message: 'Failed to evaluate RBAC permissions' });
  }

  if (req.rbac.isSuperAdmin) return next();

  const rawPlatform = resolveValue(platformResolver, req);
  if (!rawPlatform || typeof rawPlatform !== 'string') return next();

  const normalizedPlatform = rawPlatform.toLowerCase();
  const featureId = MONITOR_PLATFORM_TO_FEATURE[normalizedPlatform];
  if (!featureId) return next();

  if (hasFeatureAccess(req, pagePath, featureId)) return next();

  return denyFeatureAccess(res, pagePath, featureId);
};

// Role-based RBAC functions (for multi-tenant)
const { hasPermission: checkPermission, hasRole: checkRole } = require('../config/rbacConfig');

const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const hasAllowedRole = allowedRoles.some(role => {
      return req.user.role === role || checkRole(req.user.role, role);
    });

    if (!hasAllowedRole) {
      console.log(`[RBAC] Role authorization denied for ${req.user.email} (${req.user.role})`);
      return res.status(403).json({
        message: 'Insufficient role',
        required_roles: allowedRoles,
        user_role: req.user.role
      });
    }

    console.log(`[RBAC] Role authorization granted for ${req.user.email} (${req.user.role})`);
    next();
  };
};

const requirePermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const authorized = checkPermission(req.user.role, permission);

    if (!authorized) {
      console.log(`[RBAC] Permission denied: ${permission} for ${req.user.email} (${req.user.role})`);
      return res.status(403).json({
        message: 'Insufficient permissions',
        required_permission: permission,
        user_role: req.user.role
      });
    }

    console.log(`[RBAC] Permission granted: ${permission} for ${req.user.email} (${req.user.role})`);
    next();
  };
};

module.exports = {
  loadUserPermissions,
  requireAnyPageAccess,
  requireFeatureAccess,
  requirePlatformFeatureAccess,
  hasPageAccess,
  hasFeatureAccess,
  denyPageAccess,
  denyFeatureAccess,
  authorize,
  requirePermission
};
