import React from 'react';

export interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  actionText?: string;
  onAction?: () => void;
  className?: string;
}

export function SectionHeader({
  title,
  subtitle,
  actionText,
  onAction,
  className = ''
}: SectionHeaderProps) {
  return (
    <div className={`flex items-center justify-between mb-3 px-1 ${className}`}>
      <div>
        <h2 className="text-base font-bold text-white tracking-tight">{title}</h2>
        {subtitle && <p className="text-xs text-gray-400">{subtitle}</p>}
      </div>
      {actionText && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="text-xs font-bold text-cyan-400 hover:text-cyan-300 transition-colors select-none cursor-pointer"
        >
          {actionText}
        </button>
      )}
    </div>
  );
}
