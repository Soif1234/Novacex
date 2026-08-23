import React from 'react';

export interface SkeletonProps {
  className?: string;
  variant?: 'rectangular' | 'circular' | 'text';
}

export function Skeleton({ className = '', variant = 'rectangular' }: SkeletonProps) {
  const variantStyles = {
    rectangular: 'rounded-xl',
    circular: 'rounded-full',
    text: 'rounded-md h-4'
  };

  return (
    <div 
      className={`bg-gray-800/60 animate-pulse ${variantStyles[variant]} ${className}`}
    />
  );
}
