import React from 'react';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'glass' | 'elevated' | 'interactive';
  children?: React.ReactNode;
  className?: string;
}

export function Card({ children, variant = 'default', className = '', ...props }: CardProps) {
  const variantStyles = {
    default: 'bg-gray-900/90 border border-gray-800/80 rounded-2xl',
    glass: 'bg-gradient-to-b from-gray-900/80 to-gray-950/90 backdrop-blur-md border border-white/5 rounded-2xl',
    elevated: 'bg-gray-850 border border-gray-750/70 shadow-lg shadow-black/40 rounded-2xl',
    interactive: 'bg-gray-900/90 hover:bg-gray-850/90 border border-gray-800 hover:border-gray-700/80 transition-all rounded-2xl cursor-pointer',
  };

  return (
    <div className={`${variantStyles[variant]} ${className}`} {...props}>
      {children}
    </div>
  );
}

