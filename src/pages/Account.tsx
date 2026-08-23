import React, { useState, useEffect } from 'react';
import { User, Shield, Bell, HelpCircle, Gift, ChevronRight, Settings, FileText, CheckCircle2, ShieldCheck, Sparkles, LogOut, Key, Sliders } from 'lucide-react';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { useAuth } from '../contexts/AuthContext';
import { userService } from '../services/user/UserService';
import { securityService } from '../services/user/SecurityService';
import { SecuritySettings } from './SecuritySettings';
import { PreferencesSettings } from './PreferencesSettings';

export function Account({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const { user, logout } = useAuth();
  const [isEditing, setIsEditing] = useState(false);
  const [displayName, setDisplayName] = useState(user?.displayName || '');
  const [username, setUsername] = useState(user?.username || '');
  const [error, setError] = useState('');
  const [currentView, setCurrentView] = useState<'main' | 'security' | 'preferences'>('main');

  // KYC Verification State
  const [showKycModal, setShowKycModal] = useState(false);
  const [kycStatus, setKycStatus] = useState<any>(null);
  const [kycTier, setKycTier] = useState<'TIER_1' | 'TIER_2'>('TIER_1');
  const [kycIdNumber, setKycIdNumber] = useState('');
  const [kycAddress, setKycAddress] = useState('');
  const [isSubmittingKyc, setIsSubmittingKyc] = useState(false);
  const [kycSuccess, setKycSuccess] = useState(false);

  useEffect(() => {
    loadKycStatus();
  }, []);

  const loadKycStatus = async () => {
    try {
      const status = await securityService.fetchKycStatus();
      setKycStatus(status);
    } catch {}
  };

  const handleSubmitKyc = async () => {
    if (!kycIdNumber.trim()) return;
    setIsSubmittingKyc(true);
    try {
      await securityService.submitKyc({
        tier: kycTier,
        idDocumentNumber: kycIdNumber.trim(),
        residentialAddress: kycTier === 'TIER_2' ? kycAddress.trim() : undefined,
      });
      setKycSuccess(true);
      await loadKycStatus();
      setTimeout(() => {
        setKycSuccess(false);
        setShowKycModal(false);
      }, 1500);
    } catch (e: any) {
      alert(e.message || 'Failed to submit KYC verification');
    } finally {
      setIsSubmittingKyc(false);
    }
  };

  const handleLogout = () => {
    logout();
    onNavigate('login');
  };

  const handleSave = () => {
    try {
      setError('');
      userService.updateProfile({ displayName, username });
      setIsEditing(false);
    } catch (e: any) {
      setError(e.message || 'Failed to update profile');
    }
  };

  if (!user) return null;

  if (currentView === 'security') {
    return <SecuritySettings onBack={() => setCurrentView('main')} />;
  }

  if (currentView === 'preferences') {
    return <PreferencesSettings onBack={() => setCurrentView('main')} />;
  }

  return (
    <div className="pb-10 px-4 pt-4 space-y-5 max-w-lg mx-auto">
      {/* Profile Summary Card */}
      <div className="relative overflow-hidden bg-gradient-to-br from-gray-900 via-gray-900 to-gray-950 border border-gray-800 rounded-3xl p-5 shadow-xl">
        <div className="flex items-center gap-4">
          <div className="relative w-16 h-16 rounded-2xl bg-gradient-to-tr from-cyan-500 to-blue-600 border border-cyan-400/30 flex items-center justify-center text-gray-950 text-xl font-black uppercase shrink-0 shadow-lg shadow-cyan-500/20">
            {user.avatar ? (
              <img src={user.avatar} alt="Avatar" className="w-full h-full rounded-2xl object-cover" />
            ) : (
              user.displayName.substring(0, 2)
            )}
            <span className="absolute -bottom-1 -right-1 w-4 h-4 bg-emerald-400 rounded-full border-2 border-gray-950" />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-black text-white truncate">{user.displayName}</h1>
              {user.role === 'ADMIN' && (
                <span className="px-1.5 py-0.2 bg-indigo-500/20 text-indigo-400 border border-indigo-500/40 text-[9px] font-black rounded uppercase">
                  ADMIN
                </span>
              )}
            </div>
            
            <div className="flex flex-wrap items-center gap-2 mt-1">
              <span className="text-gray-400 text-xs font-mono">@{user.username}</span>
              <div className="flex items-center gap-1 bg-emerald-500/15 border border-emerald-500/25 text-emerald-400 px-2 py-0.5 rounded-full text-[10px] font-bold">
                <CheckCircle2 size={11} /> {user.accountStatus}
              </div>
            </div>
          </div>

          <button 
            type="button"
            onClick={() => setIsEditing(!isEditing)} 
            className="px-3 py-1.5 bg-gray-800/80 hover:bg-gray-750 border border-gray-700/60 text-xs font-bold rounded-xl text-white transition-colors cursor-pointer"
          >
            {isEditing ? 'Cancel' : 'Edit'}
          </button>
        </div>
      </div>

      {/* Edit Profile Card */}
      {isEditing && (
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 space-y-3 animate-fadeIn">
          <h3 className="text-white font-extrabold text-sm">Edit Profile Information</h3>
          {error && <div className="text-red-400 text-xs font-bold p-2 bg-red-500/10 rounded-lg">{error}</div>}
          <div className="space-y-3">
            <div>
              <label className="block text-gray-400 text-xs font-bold mb-1">Display Name</label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full bg-gray-950 border border-gray-800 focus:border-cyan-500 rounded-xl p-2.5 text-white text-sm font-medium outline-none"
              />
            </div>
            <div>
              <label className="block text-gray-400 text-xs font-bold mb-1">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-gray-950 border border-gray-800 focus:border-cyan-500 rounded-xl p-2.5 text-white text-sm font-mono font-medium outline-none"
              />
            </div>
            <Button variant="primary" size="sm" fullWidth onClick={handleSave} className="font-black">
              Save Changes
            </Button>
          </div>
        </div>
      )}

      {/* Hub Shortcut Cards */}
      <div className="grid grid-cols-2 gap-3">
        <div 
          onClick={() => setShowKycModal(true)}
          className="bg-gray-900/80 hover:bg-gray-850 border border-gray-800/80 rounded-2xl p-4 flex flex-col items-center justify-center text-center cursor-pointer transition-all group shadow-sm"
        >
          <div className="w-10 h-10 rounded-xl bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center text-cyan-400 group-hover:scale-110 transition-transform mb-2">
            <ShieldCheck size={20} />
          </div>
          <div className="font-extrabold text-white text-xs">KYC Verification</div>
          <div className="text-[10px] font-mono text-cyan-400 mt-0.5">{kycStatus?.tier || 'TIER_1'}</div>
        </div>

        <div 
          onClick={() => setCurrentView('security')}
          className="bg-gray-900/80 hover:bg-gray-850 border border-gray-800/80 rounded-2xl p-4 flex flex-col items-center justify-center text-center cursor-pointer transition-all group shadow-sm"
        >
          <div className="w-10 h-10 rounded-xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400 group-hover:scale-110 transition-transform mb-2">
            <Key size={20} />
          </div>
          <div className="font-extrabold text-white text-xs">Security & 2FA</div>
          <div className="text-[10px] text-gray-400 mt-0.5">TOTP & Keys</div>
        </div>
      </div>

      {/* Account Details & Management Rows */}
      <div className="space-y-1.5">
        <div className="text-xs font-bold text-gray-400 uppercase tracking-wider px-1 pb-1">Account & Settings</div>
        
        <MenuRow icon={FileText} label="Email Address" value={user.email || 'Not provided'} />
        <MenuRow icon={Shield} label="Member Since" value={new Date(user.createdAt).toLocaleDateString()} />
        {user.role === 'ADMIN' && (
          <MenuRow icon={Settings} label="Admin Governance Dashboard" value="Admin Role" onClick={() => onNavigate('admin')} />
        )}
        
        <MenuRow 
          icon={ShieldCheck} 
          label="Identity Verification (KYC)" 
          value={kycStatus?.tier || 'TIER_1'} 
          onClick={() => setShowKycModal(true)} 
        />
        <MenuRow icon={Key} label="Security & API Keys" value="Active" onClick={() => setCurrentView('security')} />
        <MenuRow icon={Sliders} label="Terminal Preferences" onClick={() => setCurrentView('preferences')} />
        
        <div className="pt-3">
          <button 
            type="button"
            onClick={handleLogout} 
            className="w-full bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 font-extrabold py-3.5 rounded-2xl text-xs flex items-center justify-center gap-2 transition-all cursor-pointer"
          >
            <LogOut size={16} /> Log Out Account
          </button>
        </div>
      </div>

      {/* KYC Verification Modal */}
      {showKycModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-fadeIn">
          <div className="bg-gray-900 border border-gray-800 rounded-3xl p-5 max-w-md w-full space-y-4 shadow-2xl animate-scaleUp">
            <h2 className="text-base font-extrabold text-white flex items-center gap-2">
              <ShieldCheck size={20} className="text-cyan-400" />
              Identity Verification (KYC)
            </h2>

            <div className="bg-gray-950 p-3.5 rounded-2xl space-y-1.5 border border-gray-850 text-xs font-mono">
              <div className="flex justify-between text-gray-400">
                <span>Current KYC Tier:</span>
                <span className="text-emerald-400 font-bold">{kycStatus?.tier || 'TIER_1'}</span>
              </div>
              <div className="flex justify-between text-gray-400">
                <span>24h Daily Limit:</span>
                <span className="text-white font-bold">{kycStatus?.dailyLimitUsdt ?? 2000} USDT</span>
              </div>
              <div className="flex justify-between text-gray-400">
                <span>Remaining Today:</span>
                <span className="text-cyan-400 font-bold">{kycStatus?.remaining24hUsdt ?? 2000} USDT</span>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-400 font-bold mb-1">Upgrade Tier</label>
                <select
                  value={kycTier}
                  onChange={(e) => setKycTier(e.target.value as any)}
                  className="w-full bg-gray-950 border border-gray-800 rounded-xl p-2.5 text-xs text-white focus:border-cyan-500 outline-none font-bold"
                >
                  <option value="TIER_1">Tier 1 — ID Verification (Limit: 2,000 USDT/day)</option>
                  <option value="TIER_2">Tier 2 — Full Address Verification (Limit: 50,000 USDT/day)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-gray-400 font-bold mb-1">Passport / National ID Number</label>
                <input
                  type="text"
                  value={kycIdNumber}
                  onChange={(e) => setKycIdNumber(e.target.value)}
                  placeholder="e.g. A12345678"
                  className="w-full bg-gray-950 border border-gray-800 rounded-xl p-2.5 text-xs text-white font-mono focus:border-cyan-500 outline-none"
                />
              </div>

              {kycTier === 'TIER_2' && (
                <div>
                  <label className="block text-xs text-gray-400 font-bold mb-1">Residential Address</label>
                  <input
                    type="text"
                    value={kycAddress}
                    onChange={(e) => setKycAddress(e.target.value)}
                    placeholder="e.g. 100 Wall Street, New York, NY"
                    className="w-full bg-gray-950 border border-gray-800 rounded-xl p-2.5 text-xs text-white focus:border-cyan-500 outline-none"
                  />
                </div>
              )}

              {kycSuccess && (
                <div className="text-xs font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 p-2.5 rounded-xl text-center">
                  KYC verification submitted successfully!
                </div>
              )}
            </div>

            <div className="flex gap-2.5 pt-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1 rounded-xl"
                onClick={() => setShowKycModal(false)}
              >
                Close
              </Button>
              <Button
                variant="primary"
                size="sm"
                className="flex-1 rounded-xl font-black"
                onClick={handleSubmitKyc}
                disabled={isSubmittingKyc || !kycIdNumber.trim()}
                isLoading={isSubmittingKyc}
              >
                Submit Verification
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MenuRow({ icon: Icon, label, value, onClick }: { icon: any, label: string, value?: string, onClick?: () => void }) {
  return (
    <div 
      onClick={onClick}
      className={`p-3.5 flex items-center justify-between bg-gray-900/60 border border-gray-800/80 rounded-2xl transition-all ${
        onClick ? 'cursor-pointer hover:bg-gray-850 hover:border-gray-700/80 shadow-sm' : ''
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-xl bg-gray-800/80 flex items-center justify-center text-gray-300">
          <Icon size={16} />
        </div>
        <span className="text-xs font-bold text-white">{label}</span>
      </div>
      <div className="flex items-center gap-2">
        {value && <span className="text-xs font-mono font-bold text-gray-400">{value}</span>}
        {onClick && <ChevronRight size={15} className="text-gray-500" />}
      </div>
    </div>
  );
}


