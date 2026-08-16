import React, { useState, useEffect } from 'react';
import { ShieldAlert, Users, Wallet, ListOrdered, ArrowRightLeft, TrendingUp, Bell, Server, ArrowLeft } from 'lucide-react';
import { demoLedger } from '../services/ledger';
import { orderService } from '../services/OrderService';
import { tradeService } from '../services/TradeService';
import { useMarketData } from '../hooks/useMarketData';
import { useAuth } from '../contexts/AuthContext';

export function Admin({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const { user } = useAuth();
  const accountId = user?.id || 'demo-account';
  const [activeTab, setActiveTab] = useState('system');

  const tabs = [
    { id: 'system', label: 'System', icon: Server },
    { id: 'users', label: 'Users', icon: Users },
    { id: 'balances', label: 'Balances', icon: Wallet },
    { id: 'orders', label: 'Orders', icon: ListOrdered },
    { id: 'trades', label: 'Trades', icon: ArrowRightLeft },
    { id: 'markets', label: 'Markets', icon: TrendingUp },
    { id: 'announcements', label: 'News', icon: Bell },
  ];

  return (
    <div className="flex flex-col h-full bg-gray-950">
      {/* Header */}
      <div className="px-4 py-3 flex items-center gap-3 border-b border-gray-900 bg-gray-950 sticky top-0 z-10">
        <button onClick={() => onNavigate('account')} className="text-gray-400 hover:text-white">
          <ArrowLeft size={20} />
        </button>
        <ShieldAlert size={20} className="text-amber-500" />
        <h1 className="text-lg font-bold text-white flex-1">Admin Dashboard</h1>
      </div>

      {/* Tabs */}
      <div className="flex overflow-x-auto hide-scrollbar border-b border-gray-900 bg-gray-950 sticky top-[53px] z-10">
        {tabs.map(tab => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 whitespace-nowrap px-4 py-3 text-sm font-bold transition-colors border-b-2 ${
                isActive ? 'border-amber-500 text-amber-500' : 'border-transparent text-gray-400 hover:text-gray-200'
              }`}
            >
              <Icon size={16} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'system' && <SystemStatus />}
        {activeTab === 'users' && <UsersAdmin />}
        {activeTab === 'balances' && <BalancesAdmin />}
        {activeTab === 'orders' && <OrdersAdmin />}
        {activeTab === 'trades' && <TradesAdmin />}
        {activeTab === 'markets' && <MarketsAdmin />}
        {activeTab === 'announcements' && <AnnouncementsAdmin />}
      </div>
    </div>
  );
}

function SystemStatus() {
  return (
    <div className="space-y-4">
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <h3 className="text-white font-bold mb-4 flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
          System Status
        </h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-gray-950 rounded p-3 border border-gray-800">
            <div className="text-gray-500 text-xs mb-1">Trading Engine</div>
            <div className="text-emerald-500 font-bold text-sm">Operational</div>
          </div>
          <div className="bg-gray-950 rounded p-3 border border-gray-800">
            <div className="text-gray-500 text-xs mb-1">Market Data</div>
            <div className="text-emerald-500 font-bold text-sm">Operational</div>
          </div>
          <div className="bg-gray-950 rounded p-3 border border-gray-800">
            <div className="text-gray-500 text-xs mb-1">Latency</div>
            <div className="text-white font-bold text-sm">24 ms</div>
          </div>
          <div className="bg-gray-950 rounded p-3 border border-gray-800">
            <div className="text-gray-500 text-xs mb-1">Uptime</div>
            <div className="text-white font-bold text-sm">99.99%</div>
          </div>
        </div>
      </div>
      <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-4 text-sm text-amber-500">
        <p className="font-bold mb-1">Demo Environment Note</p>
        <p className="text-amber-500/80 text-xs">All services are running locally in mock mode. No real connections to external exchanges.</p>
      </div>
    </div>
  );
}

function UsersAdmin() {
  const { user } = useAuth();
  
  return (
    <div className="space-y-4">
      <h3 className="text-white font-bold mb-2">Registered Users</h3>
      <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-950 border-b border-gray-800 text-gray-500">
            <tr>
              <th className="p-3 font-medium">ID</th>
              <th className="p-3 font-medium">Name</th>
              <th className="p-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800 text-gray-300">
            <tr>
              <td className="p-3 font-mono text-xs">{user?.id || 'sys-admin'}</td>
              <td className="p-3">{user?.name || 'Admin User'}</td>
              <td className="p-3"><span className="bg-emerald-500/10 text-emerald-500 px-2 py-1 rounded text-xs">Active</span></td>
            </tr>
            <tr>
              <td className="p-3 font-mono text-xs">demo-2</td>
              <td className="p-3">Test User 2</td>
              <td className="p-3"><span className="bg-gray-500/10 text-gray-500 px-2 py-1 rounded text-xs">Offline</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BalancesAdmin() {
  const [balances, setBalances] = useState<Record<string, string>>({});
  
  useEffect(() => {
    setBalances(demoLedger.getAllBalances());
    const unsub = demoLedger.subscribe(() => setBalances(demoLedger.getAllBalances()));
    return unsub;
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center mb-2">
        <h3 className="text-white font-bold">Global Ledger Balances</h3>
        <button onClick={() => demoLedger.reset()} className="text-xs bg-red-500/10 text-red-500 border border-red-500/20 px-2 py-1 rounded hover:bg-red-500/20">Reset All</button>
      </div>
      
      <div className="space-y-2">
        {Object.entries(balances).map(([asset, amount]) => (
          <div key={asset} className="bg-gray-900 border border-gray-800 rounded-lg p-3 flex justify-between items-center">
            <div className="font-bold text-white">{asset}</div>
            <div className="font-mono text-gray-300">{parseFloat(String(amount)).toLocaleString()}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function OrdersAdmin() {
  const { user } = useAuth();
  const accountId = user?.id || 'demo-account';
  const [pending, setPending] = useState(orderService.getPendingOrders());
  const [history, setHistory] = useState(orderService.getOrdersByAccount(accountId).filter(o => o.status !== 'PENDING'));
  
  useEffect(() => {
    const unsub = orderService.subscribe(() => {
      setPending(orderService.getPendingOrders());
      setHistory(orderService.getOrdersByAccount(accountId).filter(o => o.status !== 'PENDING'));
    });
    return unsub;
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-white font-bold mb-3 flex items-center gap-2">
          Pending Demo Orders <span className="bg-gray-800 text-gray-400 px-2 py-0.5 rounded-full text-xs">{pending.length}</span>
        </h3>
        {pending.length === 0 ? (
          <div className="text-gray-500 text-sm text-center py-4 bg-gray-900 rounded border border-gray-800">No pending orders</div>
        ) : (
          <div className="space-y-2">
            {pending.map(o => (
              <div key={o.id} className="bg-gray-900 border border-gray-800 rounded p-3 text-xs flex justify-between items-center">
                <div>
                  <div className="font-bold text-white mb-1">{o.symbol} <span className={o.side === 'BUY' ? 'text-emerald-500' : 'text-red-500'}>{o.side} {o.type}</span></div>
                  <div className="text-gray-500">Price: {o.price} | Qty: {o.amount}</div>
                </div>
                <div className="text-amber-500">{o.status}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="text-white font-bold mb-3 flex items-center gap-2">
          Order History <span className="bg-gray-800 text-gray-400 px-2 py-0.5 rounded-full text-xs">{history.length}</span>
        </h3>
        {history.length === 0 ? (
          <div className="text-gray-500 text-sm text-center py-4 bg-gray-900 rounded border border-gray-800">No history</div>
        ) : (
          <div className="space-y-2">
            {history.slice(0, 10).map(o => (
              <div key={o.id} className="bg-gray-900 border border-gray-800 rounded p-3 text-xs flex justify-between items-center">
                <div>
                  <div className="font-bold text-white mb-1">{o.symbol} <span className={o.side === 'BUY' ? 'text-emerald-500' : 'text-red-500'}>{o.side} {o.type}</span></div>
                  <div className="text-gray-500">Qty: {o.amount}</div>
                </div>
                <div className={o.status === 'FILLED' ? 'text-emerald-500' : 'text-gray-500'}>{o.status}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TradesAdmin() {
  const { user } = useAuth();
  const accountId = user?.id || 'demo-account';
  const [trades, setTrades] = useState(tradeService.getTradesByAccount(accountId));
  
  useEffect(() => {
    const unsub = tradeService.subscribe(() => {
      setTrades(tradeService.getTradesByAccount(accountId));
    });
    return unsub;
  }, []);

  return (
    <div className="space-y-4">
      <h3 className="text-white font-bold mb-2">Executed Trades (System-wide)</h3>
      {trades.length === 0 ? (
        <div className="text-gray-500 text-sm text-center py-8 bg-gray-900 rounded border border-gray-800">No trades executed yet</div>
      ) : (
        <div className="space-y-2">
          {trades.map(t => (
            <div key={t.id} className="bg-gray-900 border border-gray-800 rounded p-3 text-xs">
              <div className="flex justify-between items-center mb-1">
                <span className="font-bold text-white">{t.symbol}</span>
                <span className="text-gray-500">{new Date(t.timestamp).toLocaleTimeString()}</span>
              </div>
              <div className="flex justify-between items-center text-gray-400">
                <span><span className={t.side === 'BUY' ? 'text-emerald-500' : 'text-red-500'}>{t.side}</span> {t.amount}</span>
                <span>@ {t.price}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MarketsAdmin() {
  const { data: markets, loading, error } = useMarketData();

  if (loading) return <div className="text-gray-500 text-center py-8">Loading markets...</div>;
  if (error) return <div className="text-red-500 text-center py-8">{error}</div>;

  return (
    <div className="space-y-4">
      <h3 className="text-white font-bold mb-2">Market Data Feed</h3>
      <div className="space-y-2">
        {markets.map((m: any) => {
          const isPositive = Number(m.change24h) >= 0;
          return (
            <div key={m.id} className="bg-gray-900 border border-gray-800 rounded p-3 flex justify-between items-center">
              <div>
                <div className="font-bold text-white">{m.baseAsset}/{m.quoteAsset}</div>
                <div className="text-xs text-gray-500">Vol: {Number(m.volume).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
              </div>
              <div className="text-right">
                <div className="font-mono text-white">{m.priceStr}</div>
                <div className={`text-xs ${isPositive ? 'text-emerald-500' : 'text-red-500'}`}>
                  {isPositive ? '+' : ''}{m.change24h}%
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AnnouncementsAdmin() {
  const announcements = [
    { id: 1, title: 'System Maintenance Scheduled', date: '2026-08-15', status: 'Draft' },
    { id: 2, title: 'New Trading Pairs Added', date: '2026-08-10', status: 'Published' },
    { id: 3, title: 'Zero Fee Trading Promotion', date: '2026-08-01', status: 'Published' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center mb-2">
        <h3 className="text-white font-bold">Announcements</h3>
        <button className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 font-bold">New Post</button>
      </div>
      <div className="space-y-2">
        {announcements.map(a => (
          <div key={a.id} className="bg-gray-900 border border-gray-800 rounded p-3">
            <div className="flex justify-between items-start mb-2">
              <div className="font-bold text-white text-sm">{a.title}</div>
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${a.status === 'Published' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'}`}>
                {a.status}
              </span>
            </div>
            <div className="text-xs text-gray-500">{a.date}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
