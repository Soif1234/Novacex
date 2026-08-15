import React, { useState } from 'react';
import { Eye, Clock, Download, Upload, ArrowRightLeft, CreditCard } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { usePortfolio } from '../hooks/usePortfolio';
import { useAuth } from '../contexts/AuthContext';
import { PortfolioAsset } from '../types/portfolio';

const ASSET_DETAILS: Record<string, { name: string, color: string }> = {
  USDT: { name: 'Tether US', color: 'bg-[#26A17B]' },
  BTC: { name: 'Bitcoin', color: 'bg-[#F7931A]' },
  ETH: { name: 'Ethereum', color: 'bg-[#627EEA]' },
  SOL: { name: 'Solana', color: 'bg-[#14F195] text-gray-950' },
  XRP: { name: 'Ripple', color: 'bg-[#23292F]' },
  DOGE: { name: 'Dogecoin', color: 'bg-[#C2A633]' }
};

export function Assets() {
  const [activeTab, setActiveTab] = useState('overview');
  const { user } = useAuth();
  const { stats, isLoading } = usePortfolio(user?.id || 'demo-account');

  if (isLoading || !stats) {
    return <div className="flex items-center justify-center min-h-screen text-gray-500">Loading portfolio...</div>;
  }

  const isPositiveChange = Number(stats.change24h) >= 0;

  return (
    <div className="pb-6">
      <div className="px-4 py-4 bg-gray-900 rounded-b-3xl pb-8 relative overflow-hidden">
        {/* Banner */}
        <div className="absolute top-0 right-0 p-2 opacity-50">
          <div className="text-[10px] font-bold text-blue-400 px-2 py-0.5 rounded bg-blue-500/10 border border-blue-500/20">
            DEMO TRADING
          </div>
        </div>
        
        <div className="flex justify-between items-center mb-6 mt-2">
          <h1 className="text-xl font-bold text-white">Assets</h1>
          <div className="flex gap-4 text-gray-400">
            <Eye size={20} />
            <Clock size={20} />
          </div>
        </div>
        
        <div className="text-gray-400 text-sm mb-1">Total Demo Value (USDT)</div>
        <div className="flex items-end gap-2 mb-2">
          <span className="text-3xl font-bold text-white">
            {Number(stats.totalValue).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
        
        <div className="flex gap-4 mb-6 text-sm">
          <div className="flex flex-col">
            <span className="text-gray-500 text-xs">Today's PNL</span>
            <span className={`font-medium ${isPositiveChange ? 'text-emerald-500' : 'text-red-500'}`}>
              {isPositiveChange ? '+' : ''}{Number(stats.change24h).toFixed(2)} ({isPositiveChange ? '+' : ''}{Number(stats.change24hPercent).toFixed(2)}%)
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-gray-500 text-xs">Unrealized PNL</span>
            <span className={`font-medium ${Number(stats.totalUnrealizedPnl) >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
              {Number(stats.totalUnrealizedPnl) >= 0 ? '+' : ''}{Number(stats.totalUnrealizedPnl).toFixed(2)}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-gray-500 text-xs">Realized PNL</span>
            <span className={`font-medium ${Number(stats.totalRealizedPnl) >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
              {Number(stats.totalRealizedPnl) >= 0 ? '+' : ''}{Number(stats.totalRealizedPnl).toFixed(2)}
            </span>
          </div>
        </div>

        <div className="flex gap-2">
          <ActionButton icon={Download} label="Deposit" disabled />
          <ActionButton icon={Upload} label="Withdraw" disabled />
          <ActionButton icon={ArrowRightLeft} label="Transfer" disabled />
          <ActionButton icon={CreditCard} label="Buy" disabled />
        </div>
      </div>

      <div className="px-4 mt-6">
        {/* Tabs */}
        <div className="flex gap-6 border-b border-gray-800 mb-4 overflow-x-auto hide-scrollbar">
          <Tab active={activeTab === 'overview'} onClick={() => setActiveTab('overview')}>Overview</Tab>
          <Tab active={activeTab === 'spot'} onClick={() => setActiveTab('spot')}>Spot</Tab>
          <Tab active={activeTab === 'futures'} onClick={() => setActiveTab('futures')}>Futures</Tab>
          <Tab active={activeTab === 'earn'} onClick={() => setActiveTab('earn')}>Earn</Tab>
        </div>

        {/* Portfolio List */}
        <div className="flex flex-col gap-3">
          {stats.assets.map((asset) => {
            const details = ASSET_DETAILS[asset.symbol] || { name: asset.symbol, color: 'bg-gray-700' };
            return (
              <React.Fragment key={asset.symbol}>
                <AssetRow 
                  asset={asset}
                  details={details}
                />
              </React.Fragment>
            );
          })}
          {stats.assets.length === 0 && (
            <div className="text-center text-gray-500 py-8">
              No assets in portfolio
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ActionButton({ icon: Icon, label, disabled = false }: { icon: React.ElementType, label: string, disabled?: boolean }) {
  return (
    <button 
      disabled={disabled}
      className={`flex-1 bg-gray-800/80 border border-gray-700/50 rounded-xl py-3 flex flex-col items-center gap-2 transition-colors shadow-sm ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-700'}`}
    >
      <Icon size={20} className="text-gray-100" />
      <span className="text-[11px] font-bold text-gray-200">{label}</span>
    </button>
  );
}

function Tab({ active, onClick, children }: { active: boolean, onClick: () => void, children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`py-2 text-sm font-bold border-b-2 whitespace-nowrap transition-colors ${
        active ? 'border-blue-500 text-blue-500' : 'border-transparent text-gray-500 hover:text-gray-300'
      }`}
    >
      {children}
    </button>
  );
}

function AssetRow({ asset, details }: { asset: PortfolioAsset, details: { name: string, color: string } }) {
  const isUsdt = asset.symbol === 'USDT';
  const unrealized = Number(asset.unrealizedPnl);

  return (
    <div className="flex flex-col py-3 px-3 hover:bg-gray-900/40 rounded-xl cursor-pointer transition-colors border border-gray-800/50 bg-gray-900/20">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-full ${details.color} flex items-center justify-center font-bold text-white text-xs shadow-inner`}>
            {asset.symbol.charAt(0)}
          </div>
          <div>
            <div className="font-bold text-gray-100 flex items-center gap-2">
              {asset.symbol} 
              {Number(asset.locked) > 0 && <span className="text-[9px] bg-gray-800 px-1 py-0.5 rounded text-gray-400 font-medium">LOCKED: {Number(asset.locked).toFixed(4)}</span>}
            </div>
            <div className="text-[11px] font-medium text-gray-500">{details.name} {isUsdt ? '' : `· $${Number(asset.currentPrice).toLocaleString(undefined, { maximumFractionDigits: 2 })}`}</div>
          </div>
        </div>
        <div className="text-right">
          <div className="font-bold text-gray-100">{Number(asset.balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}</div>
          <div className="text-[11px] font-medium text-gray-500">≈ ${Number(asset.valueUsdt).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
      </div>
      
      {!isUsdt && (
        <div className="flex justify-between items-center text-xs mt-2 pt-2 border-t border-gray-800/50">
          <div className="flex gap-4">
            <span className="text-gray-500">Avg Cost: <span className="text-gray-300">${Number(asset.avgEntryPrice).toFixed(2)}</span></span>
            <span className="text-gray-500">Unrealized: <span className={unrealized >= 0 ? 'text-emerald-500' : 'text-red-500'}>{unrealized >= 0 ? '+' : ''}{unrealized.toFixed(2)}</span></span>
          </div>
          <div className="text-gray-500">
             Realized: <span className={Number(asset.realizedPnl) >= 0 ? 'text-emerald-500' : 'text-red-500'}>{Number(asset.realizedPnl) >= 0 ? '+' : ''}{Number(asset.realizedPnl).toFixed(2)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
