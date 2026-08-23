import React, { useState, useMemo } from 'react';
import { Search, Star, Loader2, ArrowUpRight, ArrowDownRight, X, Sparkles, Filter } from 'lucide-react';
import { useTicker } from '../hooks/useTicker';
import { tradingPairRegistry } from '../services/market/TradingPairRegistry';
import { useUserPreferences } from '../hooks/useUserPreferences';
import { safeParseFinancialNumber } from '../services/storageUtil';
import { CoinAvatar } from '../components/ui/CoinAvatar';

type SortType = 'gainers' | 'losers' | 'volume' | 'price' | 'none';

export function Markets({ onNavigate }: { onNavigate: (tab: string, symbol?: string) => void }) {
  const [activeTab, setActiveTab] = useState<'favorites' | 'spot' | 'futures'>('futures');
  const [quoteFilter, setQuoteFilter] = useState<'ALL' | 'USDT' | 'USDC'>('ALL');
  const [sectorFilter, setSectorFilter] = useState<string>('ALL');
  const [search, setSearch] = useState('');
  const [sortType, setSortType] = useState<SortType>('none');
  
  const tickers = useTicker();
  const { favorites, isFavorite, toggleFavorite } = useUserPreferences();

  const pairs = useMemo(() => {
    let list = [];
    switch(activeTab) {
      case 'favorites': list = tradingPairRegistry.getAllPairs().filter(p => favorites.includes(p.symbol)); break;
      case 'spot': list = tradingPairRegistry.getSpotPairs(); break;
      case 'futures': list = tradingPairRegistry.getFuturesPairs(); break;
      default: list = [];
    }

    if (quoteFilter !== 'ALL') {
      list = list.filter(p => p.quoteAsset === quoteFilter);
    }

    return list;
  }, [activeTab, favorites, quoteFilter]);

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
      {/* Sticky Header */}
      <div className="px-4 py-3 sticky top-0 bg-gray-950/95 backdrop-blur-md z-30 border-b border-gray-800/80 space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-black text-white tracking-tight flex items-center gap-2">
            <span>Markets</span>
            <span className="text-xs font-mono font-bold px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
              {filteredAndSortedPairs.length} Pairs
            </span>
          </h1>
        </div>
        
        {/* Search Bar */}
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-500">
            <Search size={16} />
          </div>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="block w-full pl-9 pr-8 py-2.5 bg-gray-900/90 border border-gray-800 rounded-xl text-sm placeholder-gray-500 text-white focus:outline-none focus:border-cyan-500/80 focus:ring-1 focus:ring-cyan-500/30 transition-all font-medium"
            placeholder="Search coin pairs (e.g. BTC, ETH)"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-500 hover:text-white"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Primary Market Category Tabs */}
        <div className="flex gap-6 border-b border-gray-800/80">
          <TabButton active={activeTab === 'favorites'} onClick={() => setActiveTab('favorites')}>
            <Star size={15} className={activeTab === 'favorites' ? 'fill-amber-400 text-amber-400' : ''} /> Favorites
          </TabButton>
          <TabButton active={activeTab === 'spot'} onClick={() => setActiveTab('spot')}>Spot</TabButton>
          <TabButton active={activeTab === 'futures'} onClick={() => setActiveTab('futures')}>Futures</TabButton>
        </div>

        {/* Quote Asset Filter Pills & Sort Bar */}
        <div className="flex items-center justify-between gap-2 overflow-x-auto hide-scrollbar pt-1 pb-1">
          <div className="flex items-center gap-1 bg-gray-900/80 p-0.5 rounded-xl border border-gray-800 shrink-0">
            {(['ALL', 'USDT', 'USDC'] as const).map(q => (
              <button
                key={q}
                type="button"
                onClick={() => setQuoteFilter(q)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-extrabold transition-all ${
                  quoteFilter === q
                    ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 shadow-sm'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {q}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <SortButton active={sortType === 'none'} onClick={() => setSortType('none')}>Default</SortButton>
            <SortButton active={sortType === 'gainers'} onClick={() => setSortType('gainers')} icon={<ArrowUpRight size={13}/>}>Gainers</SortButton>
            <SortButton active={sortType === 'losers'} onClick={() => setSortType('losers')} icon={<ArrowDownRight size={13}/>}>Losers</SortButton>
            <SortButton active={sortType === 'volume'} onClick={() => setSortType('volume')}>Volume</SortButton>
            <SortButton active={sortType === 'price'} onClick={() => setSortType('price')}>Price</SortButton>
          </div>
        </div>
      </div>

      {/* Market List Body */}
      <div className="flex-1 overflow-auto px-4 mt-2">
        {/* Desktop Table Header */}
        <div className="hidden sm:flex text-xs font-bold text-gray-400 mb-2 px-2 border-b border-gray-800/60 pb-2 uppercase tracking-wider">
          <div className="w-8">Fav</div>
          <div className="flex-1">Pair / 24h Vol</div>
          <div className="w-28 text-right">Price</div>
          <div className="w-24 text-right">24h Chg</div>
          <div className="w-24 text-right">24h High</div>
          <div className="w-24 text-right">24h Low</div>
          <div className="w-28 text-right">24h Volume</div>
        </div>

        {/* Mobile List Header */}
        <div className="flex sm:hidden text-[11px] font-bold text-gray-400 mb-2 px-1 pb-2 border-b border-gray-800/60 uppercase tracking-wider">
          <div className="flex-1">Market Pair</div>
          <div className="w-24 text-right">Price</div>
          <div className="w-20 text-right">24h Change</div>
        </div>

        <div className="flex flex-col divide-y divide-gray-800/40">
          {filteredAndSortedPairs.length === 0 ? (
            <div className="py-16 flex flex-col items-center justify-center text-gray-500 gap-2">
              <Search size={32} className="opacity-40" />
              <p className="text-sm font-semibold">No trading pairs found</p>
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
                className="flex items-center py-3.5 sm:py-2.5 hover:bg-gray-900/60 rounded-xl px-2 -mx-2 transition-colors cursor-pointer group"
                onClick={() => {
                  if (pair.marketType === 'FUTURES') {
                    onNavigate('futures', pair.symbol);
                  } else {
                    onNavigate('trade', pair.symbol);
                  }
                }}
              >
                {/* Favorite Star Button */}
                <button 
                  type="button"
                  aria-label={`Favorite ${pair.symbol}`}
                  onClick={(e) => { e.stopPropagation(); toggleFavorite(pair.symbol); }}
                  className="p-1 mr-2 text-gray-600 hover:text-amber-400 transition-colors shrink-0"
                >
                  <Star size={16} className={isFav ? "fill-amber-400 text-amber-400" : ""} />
                </button>


                {/* Mobile Coin Presentation */}
                <div className="flex items-center gap-2.5 flex-1 sm:hidden">
                  <CoinAvatar symbol={pair.baseAsset} size="sm" />
                  <div>
                    <div className="flex items-baseline gap-1">
                      <span className="font-extrabold text-white text-sm">{pair.baseAsset}</span>
                      <span className="text-[10px] text-gray-400 font-bold">/{pair.quoteAsset}</span>
                      {pair.marketType === 'FUTURES' && (
                        <span className="text-[9px] bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 px-1 rounded font-black ml-0.5">
                          PERP
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-gray-400 font-mono">
                      Vol {!isNaN(quoteVolNum) ? '$' + (quoteVolNum / 1000000).toFixed(2) + 'M' : '--'}
                    </div>
                  </div>
                </div>

                {/* Mobile Price */}
                <div className="w-24 text-right flex flex-col justify-center sm:hidden">
                  <div className={`font-mono font-extrabold text-sm ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
                    {!isNaN(lastPriceNum) 
                      ? lastPriceNum.toLocaleString()
                      : '--'}
                  </div>
                </div>


                {/* Mobile Change Badge */}
                <div className="w-20 text-right flex justify-end items-center sm:hidden">
                  <div className={`px-2 py-1 rounded-lg text-xs font-mono font-black w-full flex items-center justify-center ${
                    isPositive ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20' : 'bg-red-500/15 text-red-400 border border-red-500/20'
                  }`}>
                    {!isNaN(chg) ? `${isPositive ? '+' : ''}${chg.toFixed(2)}%` : '--'}
                  </div>
                </div>

                {/* Desktop Row Presentation */}
                <div className="hidden sm:flex flex-1 items-center gap-3">
                  <CoinAvatar symbol={pair.baseAsset} size="sm" />
                  <div className="flex items-center gap-1.5">
                    <span className="font-extrabold text-white text-sm">{pair.baseAsset}/{pair.quoteAsset}</span>
                    {pair.marketType === 'FUTURES' && (
                      <span className="text-[9px] bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 px-1 rounded font-black">
                        PERP
                      </span>
                    )}
                  </div>
                </div>
                
                <div className="hidden sm:flex w-28 justify-end font-mono font-bold text-white text-sm">
                  {!isNaN(lastPriceNum) ? lastPriceNum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '--'}
                </div>

                <div className={`hidden sm:flex w-24 justify-end font-mono font-bold text-sm ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
                  {!isNaN(chg) ? `${isPositive ? '+' : ''}${chg.toFixed(2)}%` : '--'}
                </div>

                <div className="hidden sm:flex w-24 justify-end text-xs font-mono text-gray-400">
                  {!isNaN(high24hNum) ? high24hNum.toLocaleString() : '--'}
                </div>

                <div className="hidden sm:flex w-24 justify-end text-xs font-mono text-gray-400">
                  {!isNaN(low24hNum) ? low24hNum.toLocaleString() : '--'}
                </div>

                <div className="hidden sm:flex w-28 justify-end text-xs font-mono text-gray-400">
                  {!isNaN(quoteVolNum) ? '$' + (quoteVolNum / 1000000).toFixed(2) + 'M' : '--'}
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
      type="button"
      onClick={onClick}
      className={`pb-2.5 text-xs md:text-sm font-extrabold border-b-2 transition-all flex items-center gap-1.5 ${
        active 
          ? 'border-cyan-400 text-cyan-400 shadow-sm' 
          : 'border-transparent text-gray-400 hover:text-gray-200'
      }`}
    >
      {children}
    </button>
  );
}

function SortButton({ active, onClick, children, icon }: { active: boolean, onClick: () => void, children: React.ReactNode, icon?: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 rounded-lg text-xs font-bold whitespace-nowrap transition-all flex items-center gap-1 border ${
        active 
          ? 'bg-gray-800 text-white border-gray-700 shadow-sm' 
          : 'bg-gray-950 text-gray-400 border-gray-850 hover:border-gray-750 hover:text-gray-200'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}


