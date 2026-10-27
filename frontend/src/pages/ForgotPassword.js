import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Shield, ArrowLeft, Mail } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import api from '../lib/api';

const ForgotPassword = () => {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/api/auth/forgot-password', { email });
      setSent(true);
    } catch {
      // Still show success to prevent email enumeration
      setSent(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[hsl(217,71%,18%)] via-[hsl(217,71%,22%)] to-[hsl(217,71%,18%)] p-4 sm:p-6 relative overflow-hidden">
      <div className="absolute inset-0 opacity-5">
        <div className="absolute inset-0" style={{ backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 35px, rgba(255,255,255,.1) 35px, rgba(255,255,255,.1) 70px)' }}></div>
      </div>
      <div className="absolute top-0 left-0 w-48 sm:w-72 lg:w-96 h-48 sm:h-72 lg:h-96 bg-[hsl(43,96%,50%)] rounded-full filter blur-[100px] lg:blur-[150px] opacity-15"></div>
      <div className="absolute bottom-0 right-0 w-48 sm:w-72 lg:w-96 h-48 sm:h-72 lg:h-96 bg-[hsl(217,71%,25%)] rounded-full filter blur-[100px] lg:blur-[150px] opacity-30"></div>

      <div className="w-full max-w-sm sm:max-w-md relative z-10">
        <div className="text-center mb-6 lg:mb-8">
          <div className="flex flex-col items-center gap-3 lg:gap-4 mb-4 lg:mb-6">
            <div className="relative">
              <div className="absolute -inset-1.5 lg:-inset-2 bg-gradient-to-r from-[hsl(43,96%,50%)] to-[hsl(43,96%,60%)] rounded-full opacity-75 blur-sm animate-pulse"></div>
              <img src="/policelogo.jpg" alt="Logo" className="relative h-20 w-20 sm:h-24 sm:w-24 lg:h-28 lg:w-28 rounded-full object-cover border-3 lg:border-4 border-[hsl(43,96%,50%)] shadow-2xl" />
            </div>
            <div>
              <h1 className="text-2xl sm:text-3xl lg:text-4xl font-heading font-bold text-white tracking-wider uppercase">SOC - EYE</h1>
              <div className="flex items-center justify-center gap-2 mt-1.5 lg:mt-2">
                <div className="h-px w-6 lg:w-8 bg-gradient-to-r from-transparent to-[hsl(43,96%,50%)]"></div>
                <Shield className="h-3 w-3 lg:h-4 lg:w-4 text-[hsl(43,96%,50%)]" />
                <div className="h-px w-6 lg:w-8 bg-gradient-to-l from-transparent to-[hsl(43,96%,50%)]"></div>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white/95 backdrop-blur-xl border-2 border-[hsl(43,96%,50%)]/30 rounded-xl p-5 sm:p-6 lg:p-8 shadow-2xl shadow-black/20">
          <div className="flex items-center gap-3 mb-5 lg:mb-6 pb-3 lg:pb-4 border-b border-border">
            <div className="p-2 bg-amber-100 rounded-lg">
              <Mail className="h-5 w-5 lg:h-6 lg:w-6 text-amber-600" />
            </div>
            <div>
              <h2 className="text-lg lg:text-xl font-heading font-bold text-slate-900">Forgot Password</h2>
              <p className="text-[10px] lg:text-xs text-slate-500">Enter your email to receive a reset link</p>
            </div>
          </div>

          {sent ? (
            <div className="text-center py-4">
              <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Mail className="h-7 w-7 text-green-600" />
              </div>
              <h3 className="text-lg font-semibold text-slate-900 mb-2">Check Your Email</h3>
              <p className="text-sm text-slate-600 mb-6">
                If an account with that email exists, we've sent a password reset link. The link expires in 30 minutes.
              </p>
              <Link to="/login">
                <Button variant="outline" className="w-full h-11">
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Back to Login
                </Button>
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4 lg:space-y-5">
              <div className="space-y-1.5 lg:space-y-2">
                <Label htmlFor="email" className="text-sm font-semibold">Email Address</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="Enter your registered email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="h-11 lg:h-12 border-2 focus:border-amber-500 focus:ring-amber-500/20 text-base"
                />
              </div>
              <Button
                type="submit"
                className="w-full h-11 lg:h-12 text-sm lg:text-base font-bold text-slate-900 bg-gradient-to-r from-amber-400 to-amber-500 hover:from-amber-500 hover:to-amber-600 shadow-lg shadow-amber-500/25 transition-all duration-200"
                disabled={loading}
              >
                {loading ? (
                  <span className="flex items-center gap-2">
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                    Sending...
                  </span>
                ) : (
                  'Send Reset Link'
                )}
              </Button>
              <div className="text-center">
                <Link to="/login" className="text-sm text-amber-600 hover:text-amber-700 font-medium inline-flex items-center gap-1">
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back to Login
                </Link>
              </div>
            </form>
          )}
        </div>

        <div className="mt-4 lg:mt-6 text-center">
          <p className="text-[hsl(210,20%,60%)] text-[10px] lg:text-xs">© 2026 SOC - EYE • Secure Connection</p>
        </div>
      </div>
    </div>
  );
};

export default ForgotPassword;
