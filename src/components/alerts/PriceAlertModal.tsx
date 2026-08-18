import React, { useState, useEffect, useRef } from 'react';
import { X, Bell, Trash2, ArrowUpRight, ArrowDownRight, Activity } from 'lucide-react';
import { Button } from '../ui/Button';
import { priceAlertService } from '../../services/alerts/PriceAlertService';
import { tradingPairRegistry, TradingPair } from '../../services/market/TradingPairRegistry';
import { useTicker } from '../../hooks/useTicker';
import { PriceAlert } from '../../types/alerts';
import { Decimal } from 'decimal.js';

interface PriceAlertModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultSymbol?: string;
}

export function PriceAlertModal({ isOpen, onClose, defaultSymbol = 'BTCUSDT' }: PriceAlertModalProps) {
  const [activeTab, setActiveTab] = useState<'create' | 'manage'>('create');

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col justify-end bg-black/60 backdrop-blur-sm sm:items-center sm:justify-center">
      <div className="bg-gray-950 w-full sm:w-[400px] h-[85vh] sm:h-[600px] sm:max-h-[85vh] sm:rounded-2xl border border-gray-800 flex flex-col shadow-2xl animate-in slide-in-from-bottom-full sm:slide-in-from-bottom-0 sm:fade-in-0 duration-200">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-900 shrink-0">
          <div className="flex items-center gap-2 text-gray-200 font-bold">
            <Bell size={18} className="text-blue-500" />
            Price Alerts
          </div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-white rounded-full hover:bg-gray-800 transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="flex px-4 pt-2 border-b border-gray-900 shrink-0">
          <button
            className={`flex-1 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'create' ? 'border-blue-500 text-blue-500' : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
            onClick={() => setActiveTab('create')}
          >
            Create Alert
          </button>
          <button
            className={`flex-1 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'manage' ? 'border-blue-500 text-blue-500' : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
            onClick={() => setActiveTab('manage')}
          >
            Manage
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {activeTab === 'create' ? (
            <PriceAlertForm defaultSymbol={defaultSymbol} onSuccess={() => setActiveTab('manage')} />
          ) : (
            <PriceAlertManager />
          )}
        </div>
      </div>
    </div>
  );
}

function PriceAlertForm({ defaultSymbol, onSuccess }: { defaultSymbol: string, onSuccess: () => void }) {
  const [symbol, setSymbol] = useState(defaultSymbol);
  const [condition, setCondition] = useState<'ABOVE' | 'BELOW'>('ABOVE');
  const [targetPrice, setTargetPrice] = useState('');
  const [repeat, setRepeat] = useState<'ONCE' | 'REPEATING'>('ONCE');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);

  const selectedPair = tradingPairRegistry.getPair(symbol);
  const ticker = useTicker(symbol) as any;
  const currentPrice = ticker?.lastPrice || '--';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    setError('');

    if (!selectedPair) {
      setError('Invalid symbol selected.');
      isSubmittingRef.current = false;
      setIsSubmitting(false);
      return;
    }

    if (!targetPrice) {
      setError('Target price is required.');
      isSubmittingRef.current = false;
      setIsSubmitting(false);
      return;
    }

    try {
      const priceDecimal = new Decimal(targetPrice);
      if (priceDecimal.isNaN() || !priceDecimal.isFinite()) {
        setError('Target price must be a valid number.');
        return;
      }
      if (priceDecimal.lte(0)) {
        setError('Target price must be greater than zero.');
        return;
      }

      priceAlertService.createAlert(
        symbol,
        selectedPair.marketType,
        condition,
        targetPrice,
        repeat
      );

      setTargetPrice('');
      onSuccess();
    } catch (err: any) {
      setError(err.message || 'Failed to create alert.');
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handlePriceInput = (val: string) => {
    // Basic number validation
    if (val === '' || /^\d*\.?\d*$/.test(val)) {
      setTargetPrice(val);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="p-4 flex flex-col gap-5">
      {/* Symbol Selection */}
      <div className="flex flex-col gap-2">
        <label className="text-xs text-gray-400 font-medium uppercase tracking-wider">Symbol</label>
        <select
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          className="w-full bg-gray-900 border border-gray-800 rounded-lg px-3 py-2.5 text-sm text-gray-200 focus:outline-none focus:border-blue-500 transition-colors"
        >
          {tradingPairRegistry.getAllPairs().map(p => (
            <option key={p.symbol} value={p.symbol}>
              {p.symbol} {p.marketType === 'FUTURES' ? '(Perp)' : '(Spot)'}
            </option>
          ))}
        </select>
      </div>

      {/* Current Price */}
      <div className="bg-gray-900/50 rounded-lg p-3 border border-gray-800 flex justify-between items-center">
        <span className="text-sm text-gray-400 flex items-center gap-1.5"><Activity size={14} /> Current Price</span>
        <span className="font-bold text-gray-200">
          {currentPrice !== '--' && selectedPair 
            ? parseFloat(currentPrice).toLocaleString(undefined, { minimumFractionDigits: selectedPair.quantityPrecision }) 
            : '--'}
        </span>
      </div>

      {/* Condition */}
      <div className="flex flex-col gap-2">
        <label className="text-xs text-gray-400 font-medium uppercase tracking-wider">Condition</label>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setCondition('ABOVE')}
            className={`flex items-center justify-center gap-2 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
              condition === 'ABOVE' ? 'bg-emerald-500/10 border-emerald-500 text-emerald-500' : 'bg-gray-900 border-gray-800 text-gray-500 hover:border-gray-700'
            }`}
          >
            <ArrowUpRight size={16} /> Price Above
          </button>
          <button
            type="button"
            onClick={() => setCondition('BELOW')}
            className={`flex items-center justify-center gap-2 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
              condition === 'BELOW' ? 'bg-red-500/10 border-red-500 text-red-500' : 'bg-gray-900 border-gray-800 text-gray-500 hover:border-gray-700'
            }`}
          >
            <ArrowDownRight size={16} /> Price Below
          </button>
        </div>
      </div>

      {/* Target Price */}
      <div className="flex flex-col gap-2">
        <div className="flex justify-between items-end">
          <label className="text-xs text-gray-400 font-medium uppercase tracking-wider">Target Price</label>
          <span className="text-[10px] text-gray-500">
            {selectedPair ? `Precision: ${selectedPair.tickSize}` : ''}
          </span>
        </div>
        <div className="relative">
          <input
            type="text"
            inputMode="decimal"
            value={targetPrice}
            onChange={(e) => handlePriceInput(e.target.value)}
            placeholder="0.00"
            className="w-full bg-gray-900 border border-gray-800 rounded-lg px-3 py-2.5 text-sm text-gray-200 focus:outline-none focus:border-blue-500 transition-colors"
          />
          {selectedPair && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm font-medium">
              {selectedPair.quoteAsset}
            </div>
          )}
        </div>
      </div>

      {/* Repeat */}
      <div className="flex flex-col gap-2">
        <label className="text-xs text-gray-400 font-medium uppercase tracking-wider">Repeat Type</label>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input 
              type="radio" 
              name="repeat" 
              checked={repeat === 'ONCE'} 
              onChange={() => setRepeat('ONCE')}
              className="accent-blue-500 w-4 h-4"
            />
            <span className="text-sm text-gray-300">Once</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input 
              type="radio" 
              name="repeat" 
              checked={repeat === 'REPEATING'} 
              onChange={() => setRepeat('REPEATING')}
              className="accent-blue-500 w-4 h-4"
            />
            <span className="text-sm text-gray-300">Repeating</span>
          </label>
        </div>
        <p className="text-[11px] text-gray-500 leading-relaxed mt-1">
          {repeat === 'ONCE' 
            ? 'Triggers one time and becomes triggered. Duplicate triggers are prevented.' 
            : 'Can trigger again after the price crosses back through the threshold.'}
        </p>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-xs px-3 py-2 rounded-lg">
          {error}
        </div>
      )}

      <Button 
        type="submit" 
        disabled={isSubmitting || currentPrice === '--'}
        className="w-full mt-2"
        variant="primary"
      >
        {isSubmitting ? 'Processing...' : 'Create Alert'}
      </Button>
    </form>
  );
}

function PriceAlertManager() {
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);
  // Use simple effect to reload alerts if they change, though a full subscription is ideal
  useEffect(() => {
    setAlerts(priceAlertService.getAlerts());
    
    // Subscribe to re-evaluate visually on trigger
    const unsub = priceAlertService.subscribe(() => {
      setAlerts(priceAlertService.getAlerts());
    });
    
    // Also poll every second just in case status changed silently or for timestamp freshness
    const interval = setInterval(() => {
      setAlerts(priceAlertService.getAlerts());
    }, 1000);
    
    return () => {
      unsub();
      clearInterval(interval);
    };
  }, []);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'ACTIVE': return 'text-blue-400 bg-blue-500/10 border border-blue-500/20';
      case 'TRIGGERED': return 'text-emerald-400 bg-emerald-500/10 border border-emerald-500/20';
      case 'CANCELLED': return 'text-gray-400 bg-gray-500/10 border border-gray-500/20';
      case 'EXPIRED': return 'text-orange-400 bg-orange-500/10 border border-orange-500/20';
      default: return 'text-gray-400';
    }
  };

  if (alerts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500 p-6 text-center">
        <Bell size={32} className="mb-3 opacity-20" />
        <p className="text-sm font-medium mb-1">No Alerts Configured</p>
        <p className="text-xs">You haven't created any price alerts yet.</p>
      </div>
    );
  }

  // Sort: Active first, then by creation date descending
  const sortedAlerts = [...alerts].sort((a, b) => {
    if (a.status === 'ACTIVE' && b.status !== 'ACTIVE') return -1;
    if (a.status !== 'ACTIVE' && b.status === 'ACTIVE') return 1;
    return b.createdAt - a.createdAt;
  });

  return (
    <div className="flex flex-col gap-2 p-4">
      {sortedAlerts.map(alert => {
        const pair = tradingPairRegistry.getPair(alert.symbol);
        const precision = pair?.quantityPrecision ?? 2;
        
        return (
          <div key={alert.id} className="bg-gray-900 border border-gray-800 rounded-lg p-3 flex flex-col gap-2 relative group overflow-hidden">
            <div className="flex justify-between items-start">
              <div className="flex items-center gap-2">
                <span className="font-bold text-gray-200 text-sm">{alert.symbol}</span>
                <span className="text-[10px] text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded uppercase">{alert.marketType}</span>
              </div>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${getStatusColor(alert.status)}`}>
                {alert.status}
              </span>
            </div>
            
            <div className="flex items-end justify-between mt-1">
              <div className="flex flex-col">
                <span className="text-xs text-gray-500">
                  {alert.condition === 'ABOVE' ? 'Price Above' : 'Price Below'}
                </span>
                <span className={`text-lg font-medium ${alert.condition === 'ABOVE' ? 'text-emerald-500' : 'text-red-500'}`}>
                  {parseFloat(alert.targetPrice).toLocaleString(undefined, { minimumFractionDigits: precision })}
                </span>
              </div>
              
              <div className="flex flex-col items-end text-right">
                <span className="text-[10px] text-gray-500 mb-0.5">
                  {alert.repeat === 'REPEATING' ? 'Repeating' : 'One-time'}
                </span>
                {alert.triggeredAt ? (
                  <span className="text-[10px] text-gray-400">
                    Triggered: {new Date(alert.triggeredAt).toLocaleTimeString()}
                  </span>
                ) : (
                  <span className="text-[10px] text-gray-500">
                    Created: {new Date(alert.createdAt).toLocaleDateString()}
                  </span>
                )}
              </div>
            </div>

            <div className="absolute right-0 top-0 bottom-0 flex items-center justify-center px-4 bg-gradient-to-l from-gray-950 via-gray-950 to-transparent opacity-0 group-hover:opacity-100 transition-opacity translate-x-4 group-hover:translate-x-0 duration-200">
              {alert.status === 'ACTIVE' && (
                <button 
                  onClick={() => priceAlertService.cancelAlert(alert.id)}
                  className="bg-gray-800 text-gray-300 hover:text-white hover:bg-gray-700 text-xs px-3 py-1.5 rounded font-medium mr-2"
                >
                  Cancel
                </button>
              )}
              <button 
                onClick={() => priceAlertService.deleteAlert(alert.id)}
                className="bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white p-1.5 rounded transition-colors"
                aria-label="Delete Alert"
              >
                <Trash2 size={16} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
