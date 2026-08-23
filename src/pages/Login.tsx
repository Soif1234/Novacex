import React, { useState } from 'react';
import { Button } from '../components/ui/Button';
import { useAuth } from '../contexts/AuthContext';

export function Login({ onNavigate, returnTab = 'home' }: { onNavigate: (tab: string) => void, returnTab?: string }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [totp, setTotp] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { login, demoLogin, signup, verify2FA, status, cancel2FA } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!email || !password) {
      setError('Email and password are required');
      return;
    }
    setSubmitting(true);
    try {
      if (mode === 'signup') {
        await signup(email, name, password);
        // If 2FA is required the provider switches to AWAITING_2FA; otherwise the
        // subscribe callback sets the authenticated user.
        if (status !== 'AWAITING_2FA') onNavigate(returnTab);
      } else {
        const success = await login(email, password);
        if (success) onNavigate(returnTab);
      }
    } catch (err: any) {
      setError(err?.message || (mode === 'signup' ? 'Signup failed' : 'Login failed'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerify2FA = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const success = await verify2FA(totp);
      if (success) {
        onNavigate(returnTab);
      }
    } catch (err: any) {
      setError('Invalid TOTP code');
    }
  };

  const handleQuickDemo = async () => {
    setError('');
    setSubmitting(true);
    try {
      const success = await demoLogin();
      if (success) {
        onNavigate(returnTab);
      }
    } catch (err: any) {
      setError(err?.message || 'Could not start a demo session. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (status === 'AWAITING_2FA') {
    return (
      <div className="min-h-[80vh] flex flex-col items-center justify-center px-6">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-white mb-2">Two-Factor Authentication</h1>
            <p className="text-gray-400 text-sm">Enter the 6-digit code from your authenticator app</p>
          </div>

          {error && (
            <div className="bg-red-900/20 border border-red-500/20 rounded-lg p-3 mb-6 text-sm text-red-400 text-center">
              {error}
            </div>
          )}

          <form onSubmit={handleVerify2FA} className="flex flex-col gap-4">
            <div>
              <input
                type="text"
                required
                maxLength={6}
                pattern="\d{6}"
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-blue-500 transition-colors text-center tracking-widest text-lg"
                placeholder="000000"
              />
            </div>

            <Button variant="primary" type="submit" className="w-full py-3">
              Verify Code
            </Button>

            <Button variant="outline" type="button" onClick={cancel2FA} className="w-full py-3">
              Cancel
            </Button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-block bg-blue-900/40 text-blue-400 text-xs font-bold px-3 py-1 rounded-full mb-3 uppercase tracking-wider border border-blue-500/20">
            Paper Trading
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">Welcome to Mallick Exchange</h1>
          <p className="text-gray-400 text-sm">
            {mode === 'signup' ? 'Create your account' : 'Sign in to your account'}
          </p>
        </div>

        {error && (
          <div className="bg-red-900/20 border border-red-500/20 rounded-lg p-3 mb-6 text-sm text-red-400 text-center">
            {error}
          </div>
        )}

        <Button
          variant="primary"
          onClick={handleQuickDemo}
          disabled={submitting}
          className="w-full py-4 font-bold text-lg mb-6"
        >
          {submitting ? 'Starting…' : 'Continue as Demo Trader'}
        </Button>

        <div className="relative flex items-center py-5">
          <div className="flex-grow border-t border-gray-800"></div>
          <span className="flex-shrink-0 mx-4 text-gray-500 text-xs font-medium uppercase">
            Or use email
          </span>
          <div className="flex-grow border-t border-gray-800"></div>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {mode === 'signup' && (
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-blue-500 transition-colors"
              placeholder="Display name (optional)"
              autoComplete="name"
            />
          )}
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-blue-500 transition-colors"
            placeholder="you@example.com"
            autoComplete="email"
          />
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-blue-500 transition-colors"
            placeholder="Password"
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          />

          <Button variant="outline" type="submit" disabled={submitting} className="w-full py-3">
            {submitting ? 'Please wait…' : mode === 'signup' ? 'Create Account' : 'Sign In'}
          </Button>
        </form>

        <div className="text-center mt-6 text-sm text-gray-400">
          {mode === 'signup' ? (
            <>
              Already have an account?{' '}
              <button
                type="button"
                onClick={() => { setMode('login'); setError(''); }}
                className="text-blue-400 hover:text-blue-300 font-medium"
              >
                Sign in
              </button>
            </>
          ) : (
            <>
              Don't have an account?{' '}
              <button
                type="button"
                onClick={() => { setMode('signup'); setError(''); }}
                className="text-blue-400 hover:text-blue-300 font-medium"
              >
                Sign up
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
