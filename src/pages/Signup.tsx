import React, { useState } from 'react';
import { Button } from '../components/ui/Button';
import { useAuth } from '../contexts/AuthContext';

export function Signup({ onNavigate, returnTab = 'home' }: { onNavigate: (tab: string) => void, returnTab?: string }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const { signup } = useAuth();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (email && name) {
      signup(email, name);
      onNavigate(returnTab);
    }
  };

  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-block bg-blue-900/40 text-blue-400 text-xs font-bold px-3 py-1 rounded-full mb-3 uppercase tracking-wider border border-blue-500/20">
            DEMO ACCOUNT
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">Create Demo Profile</h1>
          <p className="text-gray-400 text-sm">Start trading in our simulated environment</p>
        </div>
        
        <div className="bg-emerald-900/20 border border-emerald-500/20 rounded-lg p-3 mb-6 text-xs text-emerald-400 text-center">
          Zero financial risk. Test strategies with mock funds instantly.
        </div>

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
            />
          </div>
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
          
          <Button variant="primary" type="submit" className="w-full py-4 font-bold mt-2 text-lg">
            Create Profile (Demo)
          </Button>
        </form>

        <div className="mt-6 text-center text-sm text-gray-500">
          Already have a profile?{' '}
          <button onClick={() => onNavigate('login')} className="text-blue-500 hover:text-blue-400 font-medium">
            Log In
          </button>
        </div>
      </div>
    </div>
  );
}
