import React, { useState, useMemo } from 'react';
import { 
  Eye, Clock, Download, Upload, ArrowRightLeft, CreditCard, X, 
  ArrowUpRight, ArrowDownRight, Filter, FileText, CheckCircle2, AlertCircle
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useWallet } from '../hooks/useWallet';
import { useTransactionHistory } from '../hooks/useTransactionHistory';
import { 
  Asset, internalTransferService, WalletType, demoTransactionService
} from '../services/wallet';
import { TransactionType, Transaction } from '../services/transactions';

import { ErrorBoundary } from '../components/ErrorBoundary';

const ASSET_DETAILS: Record<string, { name: string, color: string }> = {
  USDT: { name: 'Tether US', color: 'bg-[#26A17B]' },
  BTC: { name: 'Bitcoin', color: 'bg-[#F7931A]' },
  ETH: { name: 'Ethereum', color: 'bg-[#627EEA]' },
  SOL: { name: 'Solana', color: 'bg-[#14F195] text-gray-950' },
  XRP: { name: 'Ripple', color: 'bg-[#23292F]' },
  DOGE: { name: 'Dogecoin', color: 'bg-[#C2A633]' }
};

export function Assets() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<'overview' | 'spot' | 'futures' | 'history'>('overview');
  const [showTransfer, setShowTransfer] = useState(false);
  const [showDeposit, setShowDeposit] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);
  
  const { assets, balances, isLoading } = useWallet(user?.id || 'demo-user-1');

  if (isLoading || !balances) {
    return (
      <div className="flex items-center justify-center min-h-screen text-gray-500">
        Loading wallet...
      </div>
    );
  }

  const renderOverview = () => {
    return (
      <div className="flex flex-col gap-3 mt-4">
        <div className="text-gray-400 font-bold px-2 text-xs uppercase tracking-wider">All Assets</div>
        {assets.map((asset) => {
          const details = ASSET_DETAILS[asset.asset === 'FUTURES_USDT' ? 'USDT' : asset.asset] || { name: asset.asset, color: 'bg-gray-700' };
          return (
            <React.Fragment key={asset.asset}>
              <AssetRow asset={asset} details={details} showLocked={true} />
            </React.Fragment>
          );
        })}
        {assets.length === 0 && (
          <div className="text-center text-gray-500 py-8">No assets in wallet</div>
        )}
      </div>
    );
  };

  const renderSpot = () => {
    return (
      <div className="flex flex-col gap-3 mt-4">
        <div className="text-gray-400 font-bold px-2 text-xs uppercase tracking-wider">Spot Wallet</div>
        {assets.map((asset) => {
          const details = ASSET_DETAILS[asset.asset === 'FUTURES_USDT' ? 'USDT' : asset.asset] || { name: asset.asset, color: 'bg-gray-700' };
          return (
            <React.Fragment key={asset.asset}>
              <AssetRow asset={asset} details={details} />
            </React.Fragment>
          );
        })}
        {assets.length === 0 && (
          <div className="text-center text-gray-500 py-8">No assets in spot wallet</div>
        )}
      </div>
    );
  };

  const renderFutures = () => {
    return (
      <div className="flex flex-col gap-3 mt-4">
        <div className="text-gray-400 font-bold px-2 text-xs uppercase tracking-wider">Futures Wallet</div>
        <div className="bg-gray-900/40 p-4 rounded-xl border border-gray-800">
          <div className="flex justify-between items-center mb-4">
            <span className="text-gray-400">Total Futures Balance</span>
            <span className="text-white font-bold">{Number(balances.futuresTotal).toFixed(2)} USDT</span>
          </div>
          <div className="flex justify-between items-center mb-2">
            <span className="text-gray-500 text-sm">Available Margin</span>
            <span className="text-gray-300 text-sm">{Number(balances.futuresAvailable).toFixed(2)} USDT</span>
          </div>
          <div className="flex justify-between items-center mb-2">
            <span className="text-gray-500 text-sm">Locked Margin</span>
            <span className="text-gray-300 text-sm">{Number(balances.futuresLocked).toFixed(2)} USDT</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-gray-500 text-sm">Unrealized PNL</span>
            <span className={`text-sm font-medium ${Number(balances.unrealizedPnl) >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
              {Number(balances.unrealizedPnl) >= 0 ? '+' : ''}{Number(balances.unrealizedPnl).toFixed(2)} USDT
            </span>
          </div>
        </div>
      </div>
    );
  };

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
            {Number(balances.total).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
        
        <div className="flex gap-2 mt-6">
          <ActionButton icon={Download} label="Deposit" onClick={() => setShowDeposit(true)} />
          <ActionButton icon={Upload} label="Withdraw" onClick={() => setShowWithdraw(true)} />
          <ActionButton icon={ArrowRightLeft} label="Transfer" onClick={() => setShowTransfer(true)} />
          <ActionButton icon={CreditCard} label="Buy" disabled />
        </div>
      </div>

      <div className="px-4 mt-6">
        {/* Tabs */}
        <div className="flex gap-6 border-b border-gray-800 mb-4 overflow-x-auto hide-scrollbar">
          <Tab active={activeTab === 'overview'} onClick={() => setActiveTab('overview')}>Overview</Tab>
          <Tab active={activeTab === 'spot'} onClick={() => setActiveTab('spot')}>Spot</Tab>
          <Tab active={activeTab === 'futures'} onClick={() => setActiveTab('futures')}>Futures</Tab>
          <Tab active={activeTab === 'history'} onClick={() => setActiveTab('history')}>History</Tab>
        </div>

        {activeTab === 'overview' && renderOverview()}
        {activeTab === 'spot' && renderSpot()}
        {activeTab === 'futures' && renderFutures()}
        {activeTab === 'history' && (
          <ErrorBoundary fallback={<div className="text-gray-500 text-center py-4">Transaction history unavailable.</div>}>
            <HistoryTab />
          </ErrorBoundary>
        )}

        {showTransfer && <TransferModal onClose={() => setShowTransfer(false)} balances={balances} />}
        {showDeposit && <DepositModal onClose={() => setShowDeposit(false)} userId={user?.id || "demo-user-1"} />}
        {showWithdraw && <WithdrawModal onClose={() => setShowWithdraw(false)} balances={balances} assets={assets} userId={user?.id || "demo-user-1"} />}
      </div>
    </div>
  );
}

function HistoryTab() {
  const { user } = useAuth();
  const { transactions: entries } = useTransactionHistory(user?.id || 'demo-user-1');
  const [walletFilter, setWalletFilter] = useState<string>('ALL');
  const [typeFilter, setTypeFilter] = useState<string>('ALL');
  const [assetFilter, setAssetFilter] = useState<string>('ALL');
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);

  const assetsList = useMemo(() => {
    return Array.from(new Set(entries.map(e => e.asset)));
  }, [entries]);

  const filteredEntries = useMemo(() => {
    return entries.filter(e => {
      if (walletFilter !== 'ALL' && e.wallet !== walletFilter) return false;
      if (typeFilter !== 'ALL' && e.type !== typeFilter) return false;
      if (assetFilter !== 'ALL' && e.asset !== assetFilter) return false;
      return true;
    });
  }, [entries, walletFilter, typeFilter, assetFilter]);

  return (
    <div className="flex flex-col gap-4 mt-2">
      {/* Filters */}
      <div className="flex flex-col gap-2 bg-gray-900/40 p-3 rounded-xl border border-gray-800">
        <div className="flex items-center gap-2 text-xs font-bold text-gray-400 mb-1">
          <Filter size={14} /> Filter History
        </div>
        <div className="grid grid-cols-3 gap-2">
          {/* Wallet */}
          <div>
            <label className="text-[10px] text-gray-500 font-medium block mb-1">Wallet</label>
            <select
              value={walletFilter}
              onChange={(e) => setWalletFilter(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 text-xs rounded-lg py-1.5 px-2 text-white outline-none"
            >
              <option value="ALL">All Wallets</option>
              <option value="SPOT">Spot</option>
              <option value="FUTURES">Futures</option>
            </select>
          </div>

          {/* Type */}
          <div>
            <label className="text-[10px] text-gray-500 font-medium block mb-1">Type</label>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 text-xs rounded-lg py-1.5 px-2 text-white outline-none"
            >
              <option value="ALL">All Types</option>
              <option value="DEPOSIT">Deposit</option>
              <option value="WITHDRAWAL">Withdrawal</option>
              <option value="TRANSFER">Transfer</option>
              <option value="REALIZED_PNL">Realized PNL</option>
              <option value="TRADING_FEE">Trading Fee</option>
              <option value="FUNDING">Funding</option>
              <option value="MARGIN">Margin</option>
              <option value="OTHER">Other</option>
            </select>
          </div>

          {/* Asset */}
          <div>
            <label className="text-[10px] text-gray-500 font-medium block mb-1">Asset</label>
            <select
              value={assetFilter}
              onChange={(e) => setAssetFilter(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 text-xs rounded-lg py-1.5 px-2 text-white outline-none"
            >
              <option value="ALL">All Assets</option>
              {assetsList.map(a => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Entries List */}
      <div className="flex flex-col gap-2.5">
        {filteredEntries.map((entry) => (
          <HistoryRow key={entry.id} entry={entry} onClick={() => setSelectedTx(entry)} />
        ))}
        {filteredEntries.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center bg-gray-900/20 rounded-xl border border-gray-800/40">
            <FileText size={32} className="text-gray-600 mb-2" />
            <span className="text-gray-400 font-medium text-sm">No transaction records found</span>
            <span className="text-gray-600 text-xs mt-1">Transactions and ledger updates will appear here</span>
          </div>
        )}
      </div>
      {selectedTx && <TransactionDetailModal tx={selectedTx} onClose={() => setSelectedTx(null)} />}
    </div>
  );
}

function HistoryRow({ entry, onClick }: { entry: Transaction; key?: React.Key; onClick?: () => void }) {
  const isCredit = entry.direction === 'CREDIT';
  
  const typeBadgeColors: Record<TransactionType, string> = {
    DEPOSIT: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    WITHDRAWAL: 'bg-red-500/10 text-red-400 border-red-500/20',
    TRANSFER: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    REALIZED_PNL: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
    TRADING_FEE: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    FUNDING: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
    MARGIN: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20',
    OTHER: 'bg-gray-500/10 text-gray-400 border-gray-500/20'
  };

  let dateStr = 'Unknown date';
  try {
    const d = new Date(entry.createdAt);
    if (!isNaN(d.getTime())) {
      dateStr = d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    }
  } catch (e) {
    // Ignore date parsing errors
  }

  const safeAmount = (entry.amount && entry.amount !== 'NaN') ? entry.amount : '0';

  return (
    <div 
      className="p-3 bg-gray-900/40 border border-gray-800/60 rounded-xl flex flex-col gap-2 hover:border-gray-700 hover:bg-gray-800/40 transition-colors cursor-pointer"
      onClick={onClick}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${typeBadgeColors[entry.type] || typeBadgeColors.OTHER}`}>
            {entry.type.replace('_', ' ')}
          </span>
          <span className="text-[10px] font-medium bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded">
            {entry.wallet}
          </span>
        </div>
        <div className={`font-bold text-sm ${isCredit ? 'text-emerald-400' : 'text-red-400'}`}>
          {isCredit ? '+' : '-'}{safeAmount} {entry.asset}
        </div>
      </div>

      <div className="flex justify-between items-center text-xs">
        <span className="text-gray-300 font-medium truncate max-w-[220px]" title={entry.description}>
          {entry.description}
        </span>
        <span className="text-gray-500 text-[11px] whitespace-nowrap">
          {dateStr}
        </span>
      </div>

      <div className="flex justify-between items-center pt-2 border-t border-gray-800/40 text-[11px] text-gray-500">
        <div>
          Bal: <span className="text-gray-400">{entry.balanceBefore}</span> → <span className="text-gray-300 font-medium">{entry.balanceAfter}</span>
        </div>
        {entry.referenceId && (
          <div className="font-mono text-[10px] text-gray-600 truncate max-w-[120px]" title={entry.referenceId}>
            Ref: {entry.referenceId}
          </div>
        )}
      </div>
    </div>
  );
}

function ActionButton({ icon: Icon, label, disabled = false, onClick }: { icon: React.ElementType, label: string, disabled?: boolean, onClick?: () => void }) {
  return (
    <button 
      disabled={disabled}
      onClick={onClick}
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

function AssetRow({ asset, details, showLocked = false }: { asset: Asset, details: { name: string, color: string }, showLocked?: boolean }) {
  return (
    <div className="flex flex-col py-3 px-3 hover:bg-gray-900/40 rounded-xl cursor-pointer transition-colors border border-gray-800/50 bg-gray-900/20">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-full ${details.color} flex items-center justify-center font-bold text-white text-xs shadow-inner`}>
            {asset.asset.charAt(0)}
          </div>
          <div>
            <div className="font-bold text-gray-100 flex items-center gap-2">
              {asset.asset} 
              {showLocked && Number(asset.lockedBalance) > 0 && <span className="text-[9px] bg-gray-800 px-1 py-0.5 rounded text-gray-400 font-medium">LOCKED: {Number(asset.lockedBalance).toFixed(4)}</span>}
            </div>
            <div className="text-[11px] font-medium text-gray-500">{details.name}</div>
          </div>
        </div>
        <div className="text-right">
          <div className="font-bold text-gray-100">{Number(asset.totalBalance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}</div>
          <div className="text-[11px] font-medium text-gray-500">≈ ${Number(asset.marketValue).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
      </div>
    </div>
  );
}

function TransferModal({ onClose, balances }: { onClose: () => void, balances: any }) {
  const [fromWallet, setFromWallet] = useState<WalletType>('SPOT');
  const [toWallet, setToWallet] = useState<WalletType>('FUTURES');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');

  const handleSwitch = () => {
    setFromWallet(toWallet);
    setToWallet(fromWallet);
    setError('');
    setAmount('');
  };

  const available = fromWallet === 'SPOT' ? balances.spotAvailable : balances.futuresAvailable;

  const handleTransfer = async () => {
    setError('');
    try {
      await internalTransferService.createTransfer('USDT', amount, fromWallet, toWallet);
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full sm:w-[400px] bg-gray-900 border-t sm:border border-gray-800 rounded-t-3xl sm:rounded-3xl overflow-hidden shadow-2xl animate-in slide-in-from-bottom-10 sm:slide-in-from-bottom-0 sm:fade-in-0 duration-300">
        <div className="px-5 py-4 border-b border-gray-800 flex justify-between items-center">
          <h2 className="text-lg font-bold text-white">Transfer</h2>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-white rounded-full hover:bg-gray-800 transition-colors">
            <X size={20} />
          </button>
        </div>
        
        <div className="p-5 flex flex-col gap-5">
          {error && (
             <div className="bg-red-500/10 border border-red-500/50 text-red-500 px-3 py-2 rounded-lg text-sm font-medium">
               {error}
             </div>
          )}

          {/* Wallet Selection */}
          <div className="flex flex-col relative gap-1">
            <div className="bg-gray-800/50 border border-gray-800 rounded-xl p-3 flex justify-between items-center">
              <div>
                <div className="text-xs text-gray-500 font-medium mb-1">From</div>
                <div className="text-sm font-bold text-gray-200">{fromWallet === 'SPOT' ? 'Spot Wallet' : 'Futures Wallet'}</div>
              </div>
            </div>
            
            <button 
              onClick={handleSwitch}
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-gray-700 hover:bg-gray-600 border-[3px] border-gray-900 text-gray-300 p-1.5 rounded-full z-10 transition-colors"
            >
              <ArrowRightLeft size={16} className="rotate-90" />
            </button>

            <div className="bg-gray-800/50 border border-gray-800 rounded-xl p-3 flex justify-between items-center mt-1">
              <div>
                <div className="text-xs text-gray-500 font-medium mb-1">To</div>
                <div className="text-sm font-bold text-gray-200">{toWallet === 'SPOT' ? 'Spot Wallet' : 'Futures Wallet'}</div>
              </div>
            </div>
          </div>

          {/* Asset Selection */}
          <div>
            <div className="text-xs text-gray-500 font-medium mb-2">Asset</div>
            <div className="bg-gray-800/50 border border-gray-800 rounded-xl p-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-[#26A17B] flex items-center justify-center font-bold text-white text-[10px]">U</div>
                <span className="font-bold text-gray-200">USDT</span>
              </div>
            </div>
          </div>

          {/* Amount */}
          <div>
            <div className="flex justify-between items-end mb-2">
              <div className="text-xs text-gray-500 font-medium">Amount</div>
              <div className="text-xs text-gray-400">Available: <span className="font-bold text-gray-200">{Number(available).toFixed(2)}</span></div>
            </div>
            <div className="relative">
              <input 
                type="number" 
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full bg-gray-800/80 border border-gray-700 focus:border-blue-500 rounded-xl py-3 pl-4 pr-16 text-white font-bold placeholder-gray-600 outline-none transition-colors"
              />
              <button 
                onClick={() => setAmount(available)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-blue-500 font-bold text-sm hover:text-blue-400"
              >
                MAX
              </button>
            </div>
          </div>

          <button 
            onClick={handleTransfer}
            disabled={!amount || isNaN(Number(amount)) || Number(amount) <= 0 || Number(amount) > Number(available)}
            className="w-full mt-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 disabled:text-white/50 text-white font-bold py-3.5 rounded-xl transition-colors"
          >
            Confirm Transfer
          </button>
        </div>
      </div>
    </div>
  );
}

function DepositModal({ onClose, userId }: { onClose: () => void; userId: string }) {
  const [asset, setAsset] = useState('USDT');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleDeposit = async () => {
    setError('');
    setIsSubmitting(true);
    try {
      await demoTransactionService.createDeposit(asset, amount);
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full sm:w-[400px] bg-gray-900 border-t sm:border border-gray-800 rounded-t-3xl sm:rounded-3xl overflow-hidden shadow-2xl animate-in slide-in-from-bottom-10 sm:slide-in-from-bottom-0 sm:fade-in-0 duration-300">
        <div className="px-5 py-4 border-b border-gray-800 flex justify-between items-center">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Download size={20} className="text-blue-500" /> Demo Deposit
          </h2>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-white rounded-full hover:bg-gray-800 transition-colors">
            <X size={20} />
          </button>
        </div>
        
        <div className="p-5 flex flex-col gap-5">
          <div className="bg-blue-500/10 border border-blue-500/20 text-blue-400 px-4 py-3 rounded-xl text-sm font-medium flex gap-2">
            <div>ℹ️</div>
            <div>Demo only — no real funds are transferred. This adds simulated balance to your account.</div>
          </div>

          {error && (
             <div className="bg-red-500/10 border border-red-500/50 text-red-500 px-3 py-2 rounded-lg text-sm font-medium">
               {error}
             </div>
          )}

          <div>
            <div className="text-xs text-gray-500 font-medium mb-2">Asset</div>
            <select 
              value={asset}
              onChange={(e) => setAsset(e.target.value)}
              className="w-full bg-gray-800/80 border border-gray-700 focus:border-blue-500 rounded-xl py-3 px-4 text-white font-bold outline-none transition-colors appearance-none"
            >
              <option value="USDT">USDT - Tether US</option>
              <option value="BTC">BTC - Bitcoin</option>
              <option value="ETH">ETH - Ethereum</option>
              <option value="SOL">SOL - Solana</option>
              <option value="BNB">BNB - Binance Coin</option>
              <option value="XRP">XRP - Ripple</option>
              <option value="DOGE">DOGE - Dogecoin</option>
            </select>
          </div>

          <div>
            <div className="text-xs text-gray-500 font-medium mb-2">Amount</div>
            <div className="relative">
              <input 
                type="number" 
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full bg-gray-800/80 border border-gray-700 focus:border-blue-500 rounded-xl py-3 pl-4 pr-16 text-white font-bold placeholder-gray-600 outline-none transition-colors"
              />
              <div className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 font-bold text-sm">
                {asset}
              </div>
            </div>
          </div>

          <button 
            disabled={!amount || isSubmitting}
            onClick={handleDeposit}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:hover:bg-blue-600 text-white font-bold py-3.5 rounded-xl transition-colors mt-2"
          >
            {isSubmitting ? 'Confirming...' : 'Confirm Deposit'}
          </button>
        </div>
      </div>
    </div>
  );
}

function WithdrawModal({ onClose, balances, assets, userId }: { onClose: () => void, balances: any, assets: Asset[], userId: string }) {
  const [asset, setAsset] = useState('USDT');
  const [amount, setAmount] = useState('');
  const [destination, setDestination] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const assetRecord = assets.find(a => a.asset === asset);
  const available = assetRecord ? assetRecord.availableBalance : (asset === 'USDT' ? balances.spotAvailable : '0');

  const handleWithdraw = async () => {
    setError('');
    setIsSubmitting(true);
    try {
      if (!destination.trim()) {
        throw new Error('Destination label is required');
      }
      await demoTransactionService.createWithdrawal(userId, asset, amount, destination);
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full sm:w-[400px] bg-gray-900 border-t sm:border border-gray-800 rounded-t-3xl sm:rounded-3xl overflow-hidden shadow-2xl animate-in slide-in-from-bottom-10 sm:slide-in-from-bottom-0 sm:fade-in-0 duration-300">
        <div className="px-5 py-4 border-b border-gray-800 flex justify-between items-center">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Upload size={20} className="text-red-500" /> Demo Withdrawal
          </h2>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-white rounded-full hover:bg-gray-800 transition-colors">
            <X size={20} />
          </button>
        </div>
        
        <div className="p-5 flex flex-col gap-5">
          <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-xl text-sm font-medium flex gap-2">
            <div>ℹ️</div>
            <div>Demo only — no real funds are transferred. This deducts simulated balance from your spot account.</div>
          </div>

          {error && (
             <div className="bg-red-500/10 border border-red-500/50 text-red-500 px-3 py-2 rounded-lg text-sm font-medium">
               {error}
             </div>
          )}

          <div>
            <div className="text-xs text-gray-500 font-medium mb-2">Asset</div>
            <select 
              value={asset}
              onChange={(e) => { setAsset(e.target.value); setAmount(''); }}
              className="w-full bg-gray-800/80 border border-gray-700 focus:border-blue-500 rounded-xl py-3 px-4 text-white font-bold outline-none transition-colors appearance-none"
            >
              <option value="USDT">USDT - Tether US</option>
              <option value="BTC">BTC - Bitcoin</option>
              <option value="ETH">ETH - Ethereum</option>
              <option value="SOL">SOL - Solana</option>
              <option value="BNB">BNB - Binance Coin</option>
              <option value="XRP">XRP - Ripple</option>
              <option value="DOGE">DOGE - Dogecoin</option>
            </select>
          </div>

          <div>
            <div className="text-xs text-gray-500 font-medium mb-2">Demo Destination Label</div>
            <input 
              type="text" 
              value={destination}
              onChange={e => setDestination(e.target.value)}
              placeholder="e.g. External demo wallet"
              className="w-full bg-gray-800/80 border border-gray-700 focus:border-blue-500 rounded-xl py-3 px-4 text-white font-bold placeholder-gray-600 outline-none transition-colors"
            />
          </div>

          <div>
            <div className="flex justify-between items-end mb-2">
              <div className="text-xs text-gray-500 font-medium">Amount</div>
              <div className="text-xs text-gray-400">Available: <span className="font-bold text-gray-200">{Number(available).toFixed(4)}</span></div>
            </div>
            <div className="relative">
              <input 
                type="number" 
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full bg-gray-800/80 border border-gray-700 focus:border-blue-500 rounded-xl py-3 pl-4 pr-16 text-white font-bold placeholder-gray-600 outline-none transition-colors"
              />
              <button 
                onClick={() => setAmount(available)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-blue-500 font-bold text-sm hover:text-blue-400"
              >
                MAX
              </button>
            </div>
          </div>

          <button 
            disabled={!amount || !destination.trim() || isSubmitting}
            onClick={handleWithdraw}
            className="w-full bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:hover:bg-red-600 text-white font-bold py-3.5 rounded-xl transition-colors mt-2"
          >
            {isSubmitting ? 'Confirming...' : 'Confirm Withdrawal'}
          </button>
        </div>
      </div>
    </div>
  );
}

function TransactionDetailModal({ tx, onClose }: { tx: Transaction; onClose: () => void }) {
  let dateStr = 'Unknown date';
  try {
    const d = new Date(tx.createdAt);
    if (!isNaN(d.getTime())) {
      dateStr = d.toLocaleString();
    }
  } catch (e) {}

  let completedStr = '-';
  if (tx.completedAt) {
    try {
      const d = new Date(tx.completedAt);
      if (!isNaN(d.getTime())) {
        completedStr = d.toLocaleString();
      }
    } catch (e) {}
  }

  const isCredit = tx.direction === 'CREDIT';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-800 rounded-xl w-full max-w-sm overflow-hidden flex flex-col shadow-2xl">
        <div className="flex justify-between items-center p-4 border-b border-gray-800">
          <h3 className="text-gray-100 font-bold">Transaction Details</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors">
            <X size={20} />
          </button>
        </div>
        
        <div className="p-5 flex flex-col gap-4">
          <div className="text-center pb-2 border-b border-gray-800/50">
            <div className={`text-2xl font-bold ${isCredit ? 'text-emerald-400' : 'text-red-400'}`}>
              {isCredit ? '+' : '-'}{tx.amount} {tx.asset}
            </div>
            <div className="text-xs text-gray-500 mt-1 uppercase font-semibold">
              {tx.type.replace('_', ' ')} • {tx.wallet}
            </div>
          </div>

          <div className="flex flex-col gap-3 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Status</span>
              <span className={`font-bold ${
                tx.status === 'COMPLETED' ? 'text-emerald-400' :
                tx.status === 'FAILED' ? 'text-red-400' :
                tx.status === 'CANCELLED' ? 'text-gray-400' :
                'text-amber-400'
              }`}>{tx.status}</span>
            </div>
            
            <div className="flex justify-between">
              <span className="text-gray-500">Transaction ID</span>
              <span className="text-gray-300 font-mono text-xs">{tx.id}</span>
            </div>

            {tx.referenceId && (
              <div className="flex justify-between">
                <span className="text-gray-500">Reference ID</span>
                <span className="text-gray-300 font-mono text-xs">{tx.referenceId}</span>
              </div>
            )}

            <div className="flex justify-between">
              <span className="text-gray-500">Description</span>
              <span className="text-gray-300 text-right max-w-[180px]">{tx.description}</span>
            </div>

            <div className="flex justify-between">
              <span className="text-gray-500">Created</span>
              <span className="text-gray-400 text-xs">{dateStr}</span>
            </div>

            {(tx.status === 'COMPLETED' || tx.status === 'FAILED') && (
              <div className="flex justify-between">
                <span className="text-gray-500">Completed</span>
                <span className="text-gray-400 text-xs">{completedStr !== '-' ? completedStr : dateStr}</span>
              </div>
            )}
          </div>
          
          <div className="mt-2 bg-amber-900/20 border border-amber-500/20 rounded-lg p-3 text-center">
            <span className="text-amber-500/80 text-[10px] font-bold uppercase tracking-wider mb-1 flex items-center justify-center gap-1">
              <AlertCircle size={12} />
              Demo Environment
            </span>
            <span className="text-amber-400/60 text-[10px] leading-tight block">
              DEMO ONLY — NO REAL FUNDS.<br/>
              This is a paper-trading simulation record.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
