import React from 'react';

export function Logo({ className = '', compact = false }: { className?: string, compact?: boolean }) {
  if (compact) {
    return (
      <svg className={className} width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="40" height="40" rx="8" fill="#0B1F1A"/>
        <path d="M10 28L15 14L20 22L25 14L30 28" stroke="#3ED9B3" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M10 12L15 26L20 18L25 26L30 12" stroke="#3ED9B3" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.4"/>
      </svg>
    );
  }

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="40" height="40" rx="8" fill="#0B1F1A"/>
        <path d="M10 28L15 14L20 22L25 14L30 28" stroke="#3ED9B3" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M10 12L15 26L20 18L25 26L30 12" stroke="#3ED9B3" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.4"/>
      </svg>
      <div className="flex flex-col justify-center">
        <span className="text-[#F4F6F5] font-bold text-lg leading-tight tracking-wide">Mallick</span>
        <span className="text-[#3ED9B3] text-[9px] font-medium tracking-[0.2em] leading-tight">EXCHANGE</span>
      </div>
    </div>
  );
}
