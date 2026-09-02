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
  const baseStyles = 'inline-flex items-center justify-center font-bold rounded-[16px] transition-all duration-150 focus:outline-none disabled:opacity-50 disabled:pointer-events-none active:scale-[0.98] select-none cursor-pointer';
  
  const variants = {
    primary: 'bg-brand-lime text-gray-950 hover:opacity-90',
    secondary: 'bg-brand-surface text-white border border-brand-border hover:bg-gray-800',
    danger: 'bg-brand-red text-white hover:opacity-90',
    success: 'bg-brand-green text-gray-950 hover:opacity-90',
    buy: 'bg-brand-green text-gray-950 hover:opacity-90',
    sell: 'bg-brand-red text-white hover:opacity-90',
    outline: 'border border-brand-border text-gray-300 hover:bg-gray-800 hover:text-white',
    ghost: 'text-gray-400 hover:text-white hover:bg-gray-800',
    nova: 'bg-brand-lime/15 border border-brand-lime/30 text-brand-lime hover:bg-brand-lime/25',
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
