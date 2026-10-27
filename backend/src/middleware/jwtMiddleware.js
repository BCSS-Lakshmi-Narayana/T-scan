const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { isEnforcedRole, validateSingleSession } = require('../utils/sessionSecurity');
const { readTokenCookie } = require('../utils/authCookie');

// Only re-write last_active_at when it's this stale, so a busy officer doesn't
// generate a DB write on every single request.
const LAST_ACTIVE_THROTTLE_MS = 60 * 1000;

const jwtMiddleware = async (req, res, next) => {
  console.log(`[jwtMiddleware] ${req.method} ${req.path}`);
  try {
    // httpOnly cookie first; Authorization header kept for non-browser callers.
    const token = readTokenCookie(req) || req.headers.authorization?.split(' ')[1];

    if (!token) {
      console.log('[jwtMiddleware] No token provided');
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'blura-hub-secret-key-change-in-production');
    console.log('[jwtMiddleware] Token verified for:', decoded.email);

    // Single-active-session enforcement (District Officers only). This is the
    // UNIVERSAL gate every protected /api route passes through, so it's the
    // authoritative enforcement point. For non-enforced roles (admin/superadmin)
    // we do NOTHING extra — no DB query, identical behaviour to before.
    if (isEnforcedRole(decoded.role)) {
      const dbUser = await User.findOne({ id: decoded.sub || decoded.id }).select('active_session').lean();
      const activeSession = dbUser && dbUser.active_session;
      const sessionCheck = validateSingleSession(decoded.role, decoded.sid, activeSession);
      if (!sessionCheck.ok) {
        console.log('[jwtMiddleware] Session rejected:', sessionCheck.reason);
        return res.status(401).json({ code: sessionCheck.code, message: sessionCheck.message });
      }
      // Throttled "last active" refresh (fire-and-forget; never blocks the request).
      const last = activeSession.last_active_at ? new Date(activeSession.last_active_at).getTime() : 0;
      if (Date.now() - last > LAST_ACTIVE_THROTTLE_MS) {
        User.updateOne({ id: decoded.sub || decoded.id }, { $set: { 'active_session.last_active_at': new Date() } }).catch(() => {});
      }
    }

    req.user = {
      id: decoded.sub || decoded.id,
      email: decoded.email,
      role: decoded.role,
      tenantId: decoded.tenantId
    };
    req.tenantId = decoded.tenantId;
    console.log('[jwtMiddleware] TenantId set to:', req.tenantId);

    next();
  } catch (error) {
    console.log('[jwtMiddleware] Error:', error.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
};

module.exports = jwtMiddleware;
