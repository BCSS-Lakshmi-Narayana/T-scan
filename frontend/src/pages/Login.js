import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Shield, Lock, Mail, Monitor, AlertTriangle } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { SESSION_ENDED_KEY } from '../lib/api';

const formatWhen = (value) => {
  if (!value) return 'Unknown';
  try {
    return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  } catch (_) {
    return 'Unknown';
  }
};

const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  // Single-active-session UI state.
  const [conflict, setConflict] = useState(null);        // existing_session details, or null
  const [takingOver, setTakingOver] = useState(false);
  const [sessionEndedMsg, setSessionEndedMsg] = useState('');
  const { login } = useAuth();
  const navigate = useNavigate();

  // If we arrived here because the server ended this session (signed in
  // elsewhere), show the one-shot message the interceptor stashed, then clear it.
  useEffect(() => {
    try {
      const msg = localStorage.getItem(SESSION_ENDED_KEY);
      if (msg) {
        setSessionEndedMsg(msg);
        localStorage.removeItem(SESSION_ENDED_KEY);
      }
    } catch (_) { /* ignore */ }
  }, []);

  const routeAfterLogin = (userData) => {
    if (userData?.role === 'dial100') {
      navigate('/dial-100-incident-reporting');
    } else {
      navigate('/dashboard');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setSessionEndedMsg('');
    try {
      const result = await login(email, password);
      if (result?.sessionConflict) {
        // District Officer already has a live session elsewhere — ask before takeover.
        setConflict(result.existingSession || {});
      } else if (result) {
        routeAfterLogin(result);
      }
    } catch (error) {
      // Error toast handled by AuthContext
    } finally {
      setLoading(false);
    }
  };

  // User confirmed taking over the other session: force login.
  const handleTakeover = async () => {
    setTakingOver(true);
    try {
      const result = await login(email, password, { force: true });
      if (result && !result.sessionConflict) {
        setConflict(null);
        routeAfterLogin(result);
      }
    } catch (error) {
      // Error toast handled by AuthContext
    } finally {
      setTakingOver(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[hsl(217,71%,18%)] via-[hsl(217,71%,22%)] to-[hsl(217,71%,18%)] p-4 sm:p-6 relative overflow-hidden">
      {/* Background Pattern */}
      <div className="absolute inset-0 opacity-5">
        <div className="absolute inset-0" style={{ backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 35px, rgba(255,255,255,.1) 35px, rgba(255,255,255,.1) 70px)' }}></div>
      </div>

      {/* Decorative Elements */}
      <div className="absolute top-0 left-0 w-48 sm:w-72 lg:w-96 h-48 sm:h-72 lg:h-96 bg-[hsl(43,96%,50%)] rounded-full filter blur-[100px] lg:blur-[150px] opacity-15"></div>
      <div className="absolute bottom-0 right-0 w-48 sm:w-72 lg:w-96 h-48 sm:h-72 lg:h-96 bg-[hsl(217,71%,25%)] rounded-full filter blur-[100px] lg:blur-[150px] opacity-30"></div>

      <div className="w-full max-w-sm sm:max-w-md relative z-10">
        {/* Header Section */}
        <div className="text-center mb-6 lg:mb-8">
          <div className="flex flex-col items-center gap-3 lg:gap-4 mb-4 lg:mb-6">
            <div>
              <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-white tracking-wider uppercase">BLURA SAGA</h1>
              <div className="flex items-center justify-center gap-2 mt-1.5 lg:mt-2">
                <div className="h-px w-6 lg:w-8 bg-gradient-to-r from-transparent to-[hsl(43,96%,50%)]"></div>
                <Shield className="h-3 w-3 lg:h-4 lg:w-4 text-[hsl(43,96%,50%)]" />
                <div className="h-px w-6 lg:w-8 bg-gradient-to-l from-transparent to-[hsl(43,96%,50%)]"></div>
              </div>
            </div>
          </div>
          <p className="text-[hsl(210,20%,75%)] text-xs sm:text-sm tracking-wide uppercase">Sentiment and Goodwill Analysis</p>
        </div>

        {/* Login Card */}
        <div className="bg-white/95 backdrop-blur-xl border-2 border-[hsl(43,96%,50%)]/30 rounded-xl p-5 sm:p-6 lg:p-8 shadow-2xl shadow-black/20">
          <div className="flex items-center gap-3 mb-5 lg:mb-6 pb-3 lg:pb-4 border-b border-gray-200">
            <div className="p-2 bg-amber-100 rounded-lg">
              <Shield className="h-5 w-5 lg:h-6 lg:w-6 text-amber-600" />
            </div>
            <div>
              <h2 className="text-lg lg:text-xl font-bold text-slate-900">Secure Access</h2>
              <p className="text-[10px] lg:text-xs text-slate-500">Authorized Personnel Only</p>
            </div>
          </div>

          {sessionEndedMsg && (
            <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <span>{sessionEndedMsg}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4 lg:space-y-5">
            <div className="space-y-1.5 lg:space-y-2">
              <Label htmlFor="email" className="text-sm font-semibold">Email Address</Label>
              <div className="relative">
                <Mail className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                <Input
                  id="email"
                  type="email"
                  placeholder="Please Enter Your Email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="h-11 lg:h-12 pl-11 border-2 focus:border-amber-500 focus:ring-amber-500/20 text-base"
                />
              </div>
            </div>

            <div className="space-y-1.5 lg:space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password" className="text-sm font-semibold">Password</Label>
                <Link to="/forgot-password" className="text-xs text-amber-600 hover:text-amber-700 font-medium">
                  Forgot Password?
                </Link>
              </div>
              <div className="relative">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                <Input
                  id="password"
                  type="password"
                  placeholder="Please Enter Your Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="h-11 lg:h-12 pl-11 border-2 focus:border-amber-500 focus:ring-amber-500/20 text-base"
                />
              </div>
            </div>

            <Button
              type="submit"
              className="w-full h-11 lg:h-12 text-sm lg:text-base font-bold text-slate-900 bg-gradient-to-r from-amber-400 to-amber-500 hover:from-amber-500 hover:to-amber-600 shadow-lg shadow-amber-500/25 transition-all duration-200 hover:shadow-xl hover:shadow-amber-500/30 active:scale-[0.98]"
              disabled={loading}
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <div className="w-4 h-4 lg:w-5 lg:h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                  Authenticating...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Shield className="h-4 w-4 lg:h-5 lg:w-5" />
                  Access System
                </span>
              )}
            </Button>
          </form>
        </div>

        {/* Footer */}
        <div className="mt-4 lg:mt-6 text-center">
          <p className="text-[hsl(210,20%,60%)] text-[10px] lg:text-xs">© 2026 BLURA SAGA • Secure Connection</p>
        </div>
      </div>

      {/* Single-active-session takeover dialog */}
      {conflict && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => !takingOver && setConflict(null)} />
          <div className="relative w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-2xl">
            <div className="mb-4 flex items-center gap-3">
              <div className="rounded-full bg-amber-100 p-2.5">
                <Monitor className="h-5 w-5 text-amber-600" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-900">You're already signed in</h3>
                <p className="text-xs text-slate-500">This account has an active session on another device.</p>
              </div>
            </div>

            <div className="mb-5 space-y-1.5 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-slate-500">Device</span>
                <span className="font-medium text-slate-800">{conflict.device || 'Unknown device'}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-slate-500">Signed in</span>
                <span className="font-medium text-slate-800">{formatWhen(conflict.login_at)}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-slate-500">Last active</span>
                <span className="font-medium text-slate-800">{formatWhen(conflict.last_active_at)}</span>
              </div>
            </div>

            <p className="mb-5 text-sm text-slate-600">
              Continuing will sign out that session and log you in here. Only one active session is allowed per officer.
            </p>

            <div className="flex gap-3">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={() => setConflict(null)}
                disabled={takingOver}
              >
                Cancel
              </Button>
              <Button
                type="button"
                className="flex-1 bg-amber-500 text-slate-900 hover:bg-amber-600"
                onClick={handleTakeover}
                disabled={takingOver}
              >
                {takingOver ? 'Signing in…' : 'Log out other & continue'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Login;
