import React from 'react';

export interface CoinAvatarProps {
  symbol: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

const COIN_COLORS: Record<string, { bg: string; text: string }> = {
  BTC: { bg: 'bg-amber-500/20 border-amber-500/40', text: 'text-amber-400' },
  ETH: { bg: 'bg-indigo-500/20 border-indigo-500/40', text: 'text-indigo-400' },
  SOL: { bg: 'bg-teal-500/20 border-teal-500/40', text: 'text-teal-400' },
  USDT: { bg: 'bg-emerald-500/20 border-emerald-500/40', text: 'text-emerald-400' },
  USDC: { bg: 'bg-blue-500/20 border-blue-500/40', text: 'text-blue-400' },
  BNB: { bg: 'bg-yellow-500/20 border-yellow-500/40', text: 'text-yellow-400' },
  XRP: { bg: 'bg-cyan-500/20 border-cyan-500/40', text: 'text-cyan-400' },
  DOGE: { bg: 'bg-amber-600/20 border-amber-600/40', text: 'text-amber-300' },
  ADA: { bg: 'bg-blue-600/20 border-blue-600/40', text: 'text-blue-300' },
  AVAX: { bg: 'bg-red-500/20 border-red-500/40', text: 'text-red-400' },
  LINK: { bg: 'bg-blue-400/20 border-blue-400/40', text: 'text-blue-300' },
  DEFAULT: { bg: 'bg-gray-800 border-gray-700', text: 'text-gray-300' }
};

export function CoinAvatar({ symbol, size = 'md', className = '' }: CoinAvatarProps) {
  const baseSymbol = symbol.replace(/USDT|USDC|USD|PERP|-PERP/gi, '').toUpperCase() || symbol;
  const config = COIN_COLORS[baseSymbol] || COIN_COLORS.DEFAULT;

  const sizeClasses = {
    sm: 'w-6 h-6 text-[10px]',
    md: 'w-8 h-8 text-xs',
    lg: 'w-10 h-10 text-sm',
    xl: 'w-12 h-12 text-base font-black'
  };

  return (
    <div 
      className={`rounded-xl border flex items-center justify-center font-extrabold uppercase shrink-0 select-none ${config.bg} ${config.text} ${sizeClasses[size]} ${className}`}
    >
      {baseSymbol.slice(0, 3)}
    </div>
  );
}
