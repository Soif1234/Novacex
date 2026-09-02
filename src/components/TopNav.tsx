import React, { useState, useEffect } from 'react';
import { User, Bell, Search } from 'lucide-react';
import { NotificationPanel } from './notifications/NotificationPanel';
import { notificationService } from '../services/notifications/NotificationService';
import { useAuth } from '../contexts/AuthContext';
import { apiClient } from '../services/api/client';
import { Logo } from './ui/Logo';

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
    <header className="bg-brand-bg/95 backdrop-blur-xl z-40 px-4 py-3 flex items-center justify-between border-b border-brand-border flex-none sticky top-0">
      <div className="flex items-center gap-3">
        <Logo compact={true} />
        {user?.role === 'ADMIN' && (
          <span className="px-1.5 py-0.5 bg-brand-lime/10 text-brand-lime border border-brand-lime/30 text-[9px] font-bold rounded uppercase">
            ADMIN
          </span>
        )}
      </div>

      <div className="flex-1 max-w-[200px] mx-3">
        <button
          onClick={onSearchClick}
          className="w-full h-9 rounded-full bg-brand-surface border border-brand-border flex items-center px-3 text-gray-500 hover:text-gray-300 transition-colors"
        >
          <Search size={14} className="mr-2" />
          <span className="text-[11px] font-medium tracking-wide">Search pairs...</span>
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={onAccountClick}
          aria-label="Account Settings"
          className="relative w-9 h-9 rounded-full bg-brand-surface border border-brand-border flex items-center justify-center text-gray-300 hover:text-white transition-all overflow-hidden cursor-pointer group"
        >
          {user?.avatar ? (
            <img src={user.avatar} alt="Avatar" className="w-full h-full object-cover" />
          ) : user ? (
            <span className="text-xs font-bold uppercase text-brand-lime">
              {user.displayName.substring(0, 2)}
            </span>
          ) : (
            <User size={16} className="text-gray-400 group-hover:text-white" />
          )}

          {user && (
            <span className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-[1.5px] border-brand-bg ${systemHealth === 'READY' ? 'bg-brand-green' : 'bg-brand-red'}`} />
          )}
        </button>

        <button
          onClick={() => setShowNotifications(true)}
          aria-label="Notifications"
          className="relative w-9 h-9 rounded-full bg-brand-surface hover:bg-gray-800 border border-brand-border flex items-center justify-center text-gray-400 hover:text-white transition-colors cursor-pointer"
        >
          <Bell size={16} />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] bg-brand-red rounded-full border-[1.5px] border-brand-bg text-[9px] font-bold text-white flex items-center justify-center px-1">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>
      </div>

      <NotificationPanel isOpen={showNotifications} onClose={() => setShowNotifications(false)} />
    </header>
  );
}
