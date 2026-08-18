import React from 'react';
import { Home, LineChart, ArrowLeftRight, Activity, Wallet, User } from 'lucide-react';

interface BottomNavProps {
  activeTab: string;
  onChange: (tab: string) => void;
}

export function BottomNav({ activeTab, onChange }: BottomNavProps) {
  const tabs = [
    { id: 'home', icon: Home, label: 'Home' },
    { id: 'markets', icon: LineChart, label: 'Markets' },
    { id: 'trade', icon: ArrowLeftRight, label: 'Trade' },
    { id: 'futures', icon: Activity, label: 'Futures' },
    { id: 'assets', icon: Wallet, label: 'Assets' },
  ];

  return (
    <div className="bg-gray-950 border-t border-gray-800 pb-[env(safe-area-inset-bottom)] z-50 flex-none">
      <div className="flex items-center justify-around px-2 py-2">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          
          return (
            <button
              key={tab.id}
              onClick={() => onChange(tab.id)}
              className={`flex flex-col items-center justify-center w-16 h-12 gap-1 transition-colors ${
                isActive ? 'text-blue-500' : 'text-gray-500 hover:text-gray-400'
              }`}
            >
              <Icon size={20} strokeWidth={isActive ? 2.5 : 2} />
              <span className="text-[10px] font-medium">{tab.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
