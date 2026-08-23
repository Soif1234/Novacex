import React from 'react';
import { Loader2 } from 'lucide-react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'success' | 'buy' | 'sell' | 'outline' | 'ghost' | 'nova';
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
  isLoading?: boolean;
  children?: React.ReactNode;
  className?: string;
  type?: 'button' | 'submit' | 'reset';
  onClick?: React.MouseEventHandler<HTMLButtonElement> | (() => void);
  disabled?: boolean;
}

export function Button({ 
  children, 
  variant = 'primary', 
  size = 'md', 
  fullWidth = false, 
  isLoading = false,
  className = '', 
  disabled,
  ...props 
}: ButtonProps) {
  const baseStyles = 'inline-flex items-center justify-center font-bold rounded-xl transition-all duration-150 focus:outline-none disabled:opacity-50 disabled:pointer-events-none active:scale-[0.98] select-none cursor-pointer';
  
  const variants = {
    primary: 'bg-gradient-to-r from-cyan-500 to-blue-600 text-gray-950 font-extrabold hover:from-cyan-400 hover:to-blue-500 shadow-md shadow-cyan-500/20',
    secondary: 'bg-gray-800 text-gray-200 hover:bg-gray-750 hover:text-white border border-gray-700/60',
    danger: 'bg-red-500 text-white hover:bg-red-600 shadow-md shadow-red-500/20',
    success: 'bg-emerald-500 text-gray-950 font-extrabold hover:bg-emerald-400 shadow-md shadow-emerald-500/20',
    buy: 'bg-emerald-500 hover:bg-emerald-400 text-gray-950 font-extrabold shadow-md shadow-emerald-500/20',
    sell: 'bg-red-500 hover:bg-red-400 text-white font-extrabold shadow-md shadow-red-500/20',
    outline: 'border border-gray-700 text-gray-300 hover:bg-gray-800/80 hover:text-white',
    ghost: 'text-gray-400 hover:text-white hover:bg-gray-800/40',
    nova: 'bg-cyan-500/15 border border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/25 hover:border-cyan-400',
  };

  const sizes = {
    sm: 'text-xs px-3 py-1.5 h-8 gap-1.5',
    md: 'text-xs md:text-sm px-4 py-2.5 h-10 gap-2',
    lg: 'text-sm md:text-base px-6 py-3.5 h-12 gap-2.5',
  };

  const classes = [
    baseStyles,
    variants[variant],
    sizes[size],
    fullWidth ? 'w-full' : '',
    className
  ].join(' ');

  return (
    <button className={classes} disabled={disabled || isLoading} {...props}>
      {isLoading && <Loader2 size={16} className="animate-spin shrink-0" />}
      {children}
    </button>
  );
}

