import React from 'react';

export interface BadgeProps {
  children: React.ReactNode;
  variant?: 'cyan' | 'green' | 'red' | 'amber' | 'indigo' | 'gray' | 'outline';
  size?: 'sm' | 'md';
  className?: string;
}

export function Badge({ children, variant = 'gray', size = 'sm', className = '' }: BadgeProps) {
  const variants = {
    cyan: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
    green: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    red: 'bg-red-500/15 text-red-400 border-red-500/30',
    amber: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    indigo: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30',
    gray: 'bg-gray-800 text-gray-300 border-gray-700/60',
    outline: 'border border-gray-700 text-gray-400 bg-transparent'
  };

  const sizes = {
    sm: 'px-2 py-0.5 text-[10px] font-bold rounded-md',
    md: 'px-2.5 py-1 text-xs font-bold rounded-lg'
  };

  return (
    <span className={`inline-flex items-center gap-1 border ${variants[variant]} ${sizes[size]} ${className}`}>
      {children}
    </span>
  );
}
