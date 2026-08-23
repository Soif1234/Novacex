import React, { useState } from 'react';
import { Button } from '../components/ui/Button';
import { useAuth } from '../contexts/AuthContext';

export function Signup({ onNavigate, returnTab = 'home' }: { onNavigate: (tab: string) => void, returnTab?: string }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { signup, status } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!email || !name || !password) {
      setError('Name, email and password are all required');
      return;
    }
    setSubmitting(true);
    try {
      await signup(email, name, password);
      // Only navigate once the backend has established the session (or a 2FA
      // challenge is pending). Errors are surfaced, never swallowed.
      if (status !== 'AWAITING_2FA') {
        onNavigate(returnTab);
      }
    } catch (err: any) {
      setError(err?.message || 'Could not create account');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-block bg-blue-900/40 text-blue-400 text-xs font-bold px-3 py-1 rounded-full mb-3 uppercase tracking-wider border border-blue-500/20">
            Paper Trading
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">Create Your Account</h1>
          <p className="text-gray-400 text-sm">Start trading in our simulated environment</p>
        </div>

        <div className="bg-emerald-900/20 border border-emerald-500/20 rounded-lg p-3 mb-6 text-xs text-emerald-400 text-center">
          Zero financial risk. Test strategies with simulated funds.
        </div>

        {error && (
          <div className="bg-red-900/20 border border-red-500/20 rounded-lg p-3 mb-6 text-sm text-red-400 text-center">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">Display Name</label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-blue-500 transition-colors"
              placeholder="Trader Jane"
              autoComplete="name"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-blue-500 transition-colors"
              placeholder="you@example.com"
              autoComplete="email"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">Password</label>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-blue-500 transition-colors"
              placeholder="At least 8 characters"
              autoComplete="new-password"
            />
            <p className="text-xs text-gray-500 mt-1">
              Must include upper &amp; lower case, a number, and a special character.
            </p>
          </div>

          <Button variant="primary" type="submit" disabled={submitting} className="w-full py-4 font-bold mt-2 text-lg">
            {submitting ? 'Creating…' : 'Create Account'}
          </Button>
        </form>

        <div className="mt-6 text-center text-sm text-gray-500">
          Already have an account?{' '}
          <button onClick={() => onNavigate('login')} className="text-blue-500 hover:text-blue-400 font-medium">
            Log In
          </button>
        </div>
      </div>
    </div>
  );
}
