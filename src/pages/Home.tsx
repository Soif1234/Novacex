import React from 'react';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { useMarketData } from '../hooks/useMarketData';
import { useLedger } from '../hooks/useLedger';
import { useAuth } from '../contexts/AuthContext';
import { ArrowUpRight, ArrowDownRight, Gift, CreditCard, ArrowRightLeft, Landmark, Loader2 } from 'lucide-react';

export function Home({ onNavigate }: { onNavigate: (tab: string, symbol?: string) => void }) {
  const { user } = useAuth();
  const { data: markets, loading, isRefreshing, error, lastUpdated } = useMarketData();
  const { balances } = useLedger(user?.id || 'demo-user-1');

  const calculateValue = (asset: string, amountStr: string) => {
    if (asset === 'USDT') return Number(amountStr);
    const amount = Number(amountStr);
    const market = markets.find(m => m.baseAsset === asset);
    if (!market || !amount) return 0;
    return amount * market.price;
  };

  const totalBalanceUSDT = Object.entries(balances).reduce((total, [asset, amount]) => {
    return total + calculateValue(asset, amount);
  }, 0);

  return (
    <div className="pb-6">
      {/* Header Banner */}
      <div className="px-4 pt-2 pb-6">
        <h1 className="text-2xl font-bold text-white mb-1">Mallick Exchange</h1>
        <p className="text-gray-400 text-sm">Demo Trading Environment</p>
      </div>

      {/* Total Assets Overview */}
      <div className="px-4 mb-6">
        <div className="flex items-end gap-3 mb-1">
          <span className="text-3xl font-semibold text-white">
            ${totalBalanceUSDT.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
          <span className="text-emerald-500 text-sm font-medium flex items-center mb-1">
            +$0.00 (0.00%)
          </span>
        </div>
        <div className="text-gray-500 text-sm mb-4">Total Assets (Simulated)</div>
        
        <div className="flex gap-3">
          <Button variant="secondary" className="flex-1" onClick={() => onNavigate('assets')}>
            Deposit
          </Button>
          <Button variant="primary" className="flex-1" onClick={() => onNavigate('trade')}>
            Trade
          </Button>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-4 gap-4 px-4 mb-8">
        <ActionIcon icon={CreditCard} label="Buy Crypto" />
        <ActionIcon icon={ArrowRightLeft} label="Convert" onClick={() => onNavigate('trade')} />
        <ActionIcon icon={Landmark} label="Earn" />
        <ActionIcon icon={Gift} label="Rewards" />
      </div>

      {/* Promotional Banner */}
      <div className="px-4 mb-8">
        <Card className="bg-gradient-to-r from-blue-900/40 to-indigo-900/40 border-blue-800/50 p-4 flex items-center justify-between">
          <div>
            <h3 className="text-blue-400 font-semibold mb-1">Demo Challenge</h3>
            <p className="text-gray-300 text-sm">Trade $10k mock funds to win.</p>
          </div>
          <Button variant="primary" size="sm">Join Now</Button>
        </Card>
      </div>

      {/* Markets Preview */}
      <div className="px-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-white">Hot Markets</h2>
            {lastUpdated && (
              <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-gray-900 border border-gray-800">
                {isRefreshing && !loading && <Loader2 size={10} className="animate-spin text-gray-400" />}
                <span className="text-[10px] font-medium text-gray-500">
                  {lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              </div>
            )}
          </div>
          <button 
            onClick={() => onNavigate('markets')}
            className="text-gray-400 text-sm hover:text-white transition-colors"
          >
            View All
          </button>
        </div>
        
        <div className="flex flex-col gap-2">
          {loading ? (
            <div className="py-8 flex justify-center text-gray-500">
              <Loader2 className="animate-spin" size={24} />
            </div>
          ) : (
            <>
              {error && (
                <div className="py-4 text-center text-xs text-red-500 bg-red-500/10 rounded-lg mb-2">
                  Failed to load markets. Showing mock data.
                </div>
              )}
              {markets.slice(0, 5).map((market) => (
                <div key={market.id} className="flex items-center justify-between py-2.5 border-b border-gray-800/50 last:border-0 cursor-pointer hover:bg-gray-900/40 rounded-lg px-2 -mx-2 transition-colors" onClick={() => onNavigate('trade', market.baseAsset)}>
                  <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center font-bold text-xs text-gray-300">
                  {market.baseAsset.charAt(0)}
                </div>
                <div>
                  <div className="font-bold text-gray-100">{market.baseAsset}</div>
                  <div className="text-xs text-gray-500 font-medium">Vol {Math.floor(market.volume / 1000000)}M</div>
                </div>
              </div>
              <div className="text-right">
                <div className="font-bold text-white">${market.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</div>
                <div className={`text-xs flex items-center justify-end font-medium ${market.change24h >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                  {market.change24h >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
                  {Math.abs(market.change24h).toFixed(2)}%
                </div>
              </div>
            </div>
          ))}
          </>
        )}
        </div>
      </div>
    </div>
  );
}

function ActionIcon({ icon: Icon, label, onClick }: { icon: React.ElementType, label: string, onClick?: () => void }) {
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-2 group">
      <div className="w-12 h-12 rounded-2xl bg-gray-900 border border-gray-800 flex items-center justify-center text-gray-400 group-hover:text-blue-400 group-hover:border-blue-900 transition-all">
        <Icon size={22} />
      </div>
      <span className="text-xs text-gray-400 font-medium group-hover:text-gray-300 transition-colors">{label}</span>
    </button>
  );
}
