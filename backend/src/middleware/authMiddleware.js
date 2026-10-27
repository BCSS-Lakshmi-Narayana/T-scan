const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { validateSingleSession } = require('../utils/sessionSecurity');
const { getTenantContext, runWithTenant } = require('../config/tenantContext');
const { forTenant, isPerTenant } = require('../config/tenantConnections');
const { findActiveTenantById } = require('../services/tenantLookupService');
const { readTokenCookie } = require('../utils/authCookie');

const getTokenFromHeader = (req) => {
  // The httpOnly cookie is the normal path for browser sessions. The header
  // forms below still work for service-to-service callers, and for sessions
  // issued before the cookie existed.
  const cookieToken = readTokenCookie(req);
  if (cookieToken) return cookieToken;

  if (req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      return parts[1];
    }
    return req.headers.authorization;
  }

  return req.headers['x-access-token'];
};

const protect = async (req, res, next) => {
  const token = getTokenFromHeader(req);
  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET || 'blura-hub-secret-key-change-in-production');
  } catch (error) {
    return res.status(401).json({ message: 'Not authorized, token failed' });
  }

  // Everything below reads User, which is tenant-scoped — so it must run with a
  // tenant in scope. Kept as one function so it can be invoked either directly
  // (a scope already exists) or wrapped in one (see below).
  const authorizeRequest = async () => {
    try {
      // Get user from the token (use 'sub' for new JWT format, fallback to 'user_id' for backward compatibility)
      // `+active_session` opts the normally-hidden session field into THIS query
      // so the single-session check below costs no extra DB round-trip. It is
      // stripped from req.user immediately after, so no downstream code ever sees it.
      const userId = decoded.sub || decoded.user_id;
      req.user = await User.findOne({ id: userId }).select('-password +active_session').lean();

      if (!req.user) {
        return res.status(401).json({ message: 'Not authorized, user not found' });
      }

      // Single-active-session enforcement (District Officers only). This layer
      // covers routes that mount protect() directly ahead of the global gate —
      // notably GET /api/auth/me, which the frontend calls on app load to
      // validate the token. A no-op for admins/superadmins.
      const activeSession = req.user.active_session;
      delete req.user.active_session; // never expose the session record downstream
      const sessionCheck = validateSingleSession(req.user.role, decoded.sid, activeSession);
      if (!sessionCheck.ok) {
        return res.status(401).json({ code: sessionCheck.code, message: sessionCheck.message });
      }

      // Set tenantId from JWT payload
      req.tenantId = decoded.tenantId || req.user.tenant_id;

      next();
    } catch (error) {
      console.error(error);
      return res.status(401).json({ message: 'Not authorized, token failed' });
    }
  };

  // Some routers mount ahead of tenantMiddleware on purpose — /api/media most of
  // all, because a native <img>/<video> cannot attach an Authorization or
  // X-Tenant-Slug header. Those requests reach protect() with no tenant in scope,
  // and under TENANT_DB_MODE=per-tenant the User model refuses to resolve without
  // one. The token names its own tenant, so derive the scope from that; routes
  // mounted after the tenant gate already have a scope and keep it.
  if (isPerTenant() && !getTenantContext()) {
    const tenantId = decoded.tenantId;
    if (!tenantId) {
      return res.status(401).json({ message: 'Not authorized, token carries no tenant' });
    }
    let tenant;
    try {
      tenant = await findActiveTenantById(tenantId);
    } catch (error) {
      console.error('[protect] tenant lookup failed:', error.message);
      return res.status(500).json({ message: 'Tenant resolution failed' });
    }
    if (!tenant) {
      return res.status(403).json({ message: 'Tenant not found or inactive' });
    }
    return runWithTenant({ tenant, tenantId: tenant.id, connection: forTenant(tenant) }, authorizeRequest);
  }

  return authorizeRequest();
};

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ 
        message: `User role ${req.user.role} is not authorized to access this route`
      });
    }
    next();
  };
};

module.exports = { protect, authorize };
