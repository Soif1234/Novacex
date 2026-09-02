import { Decimal } from 'decimal.js';
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
  Sparkles, ChevronRight, Zap, Loader2, ArrowDownToLine, Users
} from 'lucide-react';

export function Home({ onNavigate }: { onNavigate: (tab: string, symbol?: string) => void }) {
  const { user } = useAuth();
  const { data: markets, loading, isRefreshing, error, lastUpdated } = useMarketData();
  const tickers = useTicker();
  const { balances } = useLedger();
  const [hideBalance, setHideBalance] = useState(false);
  const [marketTab, setMarketTab] = useState<'hot' | 'gainers' | 'losers' | 'volume'>('hot');

  const calculateValue = (asset: string, amountStr: string): Decimal => {
    if (asset === 'USDT' || asset === 'FUTURES_USDT') return new Decimal(amountStr || '0');
    const amount = new Decimal(amountStr || '0');
    const market = markets.find(m => m.baseAsset === asset);
    if (!market || amount.isZero()) return new Decimal(0);
    return amount.mul(market.price);
  };

  const totalBalanceUSDT = Object.entries(balances).reduce((total: Decimal, [asset, amount]) => {
    return total.plus(calculateValue(asset, amount as string));
  }, new Decimal(0));

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
    return list.slice(0, 6);
  }, [markets, marketTab]);

  return (
    <div className="flex flex-col gap-6 pb-24 max-w-lg mx-auto overflow-hidden hide-scrollbar bg-brand-bg pt-4">
      {/* Balance Hero */}
      <div className="px-4">
        <div className="bg-brand-surface border border-brand-border rounded-2xl p-5 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold tracking-wide text-gray-400">Total Balance</span>
            <button
              onClick={() => setHideBalance(!hideBalance)}
              aria-label="Toggle Balance Visibility"
              className="text-gray-500 hover:text-gray-300 transition-colors cursor-pointer"
            >
              {hideBalance ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <div className="mb-3">
            <div className="flex items-baseline gap-1.5 tabular-nums">
              <span className="text-3xl font-bold text-gray-100 tabular-nums">
                {hideBalance ? '********' : `$${totalBalanceUSDT.toNumber().toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              </span>
              <span className="text-sm font-bold text-gray-500 tabular-nums">USDT</span>
            </div>
            <div className="flex items-center gap-1.5 mt-1.5 tabular-nums text-[13px]">
              <span className="text-brand-lime font-bold tabular-nums">+$0.00</span>
              <span className="text-brand-lime/80 font-medium tabular-nums">(+0.00%)</span>
              <span className="text-gray-500 font-medium ml-1 text-xs">Today</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 mt-5">
            <Button variant="primary" onClick={() => onNavigate('assets')}>
              Deposit
            </Button>
            <Button variant="secondary" onClick={() => onNavigate('trade')}>
              Trade
            </Button>
          </div>
        </div>
      </div>

      {/* 5-Icon Quick Actions */}
      <div className="px-4">
        <div className="grid grid-cols-5 gap-2">
          <ActionGridItem icon={ArrowDownToLine} label="Deposit" onClick={() => onNavigate('assets')} />
          <ActionGridItem icon={ArrowRightLeft} label="Transfer" onClick={() => onNavigate('assets')} />
          <ActionGridItem icon={TrendingUp} label="Futures" onClick={() => onNavigate('futures')} />
          <ActionGridItem icon={Users} label="P2P" onClick={() => onNavigate('trade')} />
          <ActionGridItem icon={Gift} label="Earn" onClick={() => onNavigate('assets')} />
        </div>
      </div>

      {/* Card Banner */}
      <div className="px-4">
        <div className="bg-brand-surface border border-brand-border rounded-2xl p-5 flex items-center justify-between">
          <div className="max-w-[70%]">
            <span className="text-[10px] font-bold tracking-wider uppercase px-2 py-0.5 rounded bg-brand-lime/10 text-brand-lime inline-block mb-2">
              New Listing
            </span>
            <h3 className="text-sm font-bold text-white mb-1">Trade Hyperliquid</h3>
            <p className="text-xs text-gray-400">0 fee trading for 7 days.</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => onNavigate('trade')}>
            Trade
          </Button>
        </div>
      </div>

      {/* Market List */}
      <div className="px-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-bold text-white">Markets</h2>
          <button
            type="button"
            onClick={() => onNavigate('markets')}
            className="text-xs font-bold text-brand-lime hover:text-brand-lime/80 transition-colors flex items-center cursor-pointer"
          >
            All Markets <ChevronRight size={14} className="ml-1" />
          </button>
        </div>

        <div className="flex items-center gap-2 mb-4">
          {(['hot', 'gainers', 'losers', 'volume'] as const).map(tab => (
            <button
              key={tab}
              type="button"
              onClick={() => setMarketTab(tab)}
              className={`px-4 py-1.5 rounded-[16px] text-xs font-bold capitalize transition-colors cursor-pointer ${
                marketTab === tab
                  ? 'bg-brand-surface border border-brand-border text-white'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {tab === 'volume' ? 'Volume' : tab}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-1">
          {loading ? (
            <div className="py-12 flex flex-col items-center justify-center text-gray-500 gap-2">
              <Loader2 className="animate-spin text-brand-lime" size={24} />
            </div>
          ) : (
            displayedMarkets.map(m => {
              const isPositive = new Decimal(m.change24h).gte(0);
              return (
                <div
                  key={m.id}
                  className="flex items-center justify-between p-3 rounded-xl hover:bg-brand-surface/50 transition-colors cursor-pointer"
                  onClick={() => onNavigate('trade', m.baseAsset)}
                >
                  <div className="flex items-center gap-3">
                    <CoinAvatar symbol={m.baseAsset} size="md" />
                    <div>
                      <div className="font-bold text-sm text-gray-100">
                        {m.baseAsset}
                      </div>
                      <div className="text-[11px] text-gray-500 tabular-nums">
                        Vol ${(m.volume / 1000000).toFixed(1)}M
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <div className="font-bold text-[13px] text-gray-100 tabular-nums">
                      ${m.price >= 1 ? m.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : m.price.toFixed(4)}
                    </div>
                    <div className={`flex items-center justify-center min-w-[70px] h-8 rounded-lg text-xs font-bold tabular-nums text-white ${
                      isPositive ? 'bg-brand-green' : 'bg-brand-red'
                    }`}>
                      {isPositive ? '+' : ''}{new Decimal(m.change24h).toFixed(2)}%
                    </div>
                  </div>
                </div>
              );
            })
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
      className="flex flex-col items-center gap-2 group cursor-pointer"
    >
      <div className="w-12 h-12 rounded-[14px] bg-brand-surface border border-brand-border flex items-center justify-center text-gray-400 group-hover:text-brand-lime transition-colors">
        <Icon size={20} />
      </div>
      <span className="text-[10px] text-gray-400 font-medium group-hover:text-gray-200">
        {label}
      </span>
    </button>
  );
}
