import React, { useState, useEffect } from 'react';
import { Notification } from '../../types/notifications';
import { notificationService } from '../../services/notifications/NotificationService';
import { Bell, X, Check, Trash2, ArrowUpRight, ArrowDownRight } from 'lucide-react';

export function NotificationToaster() {
  const [toasts, setToasts] = useState<Notification[]>([]);

  useEffect(() => {
    const handleNew = (notification: Notification) => {
      setToasts(prev => [...prev, notification]);
      
      // Auto-remove after 5 seconds
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== notification.id));
      }, 5000);
    };

    const unsub = notificationService.subscribeNew(handleNew);
    return unsub;
  }, []);

  const removeToast = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-16 right-4 z-50 flex flex-col gap-2 max-w-sm w-[calc(100vw-32px)]">
      {toasts.map(toast => (
        <div 
          key={toast.id}
          className="bg-gray-900 border border-gray-800 shadow-2xl rounded-lg p-4 animate-in slide-in-from-top-4 fade-in duration-300 relative overflow-hidden group"
        >
          <div className="flex justify-between items-start mb-1">
            <div className="flex items-center gap-2 text-sm font-bold text-gray-200">
              <Bell size={14} className="text-blue-500" />
              {toast.title}
            </div>
            <button 
              onClick={() => removeToast(toast.id)}
              className="text-gray-500 hover:text-white transition-colors"
            >
              <X size={14} />
            </button>
          </div>
          
          <div className="text-sm text-gray-400 mt-2 leading-relaxed">
            {toast.message}
          </div>
          
          <div className="flex items-center gap-4 mt-3 text-xs">
            <div className="flex flex-col">
              <span className="text-gray-500">Target</span>
              <span className="font-medium text-gray-300">{toast.targetPrice}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-gray-500">Triggered at</span>
              <span className={`font-medium ${toast.condition === 'ABOVE' ? 'text-emerald-500' : 'text-red-500'}`}>
                {toast.triggerPrice}
              </span>
            </div>
          </div>
          
        </div>
      ))}
    </div>
  );
}
