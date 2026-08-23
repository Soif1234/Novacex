import React from 'react';

export interface SegmentedControlOption<T extends string> {
  id: T;
  label: React.ReactNode;
  color?: 'buy' | 'sell' | 'default';
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  className?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  className = ''
}: SegmentedControlProps<T>) {
  const sizeClasses = {
    sm: 'p-0.5 rounded-lg text-xs',
    md: 'p-1 rounded-xl text-xs md:text-sm'
  };

  return (
    <div className={`bg-gray-950 border border-gray-800/80 flex items-center ${sizeClasses[size]} ${className}`}>
      {options.map((opt) => {
        const isActive = opt.id === value;
        let activeBg = 'bg-gray-800 text-white shadow-sm';
        if (opt.color === 'buy' && isActive) {
          activeBg = 'bg-emerald-500 text-gray-950 font-black shadow-md shadow-emerald-500/20';
        } else if (opt.color === 'sell' && isActive) {
          activeBg = 'bg-red-500 text-white font-black shadow-md shadow-red-500/20';
        }

        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            className={`flex-1 py-1.5 px-3 rounded-lg font-bold transition-all text-center select-none cursor-pointer ${
              isActive ? activeBg : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
