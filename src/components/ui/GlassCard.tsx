import React from 'react';

export interface GlassCardProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
  className?: string;
  glow?: 'cyan' | 'green' | 'red' | 'none';
}

export function GlassCard({ children, glow = 'none', className = '', ...props }: GlassCardProps) {
  const glowClasses = {
    cyan: 'shadow-lg shadow-cyan-500/10 border-cyan-500/30',
    green: 'shadow-lg shadow-emerald-500/10 border-emerald-500/30',
    red: 'shadow-lg shadow-red-500/10 border-red-500/30',
    none: 'border-white/5 shadow-lg shadow-black/20'
  };

  return (
    <div 
      className={`bg-gradient-to-b from-gray-900/80 via-gray-900/60 to-gray-950/80 backdrop-blur-xl border rounded-2xl ${glowClasses[glow]} ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}
