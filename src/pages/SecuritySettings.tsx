import React, { useState, useEffect } from 'react';
import { ArrowLeft, Shield, Smartphone, Monitor, Key, LogOut } from 'lucide-react';
import { Card } from '../components/ui/Card';
import { securityService } from '../services/user/SecurityService';
import { SecurityStatus, LoginSession } from '../services/user/types';

export function SecuritySettings({ onBack }: { onBack: () => void }) {
  const [status, setStatus] = useState<SecurityStatus>(securityService.getStatus());
  const [sessions, setSessions] = useState<LoginSession[]>(securityService.getSessions());

  useEffect(() => {
    return securityService.subscribe(() => {
      setStatus(securityService.getStatus());
      setSessions(securityService.getSessions());
    });
  }, []);

  const activeSessions = sessions.filter(s => s.status === 'ACTIVE');
  const hasOtherSessions = activeSessions.some(s => !s.current);

  return (
    <div className="pb-6 px-4 pt-4">
      <div className="flex items-center mb-6">
        <button onClick={onBack} className="p-2 -ml-2 mr-2 text-gray-400 hover:text-white rounded-full hover:bg-gray-800">
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-xl font-bold text-white">Security Settings</h1>
      </div>

      <div className="bg-blue-900/20 border border-blue-500/20 rounded-lg p-3 mb-6 text-xs text-blue-400 text-center font-medium">
        Demo security settings. This application does not manage real funds.
      </div>

      <Card className="p-4 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <Shield size={24} className={status.securityLevel === 'ENHANCED' ? 'text-emerald-500' : 'text-amber-500'} />
          <div>
            <h3 className="text-white font-bold text-sm">Security Status</h3>
            <div className="text-xs text-gray-400">Level: {status.securityLevel}</div>
          </div>
        </div>
      </Card>

      <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3 px-1">Two-Factor Authentication</h3>
      <Card className="p-4 mb-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-white text-sm font-bold mb-1">Demo 2FA</div>
            <div className="text-xs text-gray-400">Add an extra layer of security</div>
          </div>
          <button 
            onClick={() => securityService.toggleTwoFactor()}
            className={`px-4 py-1.5 rounded-full text-xs font-bold transition-colors ${
              status.twoFactorEnabled 
                ? 'bg-emerald-500/20 text-emerald-500' 
                : 'bg-gray-800 text-white hover:bg-gray-700'
            }`}
          >
            {status.twoFactorEnabled ? 'Enabled' : 'Enable'}
          </button>
        </div>
      </Card>

      <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3 px-1">Active Sessions</h3>
      <div className="space-y-3 mb-6">
        {activeSessions.map(session => (
          <div key={session.id}>
            <Card className="p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                {session.deviceName.toLowerCase().includes('mobile') || session.platform.toLowerCase().includes('android') || session.platform.toLowerCase().includes('iphone') ? (
                  <Smartphone size={20} className={session.current ? "text-blue-500" : "text-gray-400"} />
                ) : (
                  <Monitor size={20} className={session.current ? "text-blue-500" : "text-gray-400"} />
                )}
                <div>
                  <div className="text-white text-sm font-bold">
                    {session.deviceName} <span className="text-gray-500 font-normal">({session.platform})</span>
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    {session.current ? (
                      <span className="text-emerald-500">Current session</span>
                    ) : (
                      `Last active: ${new Date(session.lastActiveAt).toLocaleString()}`
                    )}
                  </div>
                </div>
              </div>
              {!session.current && (
                <button 
                  onClick={() => securityService.revokeSession(session.id)}
                  className="text-xs text-red-500 bg-red-500/10 hover:bg-red-500/20 px-3 py-1 rounded"
                >
                  Revoke
                </button>
              )}
            </Card>
          </div>
        ))}
        
        {hasOtherSessions && (
          <button 
            onClick={() => securityService.revokeOtherSessions()}
            className="w-full py-3 rounded-lg border border-gray-800 text-gray-400 text-sm hover:text-white hover:bg-gray-900 transition-colors flex items-center justify-center gap-2"
          >
            <LogOut size={16} />
            Log Out Other Sessions
          </button>
        )}
      </div>
      
      <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3 px-1">Password Management</h3>
      <Card className="p-4 mb-4">
        <div className="flex items-center gap-3 mb-2">
          <Key size={20} className="text-gray-400" />
          <div className="text-white text-sm font-bold">Change Password</div>
        </div>
        <div className="text-xs text-gray-400 ml-8">
          Demo account — password management is unavailable.
        </div>
      </Card>
    </div>
  );
}
