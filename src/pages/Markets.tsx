import React, { useState, useMemo } from 'react';
import { Search, Star, Loader2, ArrowUpRight, ArrowDownRight, ArrowUp, ArrowDown } from 'lucide-react';
import { useTicker } from '../hooks/useTicker';
import { tradingPairRegistry } from '../services/market/TradingPairRegistry';
import { useUserPreferences } from '../hooks/useUserPreferences';
import { safeParseFinancialNumber } from '../services/storageUtil';

type SortType = 'gainers' | 'losers' | 'volume' | 'price' | 'none';

export function Markets({ onNavigate }: { onNavigate: (tab: string, symbol?: string) => void }) {
  const [activeTab, setActiveTab] = useState<'favorites' | 'spot' | 'futures'>('futures');
  const [search, setSearch] = useState('');
  const [sortType, setSortType] = useState<SortType>('none');
  
  const tickers = useTicker();
  const { favorites, isFavorite, toggleFavorite } = useUserPreferences();

  const pairs = useMemo(() => {
    switch(activeTab) {
      case 'favorites': return tradingPairRegistry.getAllPairs().filter(p => favorites.includes(p.symbol));
      case 'spot': return tradingPairRegistry.getSpotPairs();
      case 'futures': return tradingPairRegistry.getFuturesPairs();
      default: return [];
    }
  }, [activeTab, favorites]);

  const filteredAndSortedPairs = useMemo(() => {
    let result = [...pairs];

    // Filter by search
    if (search.trim()) {
      const s = search.toLowerCase();
      result = result.filter(p => 
        p.symbol.toLowerCase().includes(s) || 
        p.baseAsset.toLowerCase().includes(s)
      );
    }

    // Merge with tickers
    let withTickers = result.map(p => ({
      pair: p,
      ticker: tickers.find(t => t.symbol === p.symbol)
    }));

    if (sortType === 'gainers') {
      withTickers.sort((a, b) => {
        const valA = safeParseFinancialNumber(a.ticker?.priceChangePercent, -999);
        const valB = safeParseFinancialNumber(b.ticker?.priceChangePercent, -999);
        return valB - valA;
      });
    } else if (sortType === 'losers') {
      withTickers.sort((a, b) => {
        const valA = safeParseFinancialNumber(a.ticker?.priceChangePercent, 999);
        const valB = safeParseFinancialNumber(b.ticker?.priceChangePercent, 999);
        return valA - valB;
      });
    } else if (sortType === 'volume') {
      withTickers.sort((a, b) => {
        const vA = safeParseFinancialNumber(a.ticker?.quoteVolume24h, -1);
        const vB = safeParseFinancialNumber(b.ticker?.quoteVolume24h, -1);
        return vB - vA;
      });
    } else if (sortType === 'price') {
      withTickers.sort((a, b) => {
        const pA = safeParseFinancialNumber(a.ticker?.lastPrice, -1);
        const pB = safeParseFinancialNumber(b.ticker?.lastPrice, -1);
        return pB - pA;
      });
    }

    return withTickers;
  }, [pairs, search, sortType, tickers]);

  return (
    <div className="pb-6 h-full flex flex-col bg-gray-950">
      {/* Header */}
      <div className="px-4 py-3 sticky top-0 bg-gray-950 z-30 border-b border-gray-900">
        <h1 className="text-xl font-bold text-white mb-4">Markets</h1>
        
        {/* Search */}
        <div className="relative mb-4">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Search size={16} className="text-gray-500" />
          </div>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="block w-full pl-10 pr-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm placeholder-gray-500 text-white focus:outline-none focus:border-blue-500 transition-colors"
            placeholder="Search coin pairs"
          />
        </div>

        {/* Categories */}
        <div className="flex gap-6 border-b border-gray-800 mb-2">
          <TabButton active={activeTab === 'favorites'} onClick={() => setActiveTab('favorites')}>
            <Star size={16} className={activeTab === 'favorites' ? 'fill-current' : ''} /> Favorites
          </TabButton>
          <TabButton active={activeTab === 'spot'} onClick={() => setActiveTab('spot')}>Spot</TabButton>
          <TabButton active={activeTab === 'futures'} onClick={() => setActiveTab('futures')}>Futures</TabButton>
        </div>

        {/* Sorting */}
        <div className="flex gap-2 overflow-x-auto scrollbar-hide py-2">
           <SortButton active={sortType === 'none'} onClick={() => setSortType('none')}>Default</SortButton>
           <SortButton active={sortType === 'gainers'} onClick={() => setSortType('gainers')} icon={<ArrowUpRight size={14}/>}>Gainers</SortButton>
           <SortButton active={sortType === 'losers'} onClick={() => setSortType('losers')} icon={<ArrowDownRight size={14}/>}>Losers</SortButton>
           <SortButton active={sortType === 'volume'} onClick={() => setSortType('volume')}>Volume</SortButton>
           <SortButton active={sortType === 'price'} onClick={() => setSortType('price')}>Price</SortButton>
        </div>
      </div>

      {/* Market List */}
      <div className="flex-1 overflow-auto px-4 mt-2">
        {/* Desktop Table Header */}
        <div className="hidden sm:flex text-xs font-medium text-gray-500 mb-2 px-1 border-b border-gray-800/50 pb-2">
          <div className="w-10">Fav</div>
          <div className="flex-1">Pair</div>
          <div className="w-24 text-right">Price</div>
          <div className="w-24 text-right">24h Chg</div>
          <div className="w-24 text-right">24h High</div>
          <div className="w-24 text-right">24h Low</div>
          <div className="w-28 text-right">24h Vol</div>
        </div>

        {/* Mobile List Header */}
        <div className="flex sm:hidden text-xs font-medium text-gray-500 mb-2 px-1 pb-2 border-b border-gray-800/50">
           <div className="flex-1">Pair / Vol</div>
           <div className="w-24 text-right">Price</div>
           <div className="w-20 text-right">24h Chg</div>
        </div>

        <div className="flex flex-col space-y-1">
          {filteredAndSortedPairs.length === 0 ? (
            <div className="py-12 flex flex-col items-center justify-center text-gray-500">
               <Search size={32} className="opacity-50 mb-2" />
               <p>No markets found</p>
            </div>
          ) : null}

          {filteredAndSortedPairs.map(({ pair, ticker }) => {
            const isFav = isFavorite(pair.symbol);
            const chg = safeParseFinancialNumber(ticker?.priceChangePercent);
            const isPositive = !isNaN(chg) && chg >= 0;
            const lastPriceNum = safeParseFinancialNumber(ticker?.lastPrice);
            const quoteVolNum = safeParseFinancialNumber(ticker?.quoteVolume24h);
            const high24hNum = safeParseFinancialNumber(ticker?.high24h);
            const low24hNum = safeParseFinancialNumber(ticker?.low24h);

            return (
              <div 
                key={pair.symbol} 
                className="flex items-center py-3 sm:py-2 border-b border-gray-800/30 hover:bg-gray-900/40 rounded-lg px-2 -mx-2 transition-colors cursor-pointer"
                onClick={() => {
                    // if it's futures, go to futures, if spot, go to spot
                    if (pair.marketType === 'FUTURES') {
                        onNavigate('futures', pair.symbol);
                    } else {
                        onNavigate('trade', pair.symbol); // old trade meant spot
                    }
                }}
              >
                {/* Mobile & Desktop Favorite Button */}
                <button 
                  onClick={(e) => { e.stopPropagation(); toggleFavorite(pair.symbol); }}
                  className="sm:w-10 p-1 mr-2 text-gray-600 hover:text-yellow-500 transition-colors"
                >
                  <Star size={16} className={isFav ? "fill-yellow-500 text-yellow-500" : ""} />
                </button>

                {/* Mobile View */}
                <div className="flex-1 sm:hidden">
                  <div className="flex items-baseline gap-1">
                    <span className="font-bold text-gray-100 text-sm">{pair.baseAsset}</span>
                    <span className="text-[10px] text-gray-500 font-medium">/{pair.quoteAsset}</span>
                    {pair.marketType === 'FUTURES' && <span className="text-[9px] bg-blue-500/10 text-blue-400 px-1 rounded ml-1">PERP</span>}
                  </div>
                  <div className="text-[10px] text-gray-500 mt-0.5">
                    Vol {!isNaN(quoteVolNum) ? (quoteVolNum / 1000000).toFixed(2) + 'M' : '--'}
                  </div>
                </div>

                <div className="w-24 text-right flex flex-col justify-center sm:hidden">
                  <div className={`font-bold text-sm ${isPositive ? 'text-emerald-500' : 'text-red-500'}`}>
                    {!isNaN(lastPriceNum) ? lastPriceNum.toLocaleString(undefined, { minimumFractionDigits: pair.quantityPrecision }) : '--'}
                  </div>
                </div>

                <div className="w-20 text-right flex justify-end items-center sm:hidden">
                  <div className={`px-2 py-1 rounded text-xs font-bold w-full flex items-center justify-center ${
                    isPositive ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500'
                  }`}>
                    {!isNaN(chg) ? `${isPositive ? '+' : ''}${chg.toFixed(2)}%` : '--'}
                  </div>
                </div>

                {/* Desktop View */}
                <div className="hidden sm:flex flex-1 items-center gap-2">
                    <span className="font-bold text-gray-100">{pair.baseAsset}/{pair.quoteAsset}</span>
                    {pair.marketType === 'FUTURES' && <span className="text-[9px] bg-blue-500/10 text-blue-400 px-1 rounded">PERP</span>}
                </div>
                
                <div className="hidden sm:flex w-24 justify-end font-medium text-gray-200">
                    {!isNaN(lastPriceNum) ? lastPriceNum.toLocaleString() : '--'}
                </div>

                <div className={`hidden sm:flex w-24 justify-end font-medium ${isPositive ? 'text-emerald-500' : 'text-red-500'}`}>
                    {!isNaN(chg) ? `${isPositive ? '+' : ''}${chg.toFixed(2)}%` : '--'}
                </div>

                <div className="hidden sm:flex w-24 justify-end text-sm text-gray-400">
                    {!isNaN(high24hNum) ? high24hNum.toLocaleString() : '--'}
                </div>

                <div className="hidden sm:flex w-24 justify-end text-sm text-gray-400">
                    {!isNaN(low24hNum) ? low24hNum.toLocaleString() : '--'}
                </div>

                <div className="hidden sm:flex w-28 justify-end text-sm text-gray-400">
                    {!isNaN(quoteVolNum) ? quoteVolNum.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '--'}
                </div>
              </div>
            );
          })}
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
        active ? 'border-blue-500 text-blue-500' : 'border-transparent text-gray-500 hover:text-gray-300'
      }`}
    >
      {children}
    </button>
  );
}

function SortButton({ active, onClick, children, icon }: { active: boolean, onClick: () => void, children: React.ReactNode, icon?: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors flex items-center gap-1 border ${
        active ? 'bg-gray-800 text-white border-gray-700' : 'bg-transparent text-gray-500 border-gray-800 hover:border-gray-700 hover:text-gray-300'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}
