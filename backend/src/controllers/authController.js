const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const { createAuditLog } = require('../services/auditService');
const { sendPasswordResetEmail } = require('../utils/mailer');
const { isEnforcedRole, parseUserAgent } = require('../utils/sessionSecurity');

const ACCESS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

// `sessionId`, when provided, is embedded as the `sid` claim so single-session
// enforcement can match this token against the user's stored active_session.
// It is only ever passed for enforced roles (District Officers); admin/superadmin
// tokens are minted exactly as before (no sid), so their behaviour is unchanged.
const { setAuthCookie, clearAuthCookie } = require('../utils/authCookie');

const generateToken = (user, sessionId = null) => {
  const payload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    tenantId: user.tenant_id
  };
  if (sessionId) payload.sid = sessionId;
  return jwt.sign(
    payload,
    process.env.JWT_SECRET || 'blura-hub-secret-key-change-in-production',
    { expiresIn: '24h' }
  );
};

const generateRefreshToken = (user) => {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenant_id
    },
    process.env.REFRESH_TOKEN_SECRET || process.env.JWT_SECRET || 'blura-hub-secret-key-change-in-production',
    { expiresIn: '7d' }
  );
};

const getTokenFromRequest = (req) => {
  if (req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      return parts[1];
    }
    return req.headers.authorization;
  }
  if (req.headers['x-refresh-token']) {
    return req.headers['x-refresh-token'];
  }
  return req.body.refresh_token;
};

// @desc    Register new user
// @route   POST /api/auth/register
// @access  Public (for super admin creating initial tenant admin)
const register = async (req, res) => {
  try {
    const { email, password, full_name, tenant_id } = req.body;

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'role')) {
      return res.status(400).json({ message: 'role cannot be set on registration' });
    }

    if (!email || !password || !full_name || !tenant_id) {
      return res.status(400).json({ message: 'Please add all required fields (email, password, full_name, tenant_id)' });
    }

    if (typeof email !== 'string' || typeof password !== 'string' || typeof full_name !== 'string' || typeof tenant_id !== 'string') {
      return res.status(400).json({ message: 'Invalid field types' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return res.status(400).json({ message: 'Invalid email' });
    }
    if (password.length < 8 || password.length > 200) {
      return res.status(400).json({ message: 'Password must be 8–200 characters' });
    }
    if (full_name.length < 1 || full_name.length > 120) {
      return res.status(400).json({ message: 'Invalid full_name length' });
    }

    // Verify tenant exists and is active
    const tenant = await Tenant.findOne({ id: tenant_id, status: { $in: ['trial', 'active'] } });
    if (!tenant) {
      return res.status(404).json({ message: 'Tenant not found or inactive' });
    }

    // Check if user exists
    // Normalize email so storage matches login lookup (lowercase + trim).
    const normalizedEmail = email.toLowerCase().trim();
    const userExists = await User.findOne({ email: normalizedEmail });

    if (userExists) {
      return res.status(400).json({ message: 'User already exists' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = await User.create({
      email: normalizedEmail,
      password: hashedPassword,
      full_name,
      role: 'level-1',
      tenant_id: tenant_id
    });

    if (user) {
      res.status(201).json({
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        tenant_id: user.tenant_id,
        created_at: user.created_at
      });
    } else {
      res.status(400).json({ message: 'Invalid user data' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Where the attempt came from — surfaced in Access Management > Login History.
// `device` reuses the session-security UA parser so the label matches the one
// shown in the single-session dialog.
const requestOrigin = (req) => ({
  ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip,
  device: parseUserAgent(req.headers['user-agent']),
  user_agent: String(req.headers['user-agent'] || '').slice(0, 512) || null
});

// A rejected attempt is logged against the account it targeted so admins can see
// repeated failures. Unknown emails have no account (and no tenant) to attach to,
// so they are logged against the host tenant with the attempted address.
const logFailedLogin = async (req, user, reason, attemptedEmail) => {
  const tenantId = user?.tenant_id || req.tenant?.id || req.tenantId;
  if (!tenantId) return;

  await createAuditLog(
    user || { id: 'unknown', email: attemptedEmail || 'unknown', full_name: 'Unknown user' },
    'login_failed',
    'user',
    user?.id || null,
    { ...requestOrigin(req), reason, attempted_email: attemptedEmail },
    tenantId
  ).catch(() => { });
};

// @desc    Authenticate a user
// @route   POST /api/auth/login
// @access  Public
const login = async (req, res) => {
  try {
    const { password } = req.body;
    // A truthy `force` means the user has seen the "already signed in elsewhere"
    // prompt and chosen to take over the session — revoke the old one and log in.
    const force = req.body.force === true || req.body.force === 'true';
    // Normalize email to match how users are stored (createUser/register store it
    // lowercased + trimmed), so login is NOT case/whitespace sensitive. Without this,
    // an officer created via Access Management can't log in unless the email is typed
    // in the exact lowercase form.
    const email = String(req.body.email || '').toLowerCase().trim();

    // Check for user email. `+active_session` opts the normally-hidden session
    // field into this query so we can detect an existing live session.
    const user = await User.findOne({ email }).select('+active_session');

    if (user && (await bcrypt.compare(password, user.password))) {
      if (!user.is_active) {
        await logFailedLogin(req, user, 'account_inactive', email);
        return res.status(403).json({ message: 'Account is inactive' });
      }

      // Validate user's tenant exists and is active
      if (!user.tenant_id) {
        return res.status(403).json({ message: 'User has no tenant assigned' });
      }

      const tenant = await Tenant.findOne({ id: user.tenant_id, status: { $in: ['trial', 'active'] } });
      if (!tenant) {
        await logFailedLogin(req, user, 'tenant_inactive', email);
        return res.status(403).json({ message: 'Tenant inactive or not found' });
      }

      const now = new Date();
      const enforced = isEnforcedRole(user.role);
      const prevSession = user.active_session;

      // Single-session gate (District Officers only). If a live session already
      // exists and this is NOT a deliberate takeover, tell the client about it
      // WITHOUT issuing a token, so it can show the "sign out other session?" prompt.
      if (enforced && !force) {
        const live = prevSession
          && prevSession.session_id
          && (!prevSession.expires_at || new Date(prevSession.expires_at).getTime() > now.getTime());
        if (live) {
          return res.status(409).json({
            code: 'SESSION_CONFLICT',
            message: 'You are already signed in on another device.',
            existing_session: {
              device: prevSession.device || 'Unknown device',
              login_at: prevSession.login_at,
              last_active_at: prevSession.last_active_at || prevSession.login_at,
            }
          });
        }
      }

      await createAuditLog(user, 'login', 'user', user.id, requestOrigin(req));

      // Mint a session id + JWT sid ONLY for enforced roles. For admins/superadmins
      // this stays null, so their token shape and behaviour are byte-for-byte as before.
      let sessionId = null;
      const update = {};
      if (enforced) {
        sessionId = crypto.randomUUID();
        update.active_session = {
          session_id: sessionId,
          device: parseUserAgent(req.headers['user-agent']),
          user_agent: String(req.headers['user-agent'] || '').slice(0, 512),
          ip: req.ip || '',
          login_at: now,
          last_active_at: now,
          expires_at: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS),
        };
        // If we're overwriting a DIFFERENT live session (a takeover), record it.
        if (force && prevSession && prevSession.session_id && prevSession.session_id !== sessionId) {
          createAuditLog(user, 'session_forced_logout', 'user', user.id, {
            ip: req.ip,
            revoked_device: prevSession.device || null,
          }).catch(() => {});
        }
      }

      const access_token = generateToken(user, sessionId);
      const refresh_token = generateRefreshToken(user);
      update.refreshToken = refresh_token;
      update.refreshTokenExpiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      await User.findByIdAndUpdate(user._id, update);

      // The browser session now rides on an httpOnly cookie. access_token stays
      // in the body so non-browser clients (and any older build still reading it)
      // keep working.
      setAuthCookie(res, access_token);

      res.json({
        access_token,
        refresh_token,
        token_type: 'bearer',
        expires_in: 24 * 60 * 60,
        refresh_expires_in: 7 * 24 * 60 * 60,
        user: {
          id: user.id,
          email: user.email,
          full_name: user.full_name,
          role: user.role,
          tenant_id: user.tenant_id
        }
      });
    } else {
      // Rejected credentials. The response stays deliberately generic (no
      // enumeration), but the audit entry records which of the two it was.
      await logFailedLogin(req, user, user ? 'invalid_password' : 'user_not_found', email);
      res.status(401).json({ message: 'Invalid credentials' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Refresh an access token
// @route   POST /api/auth/refresh
// @access  Public
const refreshToken = async (req, res) => {
  try {
    const token = getTokenFromRequest(req);

    if (!token) {
      return res.status(401).json({ message: 'Refresh token is required' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.REFRESH_TOKEN_SECRET || process.env.JWT_SECRET || 'blura-hub-secret-key-change-in-production');
    } catch (error) {
      return res.status(401).json({ message: 'Invalid or expired refresh token' });
    }

    const userId = decoded.sub || decoded.user_id;
    const user = await User.findOne({ id: userId }).select('+active_session');
    if (!user || !user.refreshToken || user.refreshToken !== token) {
      return res.status(401).json({ message: 'Refresh token not recognized' });
    }

    if (user.refreshTokenExpiresAt && user.refreshTokenExpiresAt < new Date()) {
      return res.status(401).json({ message: 'Refresh token expired' });
    }

    // Single-session (District Officers): a refresh must NOT create a new session
    // — it re-issues an access token bound to the SAME active session id. If that
    // session was revoked (logout / taken over on another device), refresh fails
    // closed rather than reviving a dead session.
    let sessionId = null;
    if (isEnforcedRole(user.role)) {
      const active = user.active_session;
      if (!active || !active.session_id) {
        return res.status(401).json({ code: 'SESSION_REVOKED', message: 'Your session has ended. Please sign in again.' });
      }
      sessionId = active.session_id;
    }

    const access_token = generateToken(user, sessionId);
    const refresh_token = generateRefreshToken(user);
    const refreshExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    user.refreshToken = refresh_token;
    user.refreshTokenExpiresAt = refreshExpiresAt;
    // Keep the active session's sliding fields fresh while the user keeps refreshing.
    if (sessionId && user.active_session) {
      user.active_session.last_active_at = new Date();
      user.active_session.expires_at = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
    }
    await user.save();

    // A refresh mints a new access token, so the cookie has to follow it —
    // otherwise the browser keeps presenting the previous, soon-expired one.
    setAuthCookie(res, access_token);

    res.json({
      access_token,
      refresh_token,
      token_type: 'bearer',
      expires_in: 24 * 60 * 60,
      refresh_expires_in: 7 * 24 * 60 * 60
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Log out — end the current server-side session
// @route   POST /api/auth/logout
// @access  Private (protect)
// Clears the user's active_session + refresh token so the token in hand (and any
// other copy of it) is immediately rejected on its next request. Safe for every
// role: for non-enforced roles active_session was already null, so this just
// revokes the refresh token. Idempotent and best-effort by design.
const logout = async (req, res) => {
  try {
    await User.findOneAndUpdate(
      { id: req.user.id },
      { $set: { active_session: null, refreshToken: '', refreshTokenExpiresAt: null } }
    );
    createAuditLog(req.user, 'logout', 'user', req.user.id, { ip: req.ip }).catch(() => {});
    clearAuthCookie(res);
    res.status(200).json({ message: 'Logged out' });
  } catch (error) {
    // The session is revoked server-side regardless, so the cookie must go even
    // on a failure path — otherwise the browser keeps sending a dead token.
    clearAuthCookie(res);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get user data
// @route   GET /api/auth/me
// @access  Private
const getMe = async (req, res) => {
  try {
    // Ensure we have the complete user object
    const user = await User.findOne({ id: req.user.id }).select('-password').lean();
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.status(200).json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Send password-reset email
// @route   POST /api/auth/forgot-password
// @access  Public
const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });

    // Always return 200 to prevent email enumeration
    if (!user || !user.is_active) {
      return res.json({ message: 'If that email exists, a reset link has been sent.' });
    }

    // Generate a secure random token
    const rawToken = crypto.randomBytes(32).toString('hex');
    // Store a hash of the token (never store raw tokens)
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    user.passwordResetToken = hashedToken;
    user.passwordResetExpires = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
    await user.save();

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const resetUrl = `${frontendUrl}/reset-password/${rawToken}`;

    const sent = await sendPasswordResetEmail(user.email, resetUrl, user.full_name);
    if (!sent) {
      // Clear token if email failed so user can retry immediately
      user.passwordResetToken = null;
      user.passwordResetExpires = null;
      await user.save();
      return res.status(500).json({ message: 'Failed to send email. Please contact your administrator.' });
    }

    await createAuditLog(user, 'password_reset_requested', 'user', user.id, { ip: req.ip });

    res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (error) {
    console.error('[Auth] forgotPassword error:', error);
    res.status(500).json({ message: 'Something went wrong. Please try again.' });
  }
};

// @desc    Reset password using token
// @route   POST /api/auth/reset-password/:token
// @access  Public
const resetPassword = async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password || password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters long' });
    }

    // Validate password strength
    const strongRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]).{8,}$/;
    if (!strongRegex.test(password)) {
      return res.status(400).json({
        message: 'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character'
      });
    }

    // Hash the incoming token and find a matching user
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await User.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({ message: 'Reset token is invalid or has expired' });
    }

    // Set new password
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(password, salt);
    user.passwordResetToken = null;
    user.passwordResetExpires = null;
    user.passwordChangedAt = new Date();
    // Invalidate existing refresh tokens
    user.refreshToken = '';
    user.refreshTokenExpiresAt = null;
    await user.save();

    await createAuditLog(user, 'password_reset_completed', 'user', user.id, { ip: req.ip });

    res.json({ message: 'Password has been reset successfully. You can now log in.' });
  } catch (error) {
    console.error('[Auth] resetPassword error:', error);
    res.status(500).json({ message: 'Something went wrong. Please try again.' });
  }
};

// @desc    Verify reset token is still valid
// @route   GET /api/auth/reset-password/:token/verify
// @access  Public
const verifyResetToken = async (req, res) => {
  try {
    const { token } = req.params;
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await User.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({ valid: false, message: 'Reset token is invalid or has expired' });
    }

    res.json({ valid: true });
  } catch (error) {
    res.status(500).json({ valid: false, message: 'Verification failed' });
  }
};

module.exports = {
  register,
  login,
  logout,
  refreshToken,
  getMe,
  forgotPassword,
  resetPassword,
  verifyResetToken,
};
