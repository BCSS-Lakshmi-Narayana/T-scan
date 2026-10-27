import { useState, useEffect, createContext, useContext } from 'react';
import api, { ALERTS_CACHE_KEY, AUTH_FLAG_KEY } from '../lib/api';
import { clearAllAiChat, LEGACY_CHAT_KEY } from '../lib/aiChatStorage';
import { toast } from 'sonner';

const AuthContext = createContext(null);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  // The JWT lives in an httpOnly cookie now, so it cannot be read here. This
  // flag only records that a session should exist; the server stays the authority.
  const [authed, setAuthed] = useState(() => localStorage.getItem(AUTH_FLAG_KEY) === '1');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const initAuth = async () => {
      if (authed) {
        try {
          const response = await api.get('/auth/me');
          setUser(response.data);
        } catch (error) {
          console.error('Failed to fetch user:', error);
          logout();
        }
      }
      setLoading(false);
    };

    initAuth();
  }, [authed]);

  // login() resolves to:
  //   • the user object                         → success (unchanged contract)
  //   • { sessionConflict: true, existingSession } → District Officer already has
  //       a live session elsewhere; the caller shows a "sign out other session?"
  //       prompt and re-calls with { force: true } to take over.
  // and throws on any other failure (bad credentials, inactive, etc.).
  const login = async (email, password, { force = false } = {}) => {
    const body = force ? { email, password, force: true } : { email, password };
    try {
      let response;
      try {
        response = await api.post('/auth/login', body);
      } catch (err) {
        // A stale tenantSlug (pointing to a deleted tenant) makes the backend
        // reject login with 403 "Tenant not found". The response interceptor has
        // already cleared the bad slug, so retry once — this request falls back
        // to the backend's DEFAULT_TENANT_SLUG.
        if (err.response?.status === 403 && err.response?.data?.error === 'Tenant not found') {
          response = await api.post('/auth/login', body);
        } else {
          throw err;
        }
      }
      const { user: userData } = response.data;

      // This browser may have a previous session's cached alerts (Alerts.js's
      // localStorage cache has no user/tenant/district scoping of its own) —
      // clear it so the new session never renders another user's stale data
      // before its first API call lands.
      localStorage.removeItem(ALERTS_CACHE_KEY);
      // The old AI chat key was shared by every officer on this browser.
      localStorage.removeItem(LEGACY_CHAT_KEY);

      // No token is persisted — the server returned it as an httpOnly cookie,
      // which is the point of the migration.
      localStorage.setItem(AUTH_FLAG_KEY, '1');
      setAuthed(true);
      setUser(userData);

      // Dispatch custom event to notify TenantContext of token change
      window.dispatchEvent(new Event('tokenChanged'));

      toast.success('Logged in successfully');
      return userData;
    } catch (error) {
      // Single active session: surface the conflict to the caller WITHOUT a
      // scary error toast, so it can present the takeover dialog instead.
      if (error.response?.status === 409 && error.response?.data?.code === 'SESSION_CONFLICT') {
        return { sessionConflict: true, existingSession: error.response.data.existing_session || null };
      }
      const message = error.response?.data?.message || 'Login failed';
      toast.error(message);
      throw error;
    }
  };

  const register = async (email, password, full_name, role = 'level-1') => {
    try {
      await api.post('/auth/register', { email, password, full_name, role });
      return login(email, password);
    } catch (error) {
      const message = error.response?.data?.message || 'Registration failed';
      toast.error(message);
      throw error;
    }
  };

  const logout = () => {
    // Local teardown runs FIRST and synchronously, so signing out is instant and
    // never gated behind backend latency (callers navigate away immediately and
    // don't await this).
    localStorage.removeItem(AUTH_FLAG_KEY);
    localStorage.removeItem('token'); // any pre-cookie session
    localStorage.removeItem(ALERTS_CACHE_KEY);
    // AI chat history and conversation ids for every officer on this browser.
    clearAllAiChat();
    setAuthed(false);
    setUser(null);

    // Dispatch custom event to notify TenantContext of token change
    window.dispatchEvent(new Event('tokenChanged'));

    toast.info('Logged out');

    // Best-effort server-side session teardown (clears active_session + refresh
    // token so the session is immediately dead), with a short timeout so a
    // stalled backend can never delay the already-completed local sign-out.
    // The auth cookie still rides along (withCredentials), so the server can
    // revoke the session and clear the cookie in its response.
    api.post('/auth/logout', null, { timeout: 3000 })
      .catch(() => { /* ignore — local logout already done */ });
  };

  return (
    <AuthContext.Provider value={{ user, authed, isAuthenticated: authed, login, register, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
};

export default AuthContext;
