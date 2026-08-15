import React, { useState, useEffect } from 'react';
import { Menu, ChevronDown, MoreHorizontal, Info } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { useMarketData } from '../hooks/useMarketData';
import { futuresService } from '../services/FuturesService';
import { FuturesPosition, FuturesCalculationResult } from '../types/futures';
import { useLedger } from '../hooks/useLedger';
import { FuturesService } from '../services/FuturesService';
import { Decimal } from 'decimal.js';
import { useAuth } from '../contexts/AuthContext';

export function Futures() {
  const { user } = useAuth();
  const accountId = user?.id || 'demo-account';
  const [orderSide, setOrderSide] = useState<'LONG' | 'SHORT'>('LONG');
  const [leverage, setLeverage] = useState<number>(20);
  const [amountInput, setAmountInput] = useState('');
  
  const { data: markets } = useMarketData();
  const { balances, ledger } = useLedger();
  const market = markets.find(m => m.baseAsset === 'BTC') || markets[0];
  
  const usdtBalance = balances['USDT'] || '0';
  
  // Real-time position tracking
  const [positions, setPositions] = useState<FuturesPosition[]>([]);
  const [liveStats, setLiveStats] = useState<Record<string, FuturesCalculationResult>>({});

  useEffect(() => {
    // Load positions
    const updatePositions = () => {
      setPositions(futuresService.getPositions(accountId));
    };
    
    updatePositions();
    const unsubscribe = futuresService.subscribe(updatePositions);
    return unsubscribe;
  }, []);

  useEffect(() => {
    // Calculate live stats based on mark price
    if (!market || positions.length === 0) return;
    
    const newStats: Record<string, FuturesCalculationResult> = {};
    positions.forEach(p => {
      newStats[p.id] = FuturesService.calculateLiveStats(p, market.price.toString());
    });
    setLiveStats(newStats);
  }, [market?.price, positions]);

  const handleOpenPosition = async () => {
    if (!market || !amountInput) return;
    
    const size = amountInput;
    const price = market.price.toString();
    
    // Check margin availability
    const marginReq = FuturesService.calculateMargin(size, price, leverage);
    if (new Decimal(usdtBalance).lt(new Decimal(marginReq))) {
      alert(`Insufficient USDT balance for initial margin. Required: ${marginReq}`);
      return;
    }

    try {
      await futuresService.openPosition(accountId, 'BTCUSDT', orderSide, leverage, size);
      
      setAmountInput('');
    } catch (e: any) {
      alert(e.message || 'Failed to open position.');
    }
  };

  const handleClosePosition = async (positionId: string) => {
    try {
      await futuresService.closePosition(positionId);
    } catch (e: any) {
      alert(e.message || 'Failed to close position.');
    }
  };

  if (!market) return null;

  const currentPriceFormatted = market.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  
  const leverageOptions = [1, 2, 5, 10, 20];

  return (
    <div className="pb-6 flex flex-col min-h-screen relative">
      {/* DEMO LABEL */}
      <div className="bg-blue-600 text-white text-center py-1 text-xs font-bold uppercase tracking-wider shadow-sm z-50">
        Demo Paper Trading - No Real Funds
      </div>

      {/* Header */}
      <div className="px-4 py-3 flex items-center justify-between border-b border-gray-900 bg-gray-950">
        <div className="flex items-center gap-2">
          <Menu size={20} className="text-gray-400" />
          <h1 className="text-lg font-bold text-white flex items-center gap-1">
            BTCUSDT <span className="text-xs bg-gray-800 text-gray-400 px-1 rounded">Perp</span>
          </h1>
          <span className={`text-sm font-medium ${Number(market.change24hPercent) >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
            {Number(market.change24hPercent) >= 0 ? '+' : ''}{Number(market.change24hPercent).toFixed(2)}%
          </span>
        </div>
        <div className="flex items-center gap-3 text-gray-400">
          <MoreHorizontal size={20} />
        </div>
      </div>

      <div className="flex flex-1 px-4 py-4 gap-4">
        {/* Left Col: Order Form */}
        <div className="w-[60%] flex flex-col pr-2">
          {/* Margin & Leverage */}
          <div className="flex gap-2 mb-4">
            <button className="bg-gray-900 border border-gray-800 px-3 py-1 rounded text-[11px] font-bold text-gray-400 cursor-not-allowed">
              Isolated
            </button>
            
            <div className="flex gap-1 overflow-x-auto pb-1 hide-scrollbar">
              {leverageOptions.map(lev => (
                <button 
                  key={lev}
                  className={`border px-2 py-1 rounded text-[11px] font-bold min-w-8 ${leverage === lev ? 'bg-blue-600 border-blue-500 text-white' : 'bg-gray-900 border-gray-800 text-gray-400 hover:text-gray-200'}`}
                  onClick={() => setLeverage(lev)}
                >
                  {lev}x
                </button>
              ))}
            </div>
          </div>

          {/* Buy/Sell Tabs */}
          <div className="flex bg-gray-900 rounded-lg p-1 mb-4">
            <button
              className={`flex-1 py-1.5 text-sm font-bold rounded-md transition-all ${
                orderSide === 'LONG' ? 'bg-emerald-500 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'
              }`}
              onClick={() => setOrderSide('LONG')}
            >
              Open Long
            </button>
            <button
              className={`flex-1 py-1.5 text-sm font-bold rounded-md transition-all ${
                orderSide === 'SHORT' ? 'bg-red-500 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'
              }`}
              onClick={() => setOrderSide('SHORT')}
            >
              Open Short
            </button>
          </div>

          {/* Size Input */}
          <div className="bg-gray-900 border border-gray-800 focus-within:border-gray-600 transition-colors rounded-lg flex items-center px-3 py-2.5 mb-2 relative">
            <input 
              type="number" 
              className="bg-transparent flex-1 w-full text-gray-100 text-sm font-bold focus:outline-none"
              placeholder="Size (BTC)"
              value={amountInput}
              onChange={e => setAmountInput(e.target.value)}
            />
            <div className="flex items-center gap-1">
              <span className="text-gray-400 text-sm font-medium">BTC</span>
            </div>
          </div>

          <div className="flex justify-between text-xs text-gray-500 mb-4 font-medium mt-2">
            <span>Avail</span>
            <span className="text-gray-200">{parseFloat(usdtBalance).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT</span>
          </div>

          <Button 
            className={`py-3 shadow-md ${orderSide === 'LONG' ? 'bg-emerald-500 hover:bg-emerald-600' : 'bg-red-500 hover:bg-red-600'}`}
            fullWidth
            onClick={handleOpenPosition}
            disabled={!amountInput || parseFloat(amountInput) <= 0}
          >
            {orderSide === 'LONG' ? 'Buy / Long' : 'Sell / Short'}
          </Button>
          
          <div className="flex justify-between text-[10px] text-gray-500 mt-2 font-medium">
            <span>Cost (Margin)</span>
            <span className="text-gray-300">
              {amountInput ? parseFloat(FuturesService.calculateMargin(amountInput, market.price.toString(), leverage)).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '0.00'} USDT
            </span>
          </div>
        </div>

        {/* Right Col: Minimal Order Book / Price Display */}
        <div className="w-[40%] flex flex-col items-center justify-center border-l border-gray-900 pl-4">
           <div className="text-gray-500 text-xs font-medium mb-2 uppercase tracking-wider">Mark Price</div>
           <div className={`text-2xl font-bold ${Number(market.change24hPercent) >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
             {currentPriceFormatted}
           </div>
           <div className="text-gray-500 text-xs mt-1">Updates live</div>
        </div>
      </div>

      {/* Positions Section */}
      <div className="px-4 mt-4 border-t border-gray-900 pt-4">
        <div className="flex gap-6 text-sm font-bold mb-4">
          <span className="text-white border-b-2 border-white pb-2">Positions ({positions.length})</span>
        </div>
        
        {positions.map(pos => {
          const stats = liveStats[pos.id] || { unrealizedPnl: '0', pnlPercentage: '0', marginRatio: '0' };
          const pnlNum = parseFloat(stats.unrealizedPnl);
          const isPositive = pnlNum >= 0;
          
          return (
            <div key={pos.id} className="bg-gray-900/50 rounded-lg p-3 mb-3 border border-gray-800">
              <div className="flex justify-between items-center mb-2">
                <div className="flex items-center gap-2">
                  <span className={`font-bold px-1 rounded text-xs ${pos.side === 'LONG' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500'}`}>
                    {pos.side === 'LONG' ? 'L' : 'S'} {pos.leverage}x
                  </span>
                  <span className="font-bold text-white text-sm">{pos.symbol}</span>
                </div>
                <span className={`font-bold ${isPositive ? 'text-emerald-500' : 'text-red-500'}`}>
                  {isPositive ? '+' : ''}{pnlNum.toFixed(2)} ({parseFloat(stats.pnlPercentage).toFixed(2)}%)
                </span>
              </div>
              
              <div className="grid grid-cols-3 gap-y-3 gap-x-2 text-xs mb-3">
                <div>
                  <div className="text-gray-500 mb-0.5">Size</div>
                  <div className="font-medium text-white">{parseFloat(pos.size).toFixed(3)}</div>
                </div>
                <div>
                  <div className="text-gray-500 mb-0.5">Entry Price</div>
                  <div className="font-medium text-white">{parseFloat(pos.entryPrice).toLocaleString()}</div>
                </div>
                <div className="text-right">
                  <div className="text-gray-500 mb-0.5">Mark Price</div>
                  <div className="font-medium text-white">{currentPriceFormatted}</div>
                </div>
                <div>
                  <div className="text-gray-500 mb-0.5">Margin Ratio</div>
                  <div className="font-medium text-white">{parseFloat(stats.marginRatio).toFixed(2)}%</div>
                </div>
                <div>
                  <div className="text-gray-500 mb-0.5">Margin</div>
                  <div className="font-medium text-white">{parseFloat(pos.margin).toFixed(2)}</div>
                </div>
                <div className="text-right">
                  <div className="text-gray-500 mb-0.5">Liq. Price</div>
                  <div className="font-medium text-amber-500">{parseFloat(pos.liquidationPrice).toLocaleString()}</div>
                </div>
              </div>
              
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" className="text-xs py-1" onClick={() => handleClosePosition(pos.id)}>
                  Close Position
                </Button>
              </div>
            </div>
          );
        })}
        {positions.length === 0 && (
          <div className="text-center text-gray-500 py-8 text-sm">
            No open positions
          </div>
        )}
      </div>
    </div>
  );
}
