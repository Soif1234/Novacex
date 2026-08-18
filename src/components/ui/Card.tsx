import React from 'react';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
  className?: string;
}

export function Card({ children, className = '', ...props }: CardProps) {
  return (
    <div className={`bg-gray-900 border border-gray-800 rounded-xl ${className}`} {...props}>
      {children}
    </div>
  );
}
