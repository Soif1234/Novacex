import React from 'react';
import { User, Shield, Bell, HelpCircle, Gift, ChevronRight, Settings, FileText, CheckCircle2 } from 'lucide-react';
import { Card } from '../components/ui/Card';
import { useAuth } from '../contexts/AuthContext';

export function Account({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const { user, logout } = useAuth();

  const handleLogout = () => {
    logout();
    onNavigate('home');
  };

  if (!user) return null;

  return (
    <div className="pb-6 px-4 pt-4">
      <div className="bg-blue-900/20 border border-blue-500/20 rounded-lg p-2 mb-4 text-xs text-blue-400 text-center font-medium">
        DEMO ENVIRONMENT ACTIVE
      </div>
      <div className="flex items-center gap-4 mb-6">
        <div className="w-16 h-16 rounded-full bg-blue-600 flex items-center justify-center text-white text-xl font-bold uppercase">
          {user.name.substring(0, 2)}
        </div>
        <div>
          <h1 className="text-xl font-bold text-white mb-1">{user.name}</h1>
          <div className="flex items-center gap-2">
            <span className="text-gray-400 text-sm">ID: {user.id}</span>
            <div className="flex items-center gap-1 bg-emerald-500/10 text-emerald-500 px-2 py-0.5 rounded text-xs font-medium">
              <CheckCircle2 size={12} /> {user.isDemo ? 'Demo' : 'Verified'}
            </div>
          </div>
        </div>
      </div>

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
        <SectionTitle>System</SectionTitle>
        <MenuRow icon={Settings} label="Admin Dashboard" onClick={() => onNavigate('admin')} />
        
        <div className="h-4"></div>
        <SectionTitle>Account Functions</SectionTitle>
        <MenuRow icon={Shield} label="Security" value="Medium" />
        <MenuRow icon={User} label="Identity Verification" value={user.isDemo ? 'Demo' : 'Verified'} />
        <MenuRow icon={Settings} label="Preferences" />
        <MenuRow icon={Bell} label="Notifications" />
        
        <div className="h-4"></div>
        <SectionTitle>Support & Information</SectionTitle>
        <MenuRow icon={HelpCircle} label="Help Center" />
        <MenuRow icon={FileText} label="Fee Structure" />
        <MenuRow icon={FileText} label="About NovaCEX" />
      </div>

      <button onClick={handleLogout} className="w-full mt-8 py-3 rounded-lg border border-gray-800 text-red-500 font-medium hover:bg-gray-900 transition-colors">
        Log Out
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
