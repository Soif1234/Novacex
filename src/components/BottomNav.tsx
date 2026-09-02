import React from 'react';
import { Home, BarChart3, ArrowLeftRight, TrendingUp, Wallet } from 'lucide-react';

interface BottomNavProps {
  activeTab: string;
  onChange: (tab: string) => void;
}

export function BottomNav({ activeTab, onChange }: BottomNavProps) {
  const tabs = [
    { id: 'home', icon: Home, label: 'Home' },
    { id: 'markets', icon: BarChart3, label: 'Markets' },
    { id: 'trade', icon: ArrowLeftRight, label: 'Spot' },
    { id: 'futures', icon: TrendingUp, label: 'Futures' },
    { id: 'assets', icon: Wallet, label: 'Assets' },
  ];

  return (
    <nav className="bg-brand-bg/95 backdrop-blur-xl border-t border-brand-border pb-[calc(env(safe-area-inset-bottom)+4px)] pt-1.5 z-50 flex-none sticky bottom-0">
      <div className="flex items-center justify-around px-2 max-w-lg mx-auto">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;

          return (
            <button
              key={tab.id}
              onClick={() => onChange(tab.id)}
              aria-label={tab.label}
              className={`relative flex flex-col items-center justify-center w-16 h-12 gap-1 transition-all select-none cursor-pointer rounded-xl ${
                isActive
                  ? 'text-brand-lime font-bold'
                  : 'text-gray-400 hover:text-gray-200 font-medium'
              }`}
            >
              {isActive && (
                <span className="absolute -top-1.5 w-6 h-0.5 bg-brand-lime rounded-full" />
              )}
              <div className={`transition-transform duration-150 ${isActive ? 'scale-110' : 'scale-100'}`}>
                <Icon size={20} strokeWidth={isActive ? 2.5 : 2} />
              </div>
              <span className="text-[10px] tracking-tight">{tab.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
