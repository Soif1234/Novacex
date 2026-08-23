import React, { useState } from 'react';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { CoinAvatar } from '../components/ui/CoinAvatar';
import { useMarketData } from '../hooks/useMarketData';
import { useTicker } from '../hooks/useTicker';
import { useLedger } from '../hooks/useLedger';
import { useAuth } from '../contexts/AuthContext';
import { 
  ArrowUpRight, ArrowDownRight, Eye, EyeOff, 
  CreditCard, ArrowRightLeft, Landmark, Gift, 
  TrendingUp, Shield, UserCheck, Flame, 
  Sparkles, ChevronRight, Zap, Loader2
} from 'lucide-react';

export function Home({ onNavigate }: { onNavigate: (tab: string, symbol?: string) => void }) {
  const { user } = useAuth();
  const { data: markets, loading, isRefreshing, error, lastUpdated } = useMarketData();
  const tickers = useTicker();
  const { balances } = useLedger(user?.id || 'demo-user-1');
  const [hideBalance, setHideBalance] = useState(false);
  const [marketTab, setMarketTab] = useState<'hot' | 'gainers' | 'losers' | 'volume'>('hot');

  const calculateValue = (asset: string, amountStr: string) => {
    if (asset === 'USDT' || asset === 'FUTURES_USDT') return Number(amountStr);
    const amount = Number(amountStr);
    const market = markets.find(m => m.baseAsset === asset);
    if (!market || !amount) return 0;
    return amount * market.price;
  };

  const totalBalanceUSDT = Object.entries(balances).reduce((total, [asset, amount]) => {
    return total + calculateValue(asset, amount);
  }, 0);

  // Market Intelligence filtering
  const displayedMarkets = React.useMemo(() => {
    if (!markets || markets.length === 0) return [];
    const list = [...markets];

    if (marketTab === 'gainers') {
      return list.sort((a, b) => b.change24h - a.change24h);
    } else if (marketTab === 'losers') {
      return list.sort((a, b) => a.change24h - b.change24h);
    } else if (marketTab === 'volume') {
      return list.sort((a, b) => b.volume - a.volume);
    }
    // hot / default
    return list.slice(0, 6);
  }, [markets, marketTab]);

  return (
    <div className="pb-8 space-y-5">
      {/* Ticker Marquee Bar */}
      <div className="px-4 pt-3">
        <div className="flex items-center gap-2 overflow-x-auto hide-scrollbar py-1">
          {markets.slice(0, 4).map(m => (
            <button
              key={m.id}
              onClick={() => onNavigate('trade', m.baseAsset)}
              className="flex items-center gap-2 px-3 py-1.5 bg-gray-900/80 hover:bg-gray-850 border border-gray-800/80 rounded-xl shrink-0 transition-colors cursor-pointer"
            >
              <span className="text-xs font-bold text-gray-300">{m.baseAsset}/USDT</span>
              <span className="text-xs font-mono font-bold text-white">${m.price >= 1 ? m.price.toFixed(2) : m.price.toFixed(4)}</span>
              <span className={`text-[10px] font-bold flex items-center ${m.change24h >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {m.change24h >= 0 ? '+' : ''}{m.change24h.toFixed(2)}%
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Portfolio Overview Card */}
      <div className="px-4">
        <div className="relative overflow-hidden bg-gradient-to-br from-gray-900 via-gray-900/90 to-gray-950 border border-gray-800/90 rounded-3xl p-5 shadow-xl shadow-black/40">
          <div className="absolute top-0 right-0 w-48 h-48 bg-cyan-500/5 rounded-full blur-3xl pointer-events-none" />
          <div className="absolute bottom-0 left-0 w-36 h-36 bg-blue-600/5 rounded-full blur-2xl pointer-events-none" />

          <div className="relative z-10">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">Total Net Worth</span>
                <button
                  type="button"
                  onClick={() => setHideBalance(!hideBalance)}
                  className="text-gray-500 hover:text-gray-300 transition-colors p-1"
                  aria-label="Toggle Balance Visibility"
                >
                  {hideBalance ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 flex items-center gap-1">
                <Zap size={10} /> Real-Time
              </span>
            </div>

            <div className="flex items-baseline gap-2 mb-1">
              <span className="text-3xl md:text-4xl font-black text-white font-mono tabular-nums tracking-tight">
                {hideBalance ? '••••••••' : `$${totalBalanceUSDT.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              </span>
              <span className="text-xs font-bold text-gray-400 font-mono">USDT</span>
            </div>

            <div className="flex items-center gap-2 text-xs mb-5">
              <span className="text-gray-400">Today's PNL:</span>
              <span className="text-emerald-400 font-bold font-mono">+$0.00 (+0.00%)</span>
            </div>

            {/* Quick Action Buttons */}
            <div className="grid grid-cols-3 gap-2.5">
              <Button 
                variant="primary" 
                size="sm" 
                className="rounded-xl font-black"
                onClick={() => onNavigate('assets')}
              >
                Deposit
              </Button>
              <Button 
                variant="secondary" 
                size="sm" 
                className="rounded-xl font-bold"
                onClick={() => onNavigate('trade')}
              >
                Spot Trade
              </Button>
              <Button 
                variant="nova" 
                size="sm" 
                className="rounded-xl font-bold"
                onClick={() => onNavigate('futures')}
              >
                Futures
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Quick Action Icon Grid */}
      <div className="px-4">
        <div className="bg-gray-900/60 border border-gray-800/80 rounded-2xl p-4 grid grid-cols-4 gap-y-4 gap-x-2">
          <ActionGridItem icon={CreditCard} label="Deposit" onClick={() => onNavigate('assets')} />
          <ActionGridItem icon={ArrowRightLeft} label="Transfer" onClick={() => onNavigate('assets')} />
          <ActionGridItem icon={TrendingUp} label="Futures" onClick={() => onNavigate('futures')} />
          <ActionGridItem icon={Landmark} label="Earn" onClick={() => onNavigate('assets')} />
          <ActionGridItem icon={UserCheck} label="KYC Tier" onClick={() => onNavigate('account')} />
          <ActionGridItem icon={Shield} label="Security" onClick={() => onNavigate('account')} />
          <ActionGridItem icon={Gift} label="Rewards" onClick={() => onNavigate('account')} />
          <ActionGridItem icon={Sparkles} label="Challenges" onClick={() => onNavigate('trade')} />
        </div>
      </div>

      {/* Promotional Card */}
      <div className="px-4">
        <div className="relative overflow-hidden bg-gradient-to-r from-blue-950/70 via-indigo-950/60 to-purple-950/70 border border-indigo-500/30 rounded-2xl p-4.5 flex items-center justify-between shadow-lg shadow-indigo-950/30">
          <div className="relative z-10 max-w-[70%]">
            <span className="text-[10px] font-black tracking-wider uppercase px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 inline-block mb-1.5">
              Trading Arena
            </span>
            <h3 className="text-sm font-extrabold text-white mb-0.5">Nova Futures Cup 2026</h3>
            <p className="text-xs text-gray-300 font-medium">Compete with paper capital for $50,000 in simulated prize pools.</p>
          </div>
          <Button 
            variant="primary" 
            size="sm" 
            className="shrink-0 font-extrabold text-xs"
            onClick={() => onNavigate('futures')}
          >
            Enter Now
          </Button>
        </div>
      </div>

      {/* Market Intelligence Section */}
      <div className="px-4">
        <div className="flex items-center justify-between mb-3 px-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-extrabold text-white tracking-tight flex items-center gap-1.5">
              <Flame size={18} className="text-cyan-400" /> Market Leaders
            </h2>
          </div>
          <button 
            type="button"
            onClick={() => onNavigate('markets')}
            className="text-xs font-bold text-cyan-400 hover:text-cyan-300 transition-colors flex items-center gap-0.5"
          >
            All Markets <ChevronRight size={14} />
          </button>
        </div>

        {/* Tab Strip */}
        <div className="flex items-center gap-1.5 bg-gray-950 p-1 border border-gray-800/80 rounded-xl mb-3">
          {(['hot', 'gainers', 'losers', 'volume'] as const).map(tab => (
            <button
              key={tab}
              type="button"
              onClick={() => setMarketTab(tab)}
              className={`flex-1 py-1.5 rounded-lg text-xs font-bold capitalize transition-all select-none cursor-pointer ${
                marketTab === tab
                  ? 'bg-gray-850 text-white shadow-sm border border-gray-700/60'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {tab === 'volume' ? '24h Vol' : tab}
            </button>
          ))}
        </div>

        {/* Market List */}
        <div className="bg-gray-900/60 border border-gray-800/80 rounded-2xl divide-y divide-gray-800/60 overflow-hidden">
          {loading ? (
            <div className="py-12 flex flex-col items-center justify-center text-gray-500 gap-2">
              <Loader2 className="animate-spin text-cyan-400" size={24} />
              <span className="text-xs font-medium">Fetching authoritative market data...</span>
            </div>
          ) : (
            displayedMarkets.map(m => (
              <div 
                key={m.id} 
                className="flex items-center justify-between p-3.5 hover:bg-gray-850/60 transition-colors cursor-pointer"
                onClick={() => onNavigate('trade', m.baseAsset)}
              >
                <div className="flex items-center gap-3">
                  <CoinAvatar symbol={m.baseAsset} size="md" />
                  <div>
                    <div className="font-extrabold text-sm text-white flex items-center gap-1.5">
                      <span>{m.baseAsset}</span>
                      <span className="text-[10px] text-gray-500 font-semibold">/ USDT</span>
                    </div>
                    <div className="text-[11px] text-gray-400 font-mono">
                      Vol ${(m.volume / 1000000).toFixed(1)}M
                    </div>
                  </div>
                </div>

                <div className="text-right">
                  <div className="font-bold text-sm text-white font-mono tabular-nums">
                    ${m.price >= 1 ? m.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : m.price.toFixed(4)}
                  </div>
                  <div className={`text-[11px] font-extrabold font-mono inline-flex items-center gap-0.5 ${
                    m.change24h >= 0 ? 'text-emerald-400' : 'text-red-400'
                  }`}>
                    {m.change24h >= 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                    {Math.abs(m.change24h).toFixed(2)}%
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function ActionGridItem({ icon: Icon, label, onClick }: { icon: React.ElementType, label: string, onClick?: () => void }) {
  return (
    <button 
      onClick={onClick} 
      className="flex flex-col items-center gap-1.5 group select-none cursor-pointer"
    >
      <div className="w-12 h-12 rounded-2xl bg-gray-950 border border-gray-800 flex items-center justify-center text-gray-400 group-hover:text-cyan-400 group-hover:border-cyan-500/40 group-hover:bg-gray-850 transition-all shadow-sm">
        <Icon size={20} />
      </div>
      <span className="text-[11px] text-gray-400 font-bold group-hover:text-gray-200 transition-colors tracking-tight">
        {label}
      </span>
    </button>
  );
}

