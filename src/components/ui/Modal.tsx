import React, { useEffect } from 'react';
import { X } from 'lucide-react';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl';
}

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  maxWidth = 'md'
}: ModalProps) {
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  if (!isOpen) return null;

  const maxWidths = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl'
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fadeIn">
      <div 
        className="fixed inset-0" 
        onClick={onClose} 
      />
      
      <div className={`relative w-full ${maxWidths[maxWidth]} bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl shadow-black/80 overflow-hidden z-10 max-h-[90vh] flex flex-col`}>
        {title && (
          <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between flex-none">
            <h3 className="text-base font-bold text-white">{title}</h3>
            <button
              onClick={onClose}
              className="p-1 text-gray-400 hover:text-white rounded-lg hover:bg-gray-800 transition-colors"
            >
              <X size={18} />
            </button>
          </div>
        )}

        <div className="p-5 overflow-y-auto hide-scrollbar flex-1">
          {children}
        </div>
      </div>
    </div>
  );
}
