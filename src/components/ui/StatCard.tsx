import React from 'react';
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';

export interface StatCardProps {
  label: string;
  value: string | number;
  subValue?: string;
  change?: number | string;
  prefix?: string;
  suffix?: string;
  icon?: React.ElementType;
  className?: string;
}

export function StatCard({
  label,
  value,
  subValue,
  change,
  prefix = '',
  suffix = '',
  icon: Icon,
  className = ''
}: StatCardProps) {
  const changeNum = typeof change === 'string' ? parseFloat(change) : change;
  const hasChange = change !== undefined && !isNaN(changeNum as number);

  return (
    <div className={`bg-gray-900/80 border border-gray-800/80 rounded-2xl p-4 flex flex-col justify-between ${className}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{label}</span>
        {Icon && (
          <div className="w-8 h-8 rounded-xl bg-gray-800/70 flex items-center justify-center text-gray-300">
            <Icon size={16} />
          </div>
        )}
      </div>

      <div className="flex items-baseline gap-2">
        <span className="text-xl md:text-2xl font-black text-white font-mono tabular-nums tracking-tight">
          {prefix}{value}{suffix}
        </span>
        {hasChange && (
          <span className={`text-xs font-bold flex items-center ${(changeNum as number) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {(changeNum as number) >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
            {Math.abs(changeNum as number).toFixed(2)}%
          </span>
        )}
      </div>

      {subValue && (
        <span className="text-xs text-gray-500 font-mono mt-1">{subValue}</span>
      )}
    </div>
  );
}
