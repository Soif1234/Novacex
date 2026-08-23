import React, { useState } from 'react';
import { Button } from '../components/ui/Button';
import { useAuth } from '../contexts/AuthContext';

export function Login({ onNavigate, returnTab = 'home' }: { onNavigate: (tab: string) => void, returnTab?: string }) {
  const [email, setEmail] = useState('demo@mallickexchange.com');
  const [totp, setTotp] = useState('');
  const [error, setError] = useState('');
  const { login, verify2FA, status, cancel2FA } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (email) {
      try {
        const success = await login(email);
        if (success) {
          onNavigate(returnTab);
        }
      } catch (err: any) {
        setError(err.message || 'Login failed');
      }
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
    try {
      const success = await login('demo@mallickexchange.com');
      if (success) {
        onNavigate(returnTab);
      }
    } catch (err: any) {
      setError(err.message || 'Login failed');
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
            DEMO ACCOUNT
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">Welcome to Mallick Exchange</h1>
          <p className="text-gray-400 text-sm">Sign in to your environment</p>
        </div>
        
        {error && (
          <div className="bg-red-900/20 border border-red-500/20 rounded-lg p-3 mb-6 text-sm text-red-400 text-center">
            {error}
          </div>
        )}

        <Button variant="primary" onClick={handleQuickDemo} className="w-full py-4 font-bold text-lg mb-6">
          Continue as Demo Trader
        </Button>

        <div className="relative flex items-center py-5">
          <div className="flex-grow border-t border-gray-800"></div>
          <span className="flex-shrink-0 mx-4 text-gray-500 text-xs font-medium uppercase">Or use custom email</span>
          <div className="flex-grow border-t border-gray-800"></div>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <input 
              type="email" 
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-blue-500 transition-colors"
              placeholder="custom@example.com"
            />
          </div>
          
          <Button variant="outline" type="submit" className="w-full py-3">
            Start Trading
          </Button>
        </form>
      </div>
    </div>
  );
}
