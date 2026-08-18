import React, { useState } from 'react';
import { User, Shield, Bell, HelpCircle, Gift, ChevronRight, Settings, FileText, CheckCircle2 } from 'lucide-react';
import { Card } from '../components/ui/Card';
import { useAuth } from '../contexts/AuthContext';
import { userService } from '../services/user/UserService';
import { SecuritySettings } from './SecuritySettings';
import { PreferencesSettings } from './PreferencesSettings';

export function Account({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const { user, logout } = useAuth();
  const [isEditing, setIsEditing] = useState(false);
  const [displayName, setDisplayName] = useState(user?.displayName || '');
  const [username, setUsername] = useState(user?.username || '');
  const [error, setError] = useState('');
  const [currentView, setCurrentView] = useState<'main' | 'security' | 'preferences'>('main');

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
    <div className="pb-6 px-4 pt-4">
      <div className="bg-blue-900/20 border border-blue-500/20 rounded-lg p-2 mb-4 text-xs text-blue-400 text-center font-medium">
        DEMO ENVIRONMENT ACTIVE
      </div>

      <div className="flex items-center gap-4 mb-6 relative">
        <div className="w-16 h-16 rounded-full bg-blue-600 flex items-center justify-center text-white text-xl font-bold uppercase shrink-0">
          {user.avatar ? <img src={user.avatar} alt="Avatar" className="w-full h-full rounded-full object-cover" /> : user.displayName.substring(0, 2)}
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-white mb-1 truncate">{user.displayName}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-gray-400 text-sm">@{user.username}</span>
            <div className="flex items-center gap-1 bg-emerald-500/10 text-emerald-500 px-2 py-0.5 rounded text-xs font-medium">
              <CheckCircle2 size={12} /> {user.accountStatus}
            </div>
          </div>
        </div>
        <button onClick={() => setIsEditing(!isEditing)} className="px-3 py-1 bg-gray-800 text-sm rounded-md text-white hover:bg-gray-700 absolute top-0 right-0">
          {isEditing ? 'Cancel' : 'Edit'}
        </button>
      </div>

      {isEditing && (
        <Card className="p-4 mb-6">
          <h3 className="text-white font-bold mb-4">Edit Profile</h3>
          {error && <div className="text-red-500 text-sm mb-3">{error}</div>}
          <div className="space-y-3">
            <div>
              <label className="block text-gray-400 text-xs mb-1">Display Name</label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm"
              />
            </div>
            <div>
              <label className="block text-gray-400 text-xs mb-1">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm"
              />
            </div>
            <button onClick={handleSave} className="w-full bg-blue-600 text-white font-bold py-2 rounded mt-2 hover:bg-blue-700">
              Save Changes
            </button>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 mb-6">
        <Card className="p-4 flex flex-col items-center justify-center text-center">
          <Gift size={24} className="text-blue-500 mb-2" />
          <div className="font-bold text-white text-sm">Rewards Hub</div>
          <div className="text-xs text-gray-500">View tasks</div>
        </Card>
        <Card className="p-4 flex flex-col items-center justify-center text-center">
          <User size={24} className="text-purple-500 mb-2" />
          <div className="font-bold text-white text-sm">Referral</div>
          <div className="text-xs text-gray-500">Invite friends</div>
        </Card>
      </div>

      <div className="flex flex-col gap-1">
        <SectionTitle>Account Details</SectionTitle>
        <MenuRow icon={FileText} label="Email" value={user.email || 'Not provided'} />
        <MenuRow icon={Shield} label="Member Since" value={new Date(user.createdAt).toLocaleDateString()} />
        <MenuRow icon={Settings} label="Admin Dashboard" onClick={() => onNavigate('admin')} />
        
        <div className="h-4"></div>
        <SectionTitle>Account Functions</SectionTitle>
        <MenuRow icon={Shield} label="Security" value="Medium" onClick={() => setCurrentView('security')} />
        <MenuRow icon={User} label="Identity Verification" value="Demo" />
        <MenuRow icon={Settings} label="Preferences" onClick={() => setCurrentView('preferences')} />
        <MenuRow icon={Bell} label="Notifications" />
        
        <div className="h-4"></div>
        <SectionTitle>Support & Information</SectionTitle>
        <MenuRow icon={HelpCircle} label="Help Center" />
        <MenuRow icon={FileText} label="Fee Structure" />
        <MenuRow icon={FileText} label="About Mallick Exchange" />
      </div>

      <button onClick={handleLogout} className="w-full mt-8 py-3 rounded-lg border border-gray-800 text-red-500 font-medium hover:bg-gray-900 transition-colors">
        Log Out (Demo)
      </button>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2 mt-2 px-1">{children}</h3>;
}

function MenuRow({ icon: Icon, label, value, onClick }: { icon: React.ElementType, label: string, value?: string, onClick?: () => void }) {
  return (
    <div 
      onClick={onClick}
      className="flex items-center justify-between py-3 px-1 border-b border-gray-800/50 last:border-0 cursor-pointer hover:bg-gray-900/50 rounded-lg transition-colors"
    >
      <div className="flex items-center gap-3">
        <Icon size={20} className="text-gray-400" />
        <span className="text-white text-sm font-medium">{label}</span>
      </div>
      <div className="flex items-center gap-2">
        {value && <span className="text-xs text-gray-500">{value}</span>}
        <ChevronRight size={16} className="text-gray-600" />
      </div>
    </div>
  );
}
