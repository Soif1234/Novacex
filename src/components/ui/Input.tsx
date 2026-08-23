import React from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  prefixElement?: React.ReactNode;
  suffixElement?: React.ReactNode;
  error?: string;
  helperText?: string;
  className?: string;
  disabled?: boolean;
}


export function Input({
  label,
  prefixElement,
  suffixElement,
  error,
  helperText,
  className = '',
  disabled,
  ...props
}: InputProps) {
  return (
    <div className="w-full flex flex-col gap-1.5">
      {label && (
        <label className="text-xs font-semibold text-gray-400 flex items-center justify-between">
          <span>{label}</span>
        </label>
      )}

      <div className={`relative flex items-center bg-gray-950 border rounded-xl transition-all ${
        error 
          ? 'border-red-500/80 focus-within:border-red-500 shadow-sm shadow-red-500/20' 
          : 'border-gray-800 focus-within:border-cyan-500/80 focus-within:ring-1 focus-within:ring-cyan-500/30'
      } ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
        {prefixElement && (
          <div className="pl-3 flex items-center text-gray-400 text-xs font-bold">
            {prefixElement}
          </div>
        )}

        <input
          disabled={disabled}
          className={`w-full bg-transparent px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none font-mono tabular-nums ${className}`}
          {...props}
        />

        {suffixElement && (
          <div className="pr-3 flex items-center text-gray-400 text-xs font-bold">
            {suffixElement}
          </div>
        )}
      </div>

      {error ? (
        <span className="text-[11px] font-semibold text-red-400 px-1">{error}</span>
      ) : helperText ? (
        <span className="text-[11px] text-gray-500 px-1">{helperText}</span>
      ) : null}
    </div>
  );
}
