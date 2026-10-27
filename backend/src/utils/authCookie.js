/**
 * The auth token as an httpOnly cookie.
 *
 * The JWT used to live in the browser's localStorage, which any script running
 * on the page can read — so a single XSS anywhere in the app was enough to lift
 * a session. As an httpOnly cookie the token is invisible to JavaScript and is
 * attached by the browser itself, so that class of theft is gone.
 *
 * Cookies are parsed by hand rather than with cookie-parser: this reads exactly
 * one cookie on requests that are already doing a JWT verify, so the dependency
 * would buy nothing and the app would not boot until someone ran npm install.
 *
 * The Authorization header still works everywhere (see authMiddleware) — server-
 * to-server callers and any client that cannot hold a cookie keep working
 * unchanged, and a session issued before this change stays valid until it
 * expires.
 */

const TOKEN_COOKIE = 'auth_token';

// Same lifetime as the JWT itself, so the cookie never outlives the token it
// carries (a cookie that survives its token just yields confusing 401s).
const MAX_AGE_MS = Number(process.env.AUTH_COOKIE_MAX_AGE_MS) || 7 * 24 * 60 * 60 * 1000;

/**
 * SameSite has to match how the app is actually served:
 *   production — frontend and API share an origin behind nginx, so 'lax' works
 *                and keeps the cookie off cross-site requests entirely.
 *   local dev  — CRA on :3000 calls the API on another port, which is
 *                cross-origin, so the browser only sends the cookie when it is
 *                SameSite=None, and None is only honoured with Secure.
 *                Chrome and Firefox both treat http://localhost as a secure
 *                context, so Secure cookies work there without TLS.
 * Both are overridable for deployments that sit behind a different topology.
 */
const sameSite = () => (process.env.AUTH_COOKIE_SAMESITE || (process.env.NODE_ENV === 'production' ? 'lax' : 'none')).toLowerCase();
const secure = () => {
  if (process.env.AUTH_COOKIE_SECURE !== undefined) return String(process.env.AUTH_COOKIE_SECURE).toLowerCase() === 'true';
  // SameSite=None without Secure is rejected outright by every current browser.
  return sameSite() === 'none' || process.env.NODE_ENV === 'production';
};

const baseOptions = () => {
  const options = {
    httpOnly: true,
    secure: secure(),
    sameSite: sameSite(),
    path: '/',
  };
  // A tenant is its own subdomain, so leaving Domain unset is deliberate: the
  // cookie stays host-only and one tenant's session is never sent to another's.
  // Set AUTH_COOKIE_DOMAIN only if sessions are meant to span subdomains.
  if (process.env.AUTH_COOKIE_DOMAIN) options.domain = process.env.AUTH_COOKIE_DOMAIN;
  return options;
};

/** Read the auth token from the request's Cookie header, or null. */
const readTokenCookie = (req) => {
  const header = req?.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== TOKEN_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    if (!value) return null;
    try { return decodeURIComponent(value); } catch (_) { return value; }
  }
  return null;
};

/** Issue the auth cookie alongside a successful login/register. */
const setAuthCookie = (res, token) => {
  if (!res || !token) return;
  res.cookie(TOKEN_COOKIE, token, { ...baseOptions(), maxAge: MAX_AGE_MS });
};

/**
 * Drop the auth cookie on logout. The attributes must match the ones it was set
 * with or the browser keeps the original cookie and the user stays signed in.
 */
const clearAuthCookie = (res) => {
  if (!res) return;
  res.clearCookie(TOKEN_COOKIE, baseOptions());
};

module.exports = { TOKEN_COOKIE, readTokenCookie, setAuthCookie, clearAuthCookie };
