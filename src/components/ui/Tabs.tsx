import React from 'react';

export interface TabItem<T extends string> {
  id: T;
  label: React.ReactNode;
  badge?: React.ReactNode;
}

export interface TabsProps<T extends string> {
  tabs: TabItem<T>[];
  activeTab: T;
  onChange: (tab: T) => void;
  variant?: 'underline' | 'pill';
  className?: string;
}

export function Tabs<T extends string>({
  tabs,
  activeTab,
  onChange,
  variant = 'underline',
  className = ''
}: TabsProps<T>) {
  if (variant === 'pill') {
    return (
      <div className={`flex items-center gap-1.5 overflow-x-auto hide-scrollbar py-1 ${className}`}>
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onChange(tab.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-all flex items-center gap-1.5 select-none cursor-pointer ${
                isActive 
                  ? 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/30 shadow-sm' 
                  : 'bg-gray-900/60 text-gray-400 hover:text-gray-200 border border-gray-800/80 hover:bg-gray-850'
              }`}
            >
              {tab.label}
              {tab.badge}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-6 border-b border-gray-800/80 overflow-x-auto hide-scrollbar ${className}`}>
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={`pb-3 text-xs md:text-sm font-bold whitespace-nowrap relative transition-colors flex items-center gap-1.5 select-none cursor-pointer ${
              isActive ? 'text-white' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            {tab.label}
            {tab.badge}
            {isActive && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-cyan-400 to-blue-500 rounded-full shadow-sm shadow-cyan-400/50" />
            )}
          </button>
        );
      })}
    </div>
  );
}
