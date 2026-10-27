// Single-active-session enforcement for District Officers.
//
// Only role 'level-1' (District Officer, under a State Admin) is enforced — a
// district officer's credentials may power at most ONE live session at a time.
// State Admins ('admin') and platform 'superadmin' are intentionally NOT
// enforced, so this change cannot affect the tenant-admin or super-admin flows.
//
// The mechanism: each enforced login mints a random session id that is (a)
// stored on the user's `active_session.session_id` (newest login overwrites the
// previous one) and (b) embedded in the issued JWT as the `sid` claim. On every
// request the token's `sid` is compared against the stored id; a mismatch means
// this token belongs to a session that has since been superseded (login
// elsewhere) or ended (logout) — so it is rejected with SESSION_REVOKED and the
// browser is bounced to the login screen on its next request.
//
// Kill-switch: set ENFORCE_SINGLE_SESSION=false in the environment to disable
// enforcement entirely without a code change (defaults to ON).

const ENFORCE_SINGLE_SESSION = String(process.env.ENFORCE_SINGLE_SESSION || '').toLowerCase() !== 'false';

// Roles subject to single-session enforcement. Kept as a set so it is trivial to
// extend later (e.g. add 'admin') without touching call sites.
const ENFORCED_ROLES = new Set(['level-1']);

// True when single-session enforcement applies to this role (and the global
// kill-switch is on). Everyone else is untouched — zero behavioural change.
const isEnforcedRole = (role) => ENFORCE_SINGLE_SESSION && ENFORCED_ROLES.has(role);

/**
 * Pure predicate — no I/O. Given the token's role + sid claim and the user's
 * currently-stored active_session, decide whether this request's session is
 * still the active one.
 *
 * Returns { ok: true } when the request may proceed, or
 * { ok: false, code: 'SESSION_REVOKED', message, reason } when it must be rejected.
 *
 * @param {string}  role          role from the verified token (or DB user)
 * @param {string}  sid           the token's `sid` claim (undefined for pre-feature tokens)
 * @param {object=} activeSession the user's stored active_session (or null/undefined)
 */
const validateSingleSession = (role, sid, activeSession) => {
  if (!isEnforcedRole(role)) return { ok: true };

  // A token with no sid predates this feature (issued before deploy). Per the
  // agreed rollout, those must re-login exactly once.
  if (!sid) {
    return { ok: false, code: 'SESSION_REVOKED', reason: 'legacy_token', message: 'Your session is no longer valid. Please sign in again.' };
  }

  if (!activeSession || !activeSession.session_id) {
    return { ok: false, code: 'SESSION_REVOKED', reason: 'no_active_session', message: 'Your session has ended. Please sign in again.' };
  }

  if (activeSession.session_id !== sid) {
    return { ok: false, code: 'SESSION_REVOKED', reason: 'superseded', message: 'You were signed out because your account was used to sign in on another device.' };
  }

  if (activeSession.expires_at && new Date(activeSession.expires_at).getTime() < Date.now()) {
    return { ok: false, code: 'SESSION_REVOKED', reason: 'expired', message: 'Your session has expired. Please sign in again.' };
  }

  return { ok: true };
};

/**
 * Best-effort, dependency-free parse of a User-Agent string into a short,
 * human-recognisable "Browser on OS" label for the "you're already signed in"
 * dialog. Never throws; unknowns degrade gracefully.
 *
 * Order matters: several UAs are supersets of others (Edge/Opera contain
 * "Chrome"; Chrome contains "Safari"), so the more specific checks come first.
 */
const parseUserAgent = (uaRaw = '') => {
  const ua = String(uaRaw || '');
  if (!ua.trim()) return 'Unknown device';

  let browser = 'Unknown browser';
  if (/\bEdg(e|A|iOS)?\//i.test(ua)) browser = 'Edge';
  else if (/\b(OPR|Opera)\//i.test(ua)) browser = 'Opera';
  else if (/\bSamsungBrowser\//i.test(ua)) browser = 'Samsung Internet';
  else if (/\b(Chrome|CriOS)\//i.test(ua)) browser = 'Chrome';
  else if (/\b(Firefox|FxiOS)\//i.test(ua)) browser = 'Firefox';
  else if (/\bSafari\//i.test(ua) && /\bVersion\//i.test(ua)) browser = 'Safari';

  let os = 'Unknown OS';
  if (/Windows NT/i.test(ua)) os = 'Windows';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
  else if (/CrOS/i.test(ua)) os = 'ChromeOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  if (browser === 'Unknown browser' && os === 'Unknown OS') return 'Unknown device';
  return `${browser} on ${os}`;
};

module.exports = {
  ENFORCE_SINGLE_SESSION,
  ENFORCED_ROLES,
  isEnforcedRole,
  validateSingleSession,
  parseUserAgent,
};
