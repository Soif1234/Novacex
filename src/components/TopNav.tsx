import React, { useState, useEffect } from 'react';
import { User, Bell, Search, Zap, ShieldCheck } from 'lucide-react';
import { NotificationPanel } from './notifications/NotificationPanel';
import { notificationService } from '../services/notifications/NotificationService';
import { useAuth } from '../contexts/AuthContext';
import { apiClient } from '../services/api/client';

interface TopNavProps {
  onAccountClick: () => void;
  onSearchClick?: () => void;
}

export function TopNav({ onAccountClick, onSearchClick }: TopNavProps) {
  const [showNotifications, setShowNotifications] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [systemHealth, setSystemHealth] = useState<'READY' | 'DEGRADED' | 'OFFLINE'>('READY');
  const { user } = useAuth();

  useEffect(() => {
    setUnreadCount(notificationService.getUnreadCount());
    const unsub = notificationService.subscribe(() => {
      setUnreadCount(notificationService.getUnreadCount());
    });

    const checkHealth = async () => {
      try {
        const res = await apiClient.get<any>('/health/ready');
        if (res?.status === 'degraded') {
          setSystemHealth('DEGRADED');
        } else if (res?.status === 'ready' || res?.status === 'ok' || res?.healthy) {
          setSystemHealth('READY');
        } else {
          setSystemHealth('DEGRADED');
        }
      } catch (err: any) {
        if (err?.statusCode === 503 && err?.details) {
          setSystemHealth('DEGRADED');
        } else {
          setSystemHealth('OFFLINE');
        }
      }
    };

    checkHealth();
    const interval = setInterval(checkHealth, 15000);

    return () => {
      unsub();
      clearInterval(interval);
    };
  }, []);


  return (
    <header className="bg-gray-950/90 backdrop-blur-xl z-40 px-4 py-3 flex items-center justify-between border-b border-gray-800/80 flex-none sticky top-0">
      <div className="flex items-center gap-3">
        <button 
          onClick={onAccountClick}
          aria-label="Account Settings"
          className="relative w-9 h-9 rounded-xl bg-gradient-to-tr from-gray-900 to-gray-800 border border-gray-700/60 flex items-center justify-center text-gray-300 hover:text-white hover:border-cyan-500/50 transition-all overflow-hidden cursor-pointer group shadow-sm"
        >
          {user?.avatar ? (
            <img src={user.avatar} alt="Avatar" className="w-full h-full object-cover" />
          ) : user ? (
            <span className="text-xs font-black uppercase text-cyan-400 group-hover:text-cyan-300">
              {user.displayName.substring(0, 2)}
            </span>
          ) : (
            <User size={18} className="text-gray-400 group-hover:text-white" />
          )}

          {user && (
            <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-emerald-500 rounded-full border-2 border-gray-950" />
          )}
        </button>

        {/* Brand & Health Capsule */}
        <div className="flex flex-col">
          <div className="flex items-center gap-1.5">
            <span className="font-black text-sm tracking-tight text-white flex items-center gap-1">
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-blue-500">NOVA</span>CEX
            </span>
            {user?.role === 'ADMIN' && (
              <span className="px-1.5 py-0.2 bg-indigo-500/20 text-indigo-400 border border-indigo-500/40 text-[9px] font-black rounded uppercase">
                ADMIN
              </span>
            )}
          </div>
          
          <div className="flex items-center gap-1.5 text-[10px] text-gray-400 font-medium">
            <div className={`w-1.5 h-1.5 rounded-full ${
              systemHealth === 'READY' ? 'bg-emerald-400 shadow-sm shadow-emerald-400/50 animate-pulse' :
              systemHealth === 'DEGRADED' ? 'bg-amber-400' :
              'bg-red-400'
            }`} />
            <span className="tracking-wide">{systemHealth === 'READY' ? 'Engine Ready' : systemHealth}</span>
          </div>
        </div>
      </div>
      
      <div className="flex items-center gap-2">
        {onSearchClick && (
          <button
            onClick={onSearchClick}
            aria-label="Search Markets"
            className="w-9 h-9 rounded-xl bg-gray-900/80 hover:bg-gray-800 border border-gray-800 flex items-center justify-center text-gray-400 hover:text-white transition-colors cursor-pointer"
          >
            <Search size={17} />
          </button>
        )}

        <button 
          onClick={() => setShowNotifications(true)}
          aria-label="Notifications"
          className="relative w-9 h-9 rounded-xl bg-gray-900/80 hover:bg-gray-800 border border-gray-800 flex items-center justify-center text-gray-400 hover:text-white transition-colors cursor-pointer"
        >
          <Bell size={17} />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[17px] h-[17px] bg-gradient-to-r from-red-500 to-rose-600 rounded-full border-2 border-gray-950 text-[9px] font-black text-white flex items-center justify-center px-1 shadow-sm">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>
      </div>

      <NotificationPanel isOpen={showNotifications} onClose={() => setShowNotifications(false)} />
    </header>
  );
}


