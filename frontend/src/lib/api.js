import axios from 'axios';
import { clearAllAiChat } from './aiChatStorage';

// Port the backend listens on when it is reachable directly (localhost dev, or a
// raw-IP deployment with no reverse proxy). Override per environment with
// REACT_APP_BACKEND_PORT — it is only a fallback; REACT_APP_BACKEND_URL, when
// set, wins outright.
const BACKEND_PORT = (process.env.REACT_APP_BACKEND_PORT || '8001').trim();

const getDefaultBackendUrl = () => {
  const env = (process.env.REACT_APP_BACKEND_URL || '').trim().replace(/\/+$/, '');
  if (env) {
    // Mixed-content guard: an https page cannot call an http:// backend. When a
    // build was made with REACT_APP_BACKEND_URL=http://localhost:8001 but is
    // served over https (production subdomain), fall back to a same-origin
    // relative URL so nginx proxies to the right tenant backend. This prevents
    // localhost URLs (media/api) leaking into production.
    if (typeof window !== 'undefined' && window.location.protocol === 'https:' && env.startsWith('http://')) {
      return window.location.origin;
    }
    return env;
  }

  if (typeof window === 'undefined') return `http://localhost:${BACKEND_PORT}`;

  const { hostname, port } = window.location;
  const isIP = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(hostname);

  // Local development
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return `http://localhost:${BACKEND_PORT}`;
  }

  // Raw IP (no domain / no reverse proxy) or CRA dev server → backend on the
  // same host, direct.
  if (isIP || port === '3000') {
    return `http://${hostname}:${BACKEND_PORT}`;
  }

  // Production behind nginx → ABSOLUTE same-origin URL (https://<slug>.domain).
  // Same subdomain, so the Host header — and the resolved tenant — is preserved.
  // Using the full origin (not a bare '') keeps the media-proxy guard working
  // (`url.startsWith(BACKEND_URL)` must not match every URL) and keeps the built
  // `${BACKEND_URL}/api/media/stream` absolute + https.
  return window.location.origin;
};

export const BACKEND_URL = getDefaultBackendUrl();
const API_URL = `${BACKEND_URL}/api`;

/**
 * Build a dynamic base URL for any service.
 * - Checks for an env-var override first.
 * - In local dev, points to the given devPort on the current hostname.
 * - In production, uses the relative `path` (served via reverse proxy).
 */
const getServiceUrl = (envVar, devPort, path) => {
  if (envVar) return envVar;

  if (typeof window === 'undefined') return `http://localhost:${devPort}${path}`;

  const { hostname, port } = window.location;
  const isIP = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(hostname);

  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return `http://localhost:${devPort}${path}`;
  }
  if (isIP || port === '3000') {
    return `http://${hostname}:${devPort}${path}`;
  }

  return path;
};

export const RAG_BASE_URL = getServiceUrl(
  process.env.REACT_APP_RAG_API_URL, 8100, '/api/rag'
);

export const OSINT_BASE_URL = getServiceUrl(
  process.env.REACT_APP_OSINT_API_URL, 8100, '/osint'
);

// Marks that this browser holds a session. The token itself now lives in an
// httpOnly cookie that JavaScript cannot read, so the app needs some signal to
// decide whether to attempt an authenticated request. This flag is NOT a
// credential — forging it only earns a 401 from the server.
export const AUTH_FLAG_KEY = 'authed';

// localStorage key holding the State Admin's globally-selected district.
// Exported so the navbar selector and any consumer use the same key.
export const DISTRICT_FILTER_KEY = 'districtFilter';

// Alerts.js caches its list response here for fast tab-switching. It has no
// user/tenant/district component (keyed only by UI filter state), so it MUST
// be cleared on every login/logout — otherwise the next person to log in on
// this browser (e.g. a different district officer) can see the previous
// session's cached alerts before the page ever calls the API.
export const ALERTS_CACHE_KEY = 'alertsCache_v2';

// One-shot message stashed here when the server ends this session (single-active-
// session enforcement for District Officers). The hard redirect below unmounts
// React, so the message is carried across it via localStorage and shown once on
// the login screen, then cleared.
export const SESSION_ENDED_KEY = 'sessionEndedReason';

const api = axios.create({
  baseURL: API_URL,
  // Required for the httpOnly auth cookie to travel — in dev the API is a
  // different origin (CRA :3000 -> backend port), and the browser only attaches
  // cookies cross-origin when the request explicitly asks for credentials.
  withCredentials: true,
});

// Request interceptor to add token and tenant info
api.interceptors.request.use(
  (config) => {
    // The auth cookie is attached by the browser. This header remains only so a
    // session issued before the cookie migration keeps working until it expires.
    const legacyToken = localStorage.getItem('token');
    if (legacyToken) {
      config.headers['Authorization'] = `Bearer ${legacyToken}`;
    }
    // Add tenant slug from localStorage if in dev/localhost
    const tenantSlug = localStorage.getItem('tenantSlug');
    if (tenantSlug) {
      config.headers['X-Tenant-Slug'] = tenantSlug;
    }
    // Global district filter (State Admin navbar selection). Sent on EVERY
    // request so all modules are filtered consistently — the backend's scoping
    // helpers read this header, so no per-module wiring is needed. Officers are
    // clamped server-side and can never widen their scope with it.
    const districtFilter = localStorage.getItem(DISTRICT_FILTER_KEY);
    if (districtFilter && districtFilter !== 'all') {
      config.headers['X-District-Filter'] = districtFilter;
    }
    config.headers['ngrok-skip-browser-warning'] = '69420';
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor to handle 401s and stale tenant slugs
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const url = error?.config?.url || '';
    const isUploadRequest = url.includes('/uploads/cloudinary');
    const status = error.response?.status;

    // Stale tenant slug: the cached tenantSlug points to a tenant that no longer
    // exists (e.g. deleted from the super admin dashboard). The backend's
    // tenantMiddleware responds with 403 { error: 'Tenant not found' }. Because
    // the slug is attached to every request (including /auth/login), this would
    // otherwise block login forever. Clear it so the next request falls back to
    // the backend's DEFAULT_TENANT_SLUG and the user can authenticate fresh.
    if (status === 403 && error.response?.data?.error === 'Tenant not found') {
      localStorage.removeItem('tenantSlug');
    }

    // Single-active-session: this officer's session was revoked because the
    // account signed in on another device (or was logged out server-side). Stash
    // a message to show on the login screen, then fall through to the standard
    // 401 teardown below. Distinct from an ordinary token expiry via the code.
    if (status === 401 && error.response?.data?.code === 'SESSION_REVOKED') {
      try {
        localStorage.setItem(
          SESSION_ENDED_KEY,
          error.response.data.message || 'You were signed out because your account was used to sign in on another device.'
        );
      } catch (_) { /* ignore storage errors */ }
    }

    if (status === 401 && !isUploadRequest) {
      // Token expired or invalid
      localStorage.removeItem('token');
      localStorage.removeItem(AUTH_FLAG_KEY);
      localStorage.removeItem(ALERTS_CACHE_KEY);
      clearAllAiChat();
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default api;
