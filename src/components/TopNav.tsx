import React from 'react';
import { User, Bell, Search } from 'lucide-react';

interface TopNavProps {
  onAccountClick: () => void;
}

export function TopNav({ onAccountClick }: TopNavProps) {
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
        <button className="text-gray-400 hover:text-white transition-colors relative">
          <Bell size={20} />
          <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-red-500 rounded-full border-2 border-gray-950"></span>
        </button>
      </div>
    </div>
  );
}
