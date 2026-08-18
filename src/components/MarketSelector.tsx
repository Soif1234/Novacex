import React, { useState, useMemo } from 'react';
import { Search, X, Star, ChevronDown } from 'lucide-react';
import { tradingPairRegistry, TradingPair } from '../services/market/TradingPairRegistry';
import { useUserPreferences } from '../hooks/useUserPreferences';
import { useTicker } from '../hooks/useTicker';

interface MarketSelectorProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (symbol: string) => void;
}

type TabType = 'Favorites' | 'Spot' | 'Futures';

export function MarketSelector({ isOpen, onClose, onSelect }: MarketSelectorProps) {
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<TabType>('Futures');
  const [activeCategory, setActiveCategory] = useState<string>('All');
  
  const { favorites, isFavorite, toggleFavorite, addRecentPair } = useUserPreferences();
  const tickers = useTicker() as any[];

  const handleSelect = (symbol: string) => {
    addRecentPair(symbol);
    onSelect(symbol);
    onClose();
  };

  const getPairsForTab = (): TradingPair[] => {
    switch (activeTab) {
      case 'Favorites':
        return tradingPairRegistry.getAllPairs().filter(p => favorites.includes(p.symbol));
      case 'Spot':
        return tradingPairRegistry.getSpotPairs();
      case 'Futures':
        return tradingPairRegistry.getFuturesPairs();
      default:
        return [];
    }
  };

  const allCategories = useMemo(() => {
    const pairs = getPairsForTab();
    const catSet = new Set<string>();
    pairs.forEach(p => p.categories?.forEach(c => catSet.add(c)));
    return ['All', ...Array.from(catSet)];
  }, [activeTab, favorites]);

  React.useEffect(() => {
    if (!allCategories.includes(activeCategory)) {
      setActiveCategory('All');
    }
  }, [allCategories, activeCategory]);

  const filteredPairs = useMemo(() => {
    let pairs = getPairsForTab();
    if (activeCategory !== 'All') {
      pairs = pairs.filter(p => p.categories?.includes(activeCategory));
    }
    if (search) {
      const s = search.toLowerCase();
      pairs = pairs.filter(p => 
        p.symbol.toLowerCase().includes(s) || 
        p.baseAsset.toLowerCase().includes(s) || 
        p.quoteAsset.toLowerCase().includes(s)
      );
    }
    return pairs;
  }, [activeTab, activeCategory, search, favorites]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] bg-gray-950 flex flex-col sm:p-4 animate-in fade-in duration-200">
      <div className="flex-1 bg-gray-950 sm:bg-gray-900 sm:rounded-xl sm:border sm:border-gray-800 flex flex-col overflow-hidden max-w-md w-full mx-auto sm:shadow-2xl sm:max-h-[85vh]">
        
        {/* Header */}
        <div className="flex items-center px-4 pt-6 pb-4 sm:pt-4 border-b border-gray-800 shrink-0">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={18} />
            <input
              type="text"
              placeholder="Search pairs..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-gray-800/50 text-white pl-10 pr-4 py-2.5 rounded-xl border border-gray-700/50 focus:border-blue-500 focus:outline-none placeholder-gray-500 text-sm"
              aria-label="Search pairs"
            />
          </div>
          <button 
            onClick={onClose}
            className="ml-4 p-2 -mr-2 text-gray-400 hover:text-white transition-colors"
            aria-label="Close market selector"
          >
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex px-4 border-b border-gray-800 shrink-0">
          {(['Favorites', 'Spot', 'Futures'] as TabType[]).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab 
                  ? 'border-blue-500 text-blue-500' 
                  : 'border-transparent text-gray-400 hover:text-gray-300'
              }`}
            >
              {tab === 'Favorites' ? <Star size={14} className="inline mr-1 mb-0.5" /> : null}
              {tab}
            </button>
          ))}
        </div>

        {/* Categories */}
        {allCategories.length > 1 && (
          <div className="flex overflow-x-auto px-4 py-3 gap-2 border-b border-gray-800/50 shrink-0 scrollbar-hide">
            {allCategories.map(cat => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                  activeCategory === cat 
                    ? 'bg-gray-800 text-white' 
                    : 'bg-transparent text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        )}

        {/* List */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-2">
          {filteredPairs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-gray-500 space-y-2">
              <Search size={24} className="opacity-50" />
              <p className="text-sm">No markets found</p>
            </div>
          ) : (
            <div className="space-y-1">
              {filteredPairs.map(pair => {
                const isFav = isFavorite(pair.symbol);
                const ticker = tickers.find(t => t.symbol === pair.symbol);
                
                // Fallbacks if data missing or NaN
                const price = ticker?.lastPrice ? parseFloat(ticker.lastPrice).toLocaleString(undefined, { minimumFractionDigits: pair.quantityPrecision }) : '--';
                let changeStr = '--';
                let changeColor = 'text-gray-500';
                
                if (ticker?.priceChangePercent) {
                  const chg = parseFloat(ticker.priceChangePercent);
                  if (!isNaN(chg)) {
                    changeStr = `${chg > 0 ? '+' : ''}${chg.toFixed(2)}%`;
                    changeColor = chg > 0 ? 'text-green-500' : chg < 0 ? 'text-red-500' : 'text-gray-400';
                  }
                }

                return (
                  <div 
                    key={pair.symbol} 
                    className="flex items-center justify-between p-3 rounded-xl hover:bg-gray-800/50 cursor-pointer group transition-colors"
                    onClick={() => handleSelect(pair.symbol)}
                  >
                    <div className="flex items-center gap-3">
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavorite(pair.symbol);
                        }}
                        className="p-1 -ml-1 text-gray-600 hover:text-yellow-500 focus:outline-none"
                        aria-label={isFav ? `Remove ${pair.symbol} from favorites` : `Add ${pair.symbol} to favorites`}
                      >
                        <Star size={18} className={isFav ? "fill-yellow-500 text-yellow-500" : "group-hover:text-yellow-500/50"} />
                      </button>
                      <div>
                        <div className="flex items-baseline gap-1">
                          <span className="font-bold text-gray-100">{pair.baseAsset}</span>
                          <span className="text-xs text-gray-500">/{pair.quoteAsset}</span>
                        </div>
                        {pair.marketType === 'FUTURES' && (
                          <span className="text-[10px] bg-blue-500/10 text-blue-400 px-1.5 py-0.5 rounded leading-none">PERP</span>
                        )}
                      </div>
                    </div>
                    
                    <div className="text-right">
                      <div className="font-medium text-gray-100">{price}</div>
                      <div className={`text-xs ${changeColor}`}>{changeStr}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
