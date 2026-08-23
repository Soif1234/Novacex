import React from 'react';
import { Badge } from './Badge';

export interface StatusBadgeProps {
  status: 'ONLINE' | 'READY' | 'DEGRADED' | 'OFFLINE' | 'ACTIVE' | 'PENDING' | 'VERIFIED' | 'REJECTED' | 'FILLED' | 'CANCELLED' | 'OPEN' | string;
  className?: string;
}

export function StatusBadge({ status, className = '' }: StatusBadgeProps) {
  const s = status.toUpperCase();

  if (s === 'ONLINE' || s === 'READY' || s === 'VERIFIED' || s === 'FILLED' || s === 'ACTIVE') {
    return (
      <Badge variant="green" className={className}>
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0 animate-pulse" />
        {status}
      </Badge>
    );
  }

  if (s === 'DEGRADED' || s === 'PENDING' || s === 'OPEN') {
    return (
      <Badge variant="amber" className={className}>
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
        {status}
      </Badge>
    );
  }

  if (s === 'OFFLINE' || s === 'REJECTED' || s === 'CANCELLED' || s === 'HALTED') {
    return (
      <Badge variant="red" className={className}>
        <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
        {status}
      </Badge>
    );
  }

  return <Badge variant="gray" className={className}>{status}</Badge>;
}
