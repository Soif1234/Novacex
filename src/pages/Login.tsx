import React, { useState } from 'react';
import { Button } from '../components/ui/Button';
import { useAuth } from '../contexts/AuthContext';

export function Login({ onNavigate, returnTab = 'home' }: { onNavigate: (tab: string) => void, returnTab?: string }) {
  const [email, setEmail] = useState('');
  const { login } = useAuth();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (email) {
      login(email);
      onNavigate(returnTab);
    }
  };

  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-white mb-2">Welcome to NovaCEX</h1>
          <p className="text-gray-400 text-sm">Sign in to your demo environment</p>
        </div>
        
        <div className="bg-blue-900/20 border border-blue-500/20 rounded-lg p-3 mb-6 text-xs text-blue-400 text-center">
          This is a simulated demo environment. No real funds or KYC required.
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">Demo Email</label>
            <input 
              type="email" 
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-blue-500 transition-colors"
              placeholder="demo@example.com"
            />
          </div>
          
          <Button variant="primary" type="submit" className="w-full py-3 mt-2">
            Log In (Demo)
          </Button>
        </form>

        <div className="mt-6 text-center text-sm text-gray-500">
          Don't have a demo account?{' '}
          <button onClick={() => onNavigate('signup')} className="text-blue-500 hover:text-blue-400 font-medium">
            Sign Up
          </button>
        </div>
      </div>
    </div>
  );
}
