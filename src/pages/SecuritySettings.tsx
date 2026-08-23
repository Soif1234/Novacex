import React, { useState, useEffect } from 'react';
import { 
  ArrowLeft, Shield, Smartphone, Monitor, Key, Plus, Trash2, Copy, Check, AlertCircle, QrCode, Lock
} from 'lucide-react';
import { Card } from '../components/ui/Card';
import { securityService } from '../services/user/SecurityService';
import { SecurityStatus, LoginSession } from '../services/user/types';

export function SecuritySettings({ onBack }: { onBack: () => void }) {
  const [status, setStatus] = useState<SecurityStatus>(securityService.getStatus());
  const [sessions, setSessions] = useState<LoginSession[]>(securityService.getSessions());
  const [apiKeys, setApiKeys] = useState<any[]>([]);
  const [isLoadingKeys, setIsLoadingKeys] = useState(false);

  // 2FA Setup State
  const [show2FAModal, setShow2FAModal] = useState(false);
  const [twoFactorData, setTwoFactorData] = useState<{ secret: string; qrCodeUrl: string; recoveryCodes: string[] } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [twoFactorError, setTwoFactorError] = useState('');
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [isSubmitting2FA, setIsSubmitting2FA] = useState(false);

  // API Key Create State
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<string[]>(['READ', 'TRADE']);
  const [createdKeyData, setCreatedKeyData] = useState<any | null>(null);
  const [keyError, setKeyError] = useState('');
  const [copiedKey, setCopiedKey] = useState(false);

  useEffect(() => {
    loadApiKeys();
    return securityService.subscribe(() => {
      setStatus(securityService.getStatus());
      setSessions(securityService.getSessions());
    });
  }, []);

  const loadApiKeys = async () => {
    setIsLoadingKeys(true);
    try {
      const keys = await securityService.fetchApiKeys();
      setApiKeys(keys);
    } catch {
      setApiKeys([]);
    } finally {
      setIsLoadingKeys(false);
    }
  };

  const handleStart2FA = async () => {
    if (status.twoFactorEnabled) {
      // Disable flow
      const code = prompt('Enter your 6-digit TOTP code to confirm disabling 2FA:');
      if (code) {
        try {
          await securityService.disableTwoFactor(code);
        } catch (e: any) {
          alert(e.message || 'Failed to disable 2FA');
        }
      }
    } else {
      // Enable flow
      try {
        const data = await securityService.generateTwoFactor();
        setTwoFactorData(data);
        setTotpCode('');
        setTwoFactorError('');
        setShow2FAModal(true);
      } catch (e: any) {
        alert(e.message || 'Failed to initialize 2FA');
      }
    }
  };

  const handleConfirm2FA = async () => {
    if (totpCode.length < 6) {
      setTwoFactorError('Please enter a valid 6-digit code');
      return;
    }
    setIsSubmitting2FA(true);
    setTwoFactorError('');
    try {
      await securityService.enableTwoFactor(totpCode);
      setShow2FAModal(false);
      setTwoFactorData(null);
    } catch (e: any) {
      setTwoFactorError(e.message || 'Verification failed');
    } finally {
      setIsSubmitting2FA(false);
    }
  };

  const handleCreateApiKey = async () => {
    if (!keyName.trim()) {
      setKeyError('API Key name is required');
      return;
    }
    setKeyError('');
    try {
      const newKey = await securityService.createApiKey({
        name: keyName.trim(),
        scopes: selectedScopes,
      });
      setCreatedKeyData(newKey);
      loadApiKeys();
    } catch (e: any) {
      setKeyError(e.message || 'Failed to create API key');
    }
  };

  const handleDeleteApiKey = async (id: string) => {
    if (!confirm('Are you sure you want to revoke this API key? This action is permanent.')) return;
    try {
      await securityService.deleteApiKey(id);
      loadApiKeys();
    } catch (e: any) {
      alert(e.message || 'Failed to revoke API key');
    }
  };

  const activeSessions = sessions.filter(s => s.status === 'ACTIVE');
  const hasOtherSessions = activeSessions.some(s => !s.current);

  return (
    <div className="pb-8 px-4 pt-4 text-gray-100 max-w-lg mx-auto">
      {/* Header */}
      <div className="flex items-center mb-6">
        <button onClick={onBack} className="p-2 -ml-2 mr-2 text-gray-400 hover:text-white rounded-full hover:bg-gray-800">
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-xl font-bold text-white">Security Settings</h1>
      </div>

      <div className="bg-blue-900/20 border border-blue-500/20 rounded-lg p-3 mb-6 text-xs text-blue-400 text-center font-medium">
        Demo security settings. This application does not manage real funds.
      </div>

      {/* Security Status Overview */}
      <div className="p-4 mb-6 bg-gray-900 border border-gray-800 rounded-xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Shield size={28} className={status.twoFactorEnabled ? 'text-emerald-500' : 'text-amber-500'} />
            <div>
              <h3 className="text-white font-bold text-sm">Security Status</h3>
              <div className="text-xs text-gray-400">
                Level: {status.securityLevel}
              </div>
            </div>
          </div>
          <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${
            status.twoFactorEnabled ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'
          }`}>
            {status.twoFactorEnabled ? 'Secure' : 'Action Needed'}
          </span>
        </div>
      </div>

      {/* 2FA Section */}
      <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3 px-1">Two-Factor Authentication (TOTP)</h3>
      <div className="p-4 mb-6 bg-gray-900 border border-gray-800 rounded-xl">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-white text-sm font-bold mb-1">Two-Factor Authentication</div>
            <div className="text-xs text-gray-400">Protects withdrawals and sensitive account actions</div>
          </div>
          <button 
            onClick={() => {
              if (securityService.toggleTwoFactor) securityService.toggleTwoFactor();
              handleStart2FA();
            }}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-colors ${
              status.twoFactorEnabled 
                ? 'bg-emerald-500/20 text-emerald-400' 
                : 'bg-blue-600 text-white hover:bg-blue-700'
            }`}
          >
            {status.twoFactorEnabled ? 'Enabled' : 'Enable'}
          </button>
        </div>
      </div>

      <div className="bg-gray-900/50 border border-gray-800 p-3 rounded-lg text-xs text-gray-500 mb-6">
        Demo account — password management is unavailable in demo environment.
      </div>


      {/* API Key Management */}
      <div className="flex items-center justify-between mb-3 px-1">
        <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">API Keys</h3>
        <button
          onClick={() => {
            setKeyName('');
            setCreatedKeyData(null);
            setKeyError('');
            setShowKeyModal(true);
          }}
          className="flex items-center gap-1 text-xs font-bold text-blue-400 hover:text-blue-300 bg-blue-500/10 px-2.5 py-1 rounded-md"
        >
          <Plus size={14} /> Create API Key
        </button>
      </div>

      <div className="space-y-3 mb-6">
        {isLoadingKeys ? (
          <div className="text-center py-4 text-xs text-gray-500">Loading API keys...</div>
        ) : apiKeys.length === 0 ? (
          <Card className="p-4 bg-gray-900/60 border-gray-800 text-center text-xs text-gray-500">
            No active API keys found. Create a scoped API key to trade programmatically.
          </Card>
        ) : (
          apiKeys.map((k) => (
            <div key={k.id} className="p-3.5 bg-gray-900 border border-gray-800 rounded-xl flex items-center justify-between">
              <div>
                <div className="text-sm font-bold text-white flex items-center gap-2">
                  <Key size={14} className="text-amber-400" />
                  {k.name}
                </div>
                <div className="text-xs font-mono text-gray-400 mt-1">
                  Prefix: {k.keyPrefix}...
                </div>
                <div className="flex gap-1.5 mt-2">
                  {k.scopes?.map((s: string) => (
                    <span key={s} className="text-[10px] bg-gray-800 text-gray-300 px-1.5 py-0.5 rounded font-mono">
                      {s}
                    </span>
                  ))}
                </div>
              </div>
              <button
                onClick={() => handleDeleteApiKey(k.id)}
                className="p-2 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded"
                title="Revoke Key"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))
        )}
      </div>

      {/* Active Sessions */}
      <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3 px-1">Active Login Sessions</h3>
      <div className="space-y-3 mb-6">
        {activeSessions.map(session => (
          <div key={session.id} className="p-4 bg-gray-900 border border-gray-800 rounded-xl flex items-center justify-between">
            <div className="flex items-center gap-3">
              {session.deviceName.toLowerCase().includes('mobile') ? (
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
                    <span className="text-emerald-500 font-medium">Current session</span>
                  ) : (
                    `Last active: ${new Date(session.lastActiveAt).toLocaleTimeString()}`
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
          </div>
        ))}


        {hasOtherSessions && (
          <button 
            onClick={() => securityService.revokeOtherSessions()}
            className="w-full py-2 bg-gray-900 border border-gray-800 hover:bg-gray-800 text-red-400 rounded-lg text-xs font-bold transition-colors"
          >
            Log Out Other Sessions
          </button>
        )}

      </div>

      {/* 2FA Setup Modal */}
      {show2FAModal && twoFactorData && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50">
          <div className="bg-gray-950 border border-gray-800 rounded-xl p-5 max-w-sm w-full space-y-4">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <QrCode size={20} className="text-blue-500" />
              Set Up Two-Factor Authentication
            </h2>
            <p className="text-xs text-gray-400">
              Scan this QR code in your Authenticator app or copy the secret key below:
            </p>

            <div className="bg-gray-900 p-3 rounded-lg flex items-center justify-between">
              <span className="text-xs font-mono text-amber-400 break-all">{twoFactorData.secret}</span>
              <button 
                onClick={() => {
                  navigator.clipboard.writeText(twoFactorData.secret);
                  setCopiedSecret(true);
                  setTimeout(() => setCopiedSecret(false), 2000);
                }}
                className="ml-2 p-1.5 bg-gray-800 hover:bg-gray-700 rounded text-gray-300"
              >
                {copiedSecret ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
              </button>
            </div>

            <div>
              <label className="block text-xs text-gray-300 font-bold mb-1">Enter 6-Digit TOTP Code</label>
              <input
                type="text"
                maxLength={6}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                placeholder="123456"
                className="w-full bg-gray-900 border border-gray-700 rounded-lg p-2.5 text-center font-mono text-lg text-white tracking-widest focus:border-blue-500 outline-none"
              />
            </div>

            {twoFactorError && (
              <div className="text-xs text-red-400 bg-red-500/10 p-2 rounded">{twoFactorError}</div>
            )}

            <div className="flex gap-2 pt-2">
              <button
                onClick={() => setShow2FAModal(false)}
                className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 py-2 rounded-lg text-xs font-bold"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm2FA}
                disabled={isSubmitting2FA || totpCode.length !== 6}
                className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white py-2 rounded-lg text-xs font-bold"
              >
                {isSubmitting2FA ? 'Verifying...' : 'Activate 2FA'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* API Key Modal */}
      {showKeyModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50">
          <div className="bg-gray-950 border border-gray-800 rounded-xl p-5 max-w-md w-full space-y-4">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <Key size={20} className="text-amber-400" />
              {createdKeyData ? 'API Key Created' : 'Create New API Key'}
            </h2>

            {createdKeyData ? (
              <div className="space-y-3">
                <div className="bg-amber-950/30 border border-amber-500/30 p-3 rounded-lg text-xs text-amber-400 flex items-start gap-2">
                  <AlertCircle size={16} className="shrink-0 mt-0.5" />
                  <span>Copy your API secret key now. You will NOT be able to view it again!</span>
                </div>

                <div>
                  <label className="block text-xs text-gray-400 mb-1">API Key</label>
                  <div className="bg-gray-900 p-2 rounded font-mono text-xs text-gray-200 select-all">
                    {createdKeyData.apiKey || createdKeyData.key}
                  </div>
                </div>

                {createdKeyData.apiSecret && (
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">API Secret</label>
                    <div className="bg-gray-900 p-2 rounded font-mono text-xs text-emerald-400 select-all flex items-center justify-between">
                      <span className="break-all">{createdKeyData.apiSecret}</span>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(createdKeyData.apiSecret);
                          setCopiedKey(true);
                          setTimeout(() => setCopiedKey(false), 2000);
                        }}
                        className="p-1 text-gray-400 hover:text-white"
                      >
                        {copiedKey ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                      </button>
                    </div>
                  </div>
                )}

                <button
                  onClick={() => setShowKeyModal(false)}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 rounded-lg text-xs mt-2"
                >
                  Done
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="block text-xs text-gray-300 font-bold mb-1">Key Label</label>
                  <input
                    type="text"
                    value={keyName}
                    onChange={(e) => setKeyName(e.target.value)}
                    placeholder="e.g. My Trading Bot"
                    className="w-full bg-gray-900 border border-gray-700 rounded-lg p-2.5 text-sm text-white focus:border-blue-500 outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs text-gray-300 font-bold mb-2">Permissions / Scopes</label>
                  <div className="space-y-2">
                    {['READ', 'TRADE', 'WITHDRAW'].map((scope) => (
                      <label key={scope} className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedScopes.includes(scope)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedScopes([...selectedScopes, scope]);
                            } else {
                              setSelectedScopes(selectedScopes.filter(s => s !== scope));
                            }
                          }}
                          className="rounded bg-gray-900 border-gray-700 text-blue-600 focus:ring-0"
                        />
                        <span>{scope} ({scope === 'READ' ? 'Read market data & balances' : scope === 'TRADE' ? 'Place & cancel orders' : 'Initiate withdrawals'})</span>
                      </label>
                    ))}
                  </div>
                </div>

                {keyError && (
                  <div className="text-xs text-red-400 bg-red-500/10 p-2 rounded">{keyError}</div>
                )}

                <div className="flex gap-2 pt-2">
                  <button
                    onClick={() => setShowKeyModal(false)}
                    className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 py-2.5 rounded-lg text-xs font-bold"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCreateApiKey}
                    className="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg text-xs font-bold"
                  >
                    Generate Key
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
