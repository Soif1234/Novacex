import React, { useState, useEffect } from 'react';
import { User, Bell, Search } from 'lucide-react';
import { NotificationPanel } from './notifications/NotificationPanel';
import { notificationService } from '../services/notifications/NotificationService';

interface TopNavProps {
  onAccountClick: () => void;
}

export function TopNav({ onAccountClick }: TopNavProps) {
  const [showNotifications, setShowNotifications] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    setUnreadCount(notificationService.getUnreadCount());
    const unsub = notificationService.subscribe(() => {
      setUnreadCount(notificationService.getUnreadCount());
    });
    return unsub;
  }, []);

  return (
    <div className="bg-gray-950/80 backdrop-blur-md z-40 px-4 py-3 flex items-center justify-between border-b border-gray-900 flex-none">
      <div className="flex items-center gap-3">
        <button 
          onClick={onAccountClick}
          className="w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center text-gray-300 hover:text-white transition-colors"
        >
          <User size={18} />
        </button>
        <Search size={20} className="text-gray-500" />
      </div>
      
      <div className="flex items-center gap-4">
        <button 
          onClick={() => setShowNotifications(true)}
          className="text-gray-400 hover:text-white transition-colors relative"
        >
          <Bell size={20} />
          {unreadCount > 0 && (
            <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-[16px] bg-red-500 rounded-full border-2 border-gray-950 text-[9px] font-bold text-white flex items-center justify-center px-0.5">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>
      </div>
      <NotificationPanel isOpen={showNotifications} onClose={() => setShowNotifications(false)} />
    </div>
  );
}
