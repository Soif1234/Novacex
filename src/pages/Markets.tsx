import React, { useState } from 'react';
import { Search, Star, ArrowUpRight, ArrowDownRight, Loader2 } from 'lucide-react';
import { useMarketData } from '../hooks/useMarketData';

export function Markets({ onNavigate }: { onNavigate: (tab: string, symbol?: string) => void }) {
  const [activeTab, setActiveTab] = useState('spot');
  const { data: markets, loading, isRefreshing, error, lastUpdated } = useMarketData();

  return (
    <div className="pb-6">
      {/* Header */}
      <div className="px-4 py-3 sticky top-0 bg-gray-950 z-30">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold text-white">Markets</h1>
          {lastUpdated && (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-gray-900 border border-gray-800">
              {isRefreshing && !loading && <Loader2 size={12} className="animate-spin text-gray-400" />}
              <span className="text-[11px] font-medium text-gray-500">
                Updated {lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            </div>
          )}
        </div>
        
        {/* Search */}
        <div className="relative mb-4">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Search size={16} className="text-gray-500" />
          </div>
          <input
            type="text"
            className="block w-full pl-10 pr-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm placeholder-gray-500 text-white focus:outline-none focus:border-gray-700"
            placeholder="Search coin pairs"
          />
        </div>

        {/* Categories */}
        <div className="flex gap-6 border-b border-gray-800">
          <TabButton active={activeTab === 'favorites'} onClick={() => setActiveTab('favorites')}>
            <Star size={16} className={activeTab === 'favorites' ? 'fill-current' : ''} /> Favorites
          </TabButton>
          <TabButton active={activeTab === 'spot'} onClick={() => setActiveTab('spot')}>Spot</TabButton>
          <TabButton active={activeTab === 'futures'} onClick={() => setActiveTab('futures')}>Futures</TabButton>
        </div>
      </div>

      {/* Market List */}
      <div className="px-4 mt-2">
        <div className="flex text-xs font-medium text-gray-500 mb-2 px-1">
          <div className="flex-1">Name / Vol</div>
          <div className="w-24 text-right">Price</div>
          <div className="w-20 text-right">24h Chg%</div>
        </div>

        <div className="flex flex-col">
          {loading ? (
            <div className="py-12 flex justify-center text-gray-500">
              <Loader2 className="animate-spin" size={32} />
            </div>
          ) : error ? (
            <div className="py-6 text-center text-sm text-red-500 bg-red-500/10 rounded-lg mx-1 mt-2">
              Failed to load real-time markets. Showing demo data.
            </div>
          ) : null}
          {markets.map((market) => (
            <div 
              key={market.id} 
              className="flex items-center py-3 border-b border-gray-800/50 hover:bg-gray-900/40 rounded-lg px-2 -mx-2 transition-colors cursor-pointer"
              onClick={() => onNavigate('trade', market.baseAsset)}
            >
              <div className="flex-1">
                <div className="flex items-baseline gap-1">
                  <span className="font-bold text-gray-100 text-base">{market.baseAsset}</span>
                  <span className="text-xs text-gray-500 font-medium">/{market.quoteAsset}</span>
                </div>
                <div className="text-xs text-gray-500 mt-0.5 font-medium">Vol {(market.volume / 1000000).toFixed(2)}M</div>
              </div>
              <div className="w-24 text-right flex flex-col justify-center">
                <div className={`font-bold ${market.change24h >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                  ${market.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
                </div>
              </div>
              <div className="w-20 text-right flex justify-end items-center">
                <div className={`px-2 py-1 rounded text-xs font-bold w-full flex items-center justify-center ${
                  market.change24h >= 0 ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500'
                }`}>
                  {market.change24h >= 0 ? '+' : ''}{market.change24h.toFixed(2)}%
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean, onClick: () => void, children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`py-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-1 ${
        active ? 'border-white text-white' : 'border-transparent text-gray-500 hover:text-gray-300'
      }`}
    >
      {children}
    </button>
  );
}
