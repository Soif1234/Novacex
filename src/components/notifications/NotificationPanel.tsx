import React, { useState, useEffect } from 'react';
import { X, Bell, Trash2, CheckCheck, Clock } from 'lucide-react';
import { Notification } from '../../types/notifications';
import { notificationService } from '../../services/notifications/NotificationService';

interface NotificationPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function NotificationPanel({ isOpen, onClose }: NotificationPanelProps) {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  useEffect(() => {
    if (!isOpen) return;

    setNotifications(notificationService.getNotifications());
    const unsub = notificationService.subscribe(() => {
      setNotifications(notificationService.getNotifications());
    });
    
    return unsub;
  }, [isOpen]);

  if (!isOpen) return null;

  const handleClearAll = () => {
    if (confirm('Are you sure you want to clear all notifications?')) {
      notificationService.clearNotifications();
    }
  };

  const handleMarkAllRead = () => {
    notificationService.markAllAsRead();
  };

  const formatTimeAgo = (timestamp: number) => {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return new Date(timestamp).toLocaleDateString();
  };

  return (
    <div className="fixed inset-0 z-[100] flex flex-col justify-end bg-black/60 backdrop-blur-sm sm:items-center sm:justify-center">
      <div className="bg-gray-950 w-full sm:w-[400px] h-[85vh] sm:h-[600px] sm:max-h-[85vh] sm:rounded-2xl border border-gray-800 flex flex-col shadow-2xl animate-in slide-in-from-bottom-full sm:slide-in-from-bottom-0 sm:fade-in-0 duration-200">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-900 shrink-0">
          <div className="flex items-center gap-2 text-gray-200 font-bold">
            <Bell size={18} className="text-blue-500" />
            Notifications
          </div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-white rounded-full hover:bg-gray-800 transition-colors">
            <X size={20} />
          </button>
        </div>

        {notifications.length > 0 && (
          <div className="flex justify-between items-center px-4 py-2 border-b border-gray-900 bg-gray-900/30 shrink-0">
            <button 
              onClick={handleMarkAllRead}
              className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 transition-colors"
            >
              <CheckCheck size={14} /> Mark all read
            </button>
            <button 
              onClick={handleClearAll}
              className="text-xs text-red-400 hover:text-red-300 transition-colors"
            >
              Clear All
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
          {notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-gray-500 text-center">
              <Bell size={32} className="mb-3 opacity-20" />
              <p className="text-sm font-medium mb-1">All caught up!</p>
              <p className="text-xs">You have no new notifications.</p>
            </div>
          ) : (
            notifications.map(notif => (
              <div 
                key={notif.id}
                onClick={() => notificationService.markAsRead(notif.id)}
                className={`bg-gray-900 border rounded-lg p-3 relative group transition-colors cursor-pointer ${
                  notif.read ? 'border-gray-800 opacity-70 hover:opacity-100' : 'border-blue-500/30 bg-blue-500/5'
                }`}
              >
                {!notif.read && (
                  <div className="absolute top-3 right-3 w-2 h-2 bg-blue-500 rounded-full"></div>
                )}
                
                <div className="flex justify-between items-start mb-1 pr-6">
                  <span className="font-bold text-gray-200 text-sm">{notif.symbol}</span>
                </div>
                
                <div className="text-sm text-gray-400 leading-relaxed mb-3">
                  {notif.message}
                </div>

                <div className="flex items-center justify-between text-xs text-gray-500">
                  <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1">
                      Target: <span className="text-gray-300">{notif.targetPrice}</span>
                    </span>
                    <span className="flex items-center gap-1">
                      Triggered: <span className={`font-medium ${notif.condition === 'ABOVE' ? 'text-emerald-500' : 'text-red-500'}`}>
                        {notif.triggerPrice}
                      </span>
                    </span>
                  </div>
                </div>
                
                <div className="flex items-center justify-between mt-3 pt-2 border-t border-gray-800/50">
                  <span className="text-[10px] text-gray-500 flex items-center gap-1">
                    <Clock size={10} /> {formatTimeAgo(notif.createdAt)}
                  </span>
                  
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      notificationService.deleteNotification(notif.id);
                    }}
                    className="text-gray-500 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100 p-1"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
