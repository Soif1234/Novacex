import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Menu, ChevronDown, Activity, Info, ArrowUpRight, ArrowDownRight, AlertTriangle, Bell } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { useFuturesMarketData } from '../hooks/useFuturesMarketData';
import { useLedger } from '../hooks/useLedger';

import { OrderBookService, OrderBook } from '../services/OrderBookService';
import { futuresOrderService } from '../services/futures/FuturesOrderService';
import { futuresRiskService } from '../services/futures/FuturesRiskService';
import { futuresFundingService } from '../services/futures/FuturesFundingService';
import { MarginMode, FuturesOrderType } from '../types/futures';
import { futuresTpSlService } from '../services/futures/FuturesTpSlService';
import { futuresFeeService } from '../services/futures/FuturesFeeService';
import { FuturesChart } from '../components/futures/FuturesChart';
import { OpenOrders } from '../components/orders/OpenOrders';
import { OrderHistory } from '../components/orders/OrderHistory';
import { TradeHistory } from '../components/orders/TradeHistory';
import { MarketSelector } from '../components/MarketSelector';
import { useSelectedSymbol } from '../hooks/useSelectedSymbol';
import { useTicker } from '../hooks/useTicker';
import { useAuth } from '../contexts/AuthContext';
import { wsClient } from '../services/websocket/wsClient';

const LEVERAGE_OPTIONS = [1, 2, 3, 5, 10, 20];

import { tradingPairRegistry } from '../services/market/TradingPairRegistry';
import { PriceAlertModal } from '../components/alerts/PriceAlertModal';

export function Futures({ onNavigate }: { onNavigate?: (tab: string, symbol?: string) => void }) {
  const { user } = useAuth();
  const accountId = user?.futuresAccountId || user?.id || 'demo-user-1';
  const { data: markets, loading } = useFuturesMarketData();
  const { balances } = useLedger(accountId);
  
  const { selectedSymbol, setSelectedSymbol } = useSelectedSymbol();
  const ticker = useTicker(selectedSymbol) as any;
  const [showPairs, setShowPairs] = useState(false);
  const [showAlerts, setShowAlerts] = useState(false);

  useEffect(() => {
    const updateCountdown = () => {
      const timeUntil = futuresFundingService.getTimeUntilNextFunding();
      if (timeUntil <= 0) {
         setNextFundingStr('00:00:00');
      } else {
         const h = Math.floor(timeUntil / (1000 * 60 * 60)).toString().padStart(2, '0');
         const m = Math.floor((timeUntil % (1000 * 60 * 60)) / (1000 * 60)).toString().padStart(2, '0');
         const s = Math.floor((timeUntil % (1000 * 60)) / 1000).toString().padStart(2, '0');
         setNextFundingStr(`${h}:${m}:${s}`);
      }
    };
    
    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    
    const unsub = futuresFundingService.subscribe(() => {
       setFundingRate(futuresFundingService.getFundingRate());
    });
    
    return () => {
       clearInterval(interval);
       unsub();
    };
  }, []);
  
  const [marginMode, setMarginMode] = useState<MarginMode>('ISOLATED');
  const [leverage, setLeverage] = useState<number>(10);
  const [orderSide, setOrderSide] = useState<'LONG' | 'SHORT'>('LONG');
  const [orderType, setOrderType] = useState<FuturesOrderType>('LIMIT');
  
  const [priceInput, setPriceInput] = useState('');
  const [triggerPriceInput, setTriggerPriceInput] = useState('');
  const [quantityInput, setQuantityInput] = useState('');
  const [sliderPercentage, setSliderPercentage] = useState(0);

  const [actionPositionId, setActionPositionId] = useState<string | null>(null);
  const [positionAction, setPositionAction] = useState<'CLOSE' | 'ADD_MARGIN' | 'REMOVE_MARGIN' | null>(null);
  const [closeType, setCloseType] = useState<'MARKET'|'LIMIT'>('MARKET');
  const [closePrice, setClosePrice] = useState('');
  const [closeQuantity, setCloseQuantity] = useState('');
  const [marginAmount, setMarginAmount] = useState('');
  const [historyTab, setHistoryTab] = useState<'positions' | 'open' | 'history' | 'trades' | 'funding' | 'fees'>('positions');
  const [positions, setPositions] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [trades, setTrades] = useState<any[]>([]);
  const [nextFundingStr, setNextFundingStr] = useState<string>('');
  const [fundingRate, setFundingRate] = useState<string>(futuresFundingService.getFundingRate());
  
  const [orderFeedback, setOrderFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);
  const [cancellingIds, setCancellingIds] = useState<Record<string, boolean>>({});
  const cancellingIdsRef = useRef<Set<string>>(new Set());
  const [isClosingPosition, setIsClosingPosition] = useState(false);
  const isClosingPositionRef = useRef(false);
  const [isUpdatingMargin, setIsUpdatingMargin] = useState(false);
  const isUpdatingMarginRef = useRef(false);
  

  const market = markets.find(m => m.symbol === selectedSymbol) || markets[0];
  const availMargin = parseFloat(balances['USDT'] || '0');

  useEffect(() => {
    const updateData = () => {
      setPositions(futuresOrderService.getPositions(accountId));
      setOrders(futuresOrderService.getOrders(accountId));
      setTrades(futuresOrderService.getTrades(accountId));
    };
    updateData();
    futuresOrderService.fetchPositionsFromBackend(accountId);
    futuresOrderService.fetchOrdersFromBackend(accountId);

    const unsub = futuresOrderService.subscribe(updateData);
    const unsubWsPositions = wsClient.subscribe('user:positions', () => {
      futuresOrderService.fetchPositionsFromBackend(accountId);
    });
    const unsubWsOrders = wsClient.subscribe('user:orders', () => {
      futuresOrderService.fetchOrdersFromBackend(accountId);
    });

    return () => {
      unsub();
      unsubWsPositions();
      unsubWsOrders();
    };
  }, [accountId]);
  
  const handleClosePosition = async (pos: any, quantity: string) => {
    try {
      setModalError(null);
      await futuresOrderService.placeOrder({
        accountId,
        symbol: pos.symbol,
        side: pos.side === 'LONG' ? 'SELL' : 'BUY',
        positionSide: pos.side,
        type: 'MARKET',
        quantity: quantity,
        leverage: pos.leverage,
        marginMode: pos.marginMode
      });
      setOrderFeedback({ type: 'success', text: 'Position closed successfully' });
    } catch (e: any) {
      setModalError(e.message || 'Failed to close position');
    }
  };

  const handleCancelFuturesOrder = async (orderId: string) => {
    if (cancellingIdsRef.current.has(orderId)) return;
    cancellingIdsRef.current.add(orderId);
    setCancellingIds(prev => ({ ...prev, [orderId]: true }));
    try {
      await futuresOrderService.cancelOrder(orderId);
      setOrders(futuresOrderService.getOrders(user?.id || 'demo-user-1'));
    } catch (err: any) {
      console.error('Failed to cancel futures order', err);
    } finally {
      cancellingIdsRef.current.delete(orderId);
      setCancellingIds(prev => {
        const next = { ...prev };
        delete next[orderId];
        return next;
      });
    }
  };

  useEffect(() => {
    setPriceInput('');
    setQuantityInput('');
    setSliderPercentage(0);
  }, [selectedSymbol, orderType]);

  useEffect(() => {
    // If the slider is actively controlling the quantity, re-calculate when inputs change.
    if (sliderPercentage > 0) {
       const activePrice = parseFloat((orderType === 'LIMIT' && priceInput) ? priceInput : ticker?.lastPrice || market?.lastPrice || '0');
       if (activePrice > 0) {
           const allocatedMargin = availMargin * (sliderPercentage / 100);
           const targetNotional = allocatedMargin * leverage;
           const qty = targetNotional / activePrice;
           setQuantityInput(parseFloat(qty.toFixed(market?.quantityPrecision || 3)).toString());
       }
    }
  }, [sliderPercentage, leverage, availMargin, priceInput, orderType, market]);



  const [liveOrderBook, setLiveOrderBook] = useState<OrderBook | null>(null);

  useEffect(() => {
    const unsub = wsClient.subscribe(`orderbook:${selectedSymbol}`, (data: any) => {
      if (data && (data.bids || data.asks)) {
        setLiveOrderBook(OrderBookService.fromBackendOrderBook(data.bids, data.asks));
      }
    });
    return () => { unsub(); };
  }, [selectedSymbol]);

  const orderBook = useMemo(() => {
    if (liveOrderBook) return liveOrderBook;
    if (!market) return { bids: [], asks: [] };
    return OrderBookService.generateSimulatedBook(market.baseAsset, parseFloat(market.lastPrice || market.markPrice || '0'), 8, parseFloat(market.tickSize || '0.001'));
  }, [liveOrderBook, market]);

  const maxTotal = useMemo(() => {
    const maxAsk = orderBook.asks.length > 0 ? orderBook.asks[0].total : 0;
    const maxBid = orderBook.bids.length > 0 ? orderBook.bids[orderBook.bids.length - 1].total : 0;
    return Math.max(maxAsk, maxBid, 1);
  }, [orderBook]);

  
  const [isSwitching, setIsSwitching] = useState(false);
  useEffect(() => {
    setIsSwitching(true);
    const t = setTimeout(() => setIsSwitching(false), 100);
    return () => clearTimeout(t);
  }, [selectedSymbol]);
  if (!market || isSwitching) {
    return <div className="flex items-center justify-center min-h-screen text-gray-500">Loading {selectedSymbol}...</div>;
  }
  if (!market) {
    return <div className="flex items-center justify-center min-h-screen text-gray-500">Loading futures markets...</div>;
  }

  const isPositive = parseFloat(ticker?.priceChangePercent || market.change24h || '0') >= 0;


  const activePrice = parseFloat((orderType === 'LIMIT' && priceInput) ? priceInput : ticker?.lastPrice || market.lastPrice || '0');
  const maxNotional = availMargin * leverage;
  const maxQuantity = activePrice > 0 ? maxNotional / activePrice : 0;
  
  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value);
    setSliderPercentage(val);
    if (val === 0) {
       setQuantityInput('');
       return;
    }
    const allocatedMargin = availMargin * (val / 100);
    const targetNotional = allocatedMargin * leverage;
    if (activePrice > 0) {
       const qty = targetNotional / activePrice;
       // Format to precision but strip trailing zeros dynamically
       let qtyStr = qty.toFixed(market.quantityPrecision);
       // Remove trailing zeros and dot if needed (or just use parseFloat to string)
       setQuantityInput(parseFloat(qtyStr).toString());
    }
  };
  
  const handleQuantityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
     setQuantityInput(e.target.value);
     const qty = parseFloat(e.target.value);
     if (qty > 0 && maxQuantity > 0) {
        let pct = (qty / maxQuantity) * 100;
        if (pct > 100) pct = 100;
        setSliderPercentage(Math.round(pct));
     } else {
        setSliderPercentage(0);
     }
  };

  const calculatedMargin = activePrice > 0 && parseFloat(quantityInput || '0') > 0
    ? (parseFloat(quantityInput) * activePrice) / leverage
    : 0;
  
  const estimatedFeeResult = (parseFloat(quantityInput || '0') > 0 && activePrice > 0)
    ? futuresFeeService.getEstimatedFee(quantityInput, activePrice.toString(), orderType)
    : null;

  const handleAction = async () => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    try {
      setOrderFeedback(null);
      await futuresOrderService.placeOrder({
        accountId,
        symbol: selectedSymbol,
        side: orderSide === 'LONG' ? 'BUY' : 'SELL',
        positionSide: orderSide,
        type: orderType,
        price: orderType === 'LIMIT' ? priceInput : undefined,
        stopPrice: orderType === 'STOP_MARKET' ? triggerPriceInput : undefined,
        quantity: quantityInput,
        leverage: leverage,
        marginMode: marginMode,
      });
      setOrderFeedback({ type: 'success', text: `Order placed successfully (${orderSide} ${quantityInput})` });
      setQuantityInput('');
      setTriggerPriceInput('');

    } catch (e: any) {
      setOrderFeedback({ type: 'error', text: e.message || 'Order failed' });
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-gray-950 pb-20 relative">
      {/* Header Bar */}
      <div className="px-4 py-3 flex flex-col gap-3 border-b border-gray-800/80 bg-gray-950/95 sticky top-0 z-30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 relative">
            <button 
              type="button"
              className="flex items-center gap-1.5 p-1 rounded-xl hover:bg-gray-850 transition-colors cursor-pointer group"
              onClick={() => setShowPairs(!showPairs)}
            >
              <h1 className="text-base md:text-lg font-black text-white flex items-center gap-1">
                <span>{market.symbol}</span>
                <ChevronDown size={15} className="text-gray-400 group-hover:text-cyan-400 transition-colors" />
              </h1>
            </button>
            <span className="text-[10px] font-black bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 px-1.5 py-0.5 rounded uppercase">
              PERP
            </span>
            
            {/* Margin Mode & Leverage Capsule */}
            <div className="flex items-center gap-1 bg-gray-900 border border-gray-800 rounded-lg p-0.5 text-xs font-mono font-bold">
              <button 
                type="button"
                onClick={() => setMarginMode(marginMode === 'ISOLATED' ? 'CROSS' : 'ISOLATED')}
                className="px-1.5 py-0.5 rounded text-gray-300 hover:text-white"
              >
                {marginMode}
              </button>
              <span className="text-gray-600">|</span>
              <span className="px-1.5 py-0.5 text-cyan-400">{leverage}x</span>
            </div>

            <MarketSelector 
              isOpen={showPairs} 
              onClose={() => setShowPairs(false)} 
              onSelect={(symbol) => { 
                const pair = tradingPairRegistry.getPair(symbol); 
                if (pair?.marketType === 'SPOT') { 
                  if (onNavigate) onNavigate('trade', symbol); 
                } else { 
                  setSelectedSymbol(symbol); 
                } 
                setShowPairs(false); 
              }} 
            />
          </div>

          <div className="flex items-center gap-2">
            <button 
              type="button"
              aria-label="Price Alert"
              onClick={() => setShowAlerts(true)} 
              className="w-8 h-8 rounded-xl bg-gray-900 border border-gray-800 flex items-center justify-center text-gray-400 hover:text-white transition-colors cursor-pointer"
            >
              <Bell size={16} />
            </button>
            <span className="text-[10px] font-black text-amber-400 px-2 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20 uppercase tracking-wider">
              DEMO
            </span>
          </div>
        </div>

        {/* Live Metrics Ribbon */}
        <div className="flex justify-between items-center text-xs">
          <div>
            <div className={`text-xl font-black font-mono tracking-tight ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
              {parseFloat(ticker?.lastPrice || market.lastPrice || '0').toLocaleString(undefined, { minimumFractionDigits: market.quantityPrecision, maximumFractionDigits: market.quantityPrecision > 4 ? market.quantityPrecision : 4 })}
            </div>
            <div className={`text-[11px] font-mono font-bold flex items-center gap-0.5 ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
              {isPositive ? '+' : ''}{parseFloat(market.change24h).toFixed(2)}%
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-right text-[10px] font-mono">
            <div className="text-gray-500 font-sans">Index Price</div>
            <div className="text-gray-300 font-bold">${parseFloat(market.indexPrice || '0').toFixed(2)}</div>
            <div className="text-gray-500 font-sans">Mark Price</div>
            <div className="text-cyan-400 font-bold">${parseFloat(market.markPrice || '0').toFixed(2)}</div>
            <div className="text-gray-500 font-sans">Funding Rate</div>
            <div className="text-amber-400 font-bold">
              {Number(fundingRate) > 0 ? '+' : ''}{(Number(fundingRate) * 100).toFixed(4)}%
            </div>
            <div className="text-gray-500 font-sans">Next Funding</div>
            <div className="text-amber-300 font-bold">{nextFundingStr}</div>
          </div>
        </div>
      </div>

      {/* Candlestick Chart */}
      <div className="h-60 border-b border-gray-800/80 bg-gray-950">
        <FuturesChart market={market} />
      </div>

      {/* Terminal Main Workspace */}
      <div className="flex flex-1 px-4 py-4 gap-4">
        {/* Left Column: Order Ticket */}
        <div className="w-[58%] flex flex-col pr-1">
          {/* Margin Mode & Leverage Controls */}
          <div className="flex gap-2 mb-2.5">
            <div className="flex flex-1 bg-gray-950 p-0.5 border border-gray-800 rounded-xl">
              <button 
                type="button"
                className={`flex-1 py-1 text-[11px] font-black rounded-lg transition-all cursor-pointer ${marginMode === 'ISOLATED' ? 'bg-gray-800 text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}
                onClick={() => setMarginMode('ISOLATED')}
              >
                ISOLATED
              </button>
              <button 
                type="button"
                className={`flex-1 py-1 text-[11px] font-black rounded-lg transition-all cursor-pointer ${marginMode === 'CROSS' ? 'bg-gray-800 text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}
                onClick={() => setMarginMode('CROSS')}
              >
                CROSS
              </button>
            </div>

            <div className="flex gap-1 overflow-x-auto hide-scrollbar">
              {LEVERAGE_OPTIONS.map(lev => (
                <button 
                  key={lev}
                  type="button"
                  className={`px-2 py-1 rounded-xl text-[10px] font-mono font-bold transition-all cursor-pointer border ${leverage === lev ? 'bg-cyan-500/20 border-cyan-500/40 text-cyan-400 shadow-sm' : 'bg-gray-900 border-gray-800 text-gray-400 hover:text-gray-200'}`}
                  onClick={() => setLeverage(lev)}
                >
                  {lev}x
                </button>
              ))}
            </div>
          </div>

          {/* Long / Short Switcher */}
          <div className="flex bg-gray-950 p-1 border border-gray-800 rounded-xl mb-3">
            <button
              type="button"
              className={`flex-1 py-2 text-xs font-black rounded-lg transition-all cursor-pointer ${
                orderSide === 'LONG' ? 'bg-emerald-500 text-gray-950 shadow-md shadow-emerald-500/20' : 'text-gray-400 hover:text-gray-200'
              }`}
              onClick={() => setOrderSide('LONG')}
            >
              OPEN LONG
            </button>
            <button
              type="button"
              className={`flex-1 py-2 text-xs font-black rounded-lg transition-all cursor-pointer ${
                orderSide === 'SHORT' ? 'bg-red-500 text-white shadow-md shadow-red-500/20' : 'text-gray-400 hover:text-gray-200'
              }`}
              onClick={() => setOrderSide('SHORT')}
            >
              OPEN SHORT
            </button>
          </div>

          {/* Order Type Tabs */}
          <div className="flex items-center gap-1.5 mb-3">
            {(['LIMIT', 'MARKET', 'STOP_MARKET'] as const).map(type => (
              <button 
                key={type}
                type="button"
                className={`px-2.5 py-1 rounded-lg text-xs font-extrabold transition-all cursor-pointer ${
                  orderType === type 
                    ? 'bg-gray-800 text-white border border-gray-700' 
                    : 'text-gray-500 hover:text-gray-300'
                }`} 
                onClick={() => setOrderType(type)}
              >
                {type === 'LIMIT' ? 'Limit' : type === 'MARKET' ? 'Market' : 'Stop-Market'}
              </button>
            ))}
          </div>

          {orderType === 'STOP_MARKET' && (
            <div className="mb-2">
              <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider block mb-1">Trigger Price</label>
              <div className="bg-gray-950 border border-gray-800 focus-within:border-cyan-500/80 focus-within:ring-1 focus-within:ring-cyan-500/30 transition-all rounded-xl flex items-center px-3 py-2">
                <input 
                  type="number" 
                  className="bg-transparent flex-1 w-full text-white text-sm font-mono font-bold focus:outline-none tabular-nums"
                  placeholder="Trigger Price"
                  value={triggerPriceInput}
                  onChange={e => setTriggerPriceInput(e.target.value)}
                />
                <span className="text-gray-400 text-xs font-bold font-mono ml-2">USDT</span>
              </div>
            </div>
          )}

          {orderType === 'LIMIT' && (
            <div className="mb-2">
              <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider block mb-1">Order Price</label>
              <div className="bg-gray-950 border border-gray-800 focus-within:border-cyan-500/80 focus-within:ring-1 focus-within:ring-cyan-500/30 transition-all rounded-xl flex items-center px-3 py-2">
                <input 
                  type="number" 
                  className="bg-transparent flex-1 w-full text-white text-sm font-mono font-bold focus:outline-none tabular-nums"
                  placeholder="Price"
                  value={priceInput}
                  onChange={e => setPriceInput(e.target.value)}
                />
                <span className="text-gray-400 text-xs font-bold font-mono ml-2">USDT</span>
              </div>
            </div>
          )}

          {(orderType === 'MARKET' || orderType === 'STOP_MARKET') && (
            <div className="bg-gray-950/60 border border-gray-850 rounded-xl flex items-center px-3 py-2 mb-2 text-xs font-bold text-gray-400">
              <span className="flex-1">Execution Mode: Market Best Available</span>
              <span className="text-gray-500 font-mono">USDT</span>
            </div>
          )}

          {/* Contract Quantity Input */}
          <div className="bg-gray-950 border border-gray-800 focus-within:border-cyan-500/80 focus-within:ring-1 focus-within:ring-cyan-500/30 transition-all rounded-xl flex flex-col px-3 py-2 mb-2">
            <div className="flex items-center">
              <input 
                type="number" 
                className="bg-transparent flex-1 w-full text-white text-sm font-mono font-bold focus:outline-none tabular-nums"
                placeholder="Quantity"
                value={quantityInput}
                onChange={handleQuantityChange}
              />
              <span className="text-gray-400 text-xs font-bold font-mono ml-2">{market.baseAsset}</span>
            </div>
            <div className="flex items-center justify-between mt-2 border-t border-gray-850/80 pt-1.5 text-xs font-mono">
              <span className="text-gray-500 font-sans text-[11px]">Required Margin</span>
              <span className="text-cyan-400 font-bold tabular-nums">
                {calculatedMargin.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT
              </span>
            </div>
          </div>
          
          {/* Percentage Fast Stepper */}
          <div className="px-1 mb-4 relative mt-2">
            <input 
              type="range" 
              min="0" max="100" step="1"
              value={sliderPercentage}
              onChange={handleSliderChange}
              className="w-full h-1.5 bg-gray-850 rounded-lg appearance-none cursor-pointer accent-cyan-400"
            />
            <div className="flex justify-between text-[10px] text-gray-500 font-mono font-bold mt-1">
              <span className={sliderPercentage >= 0 ? "text-cyan-400" : ""}>0%</span>
              <span className={sliderPercentage >= 25 ? "text-cyan-400" : ""}>25%</span>
              <span className={sliderPercentage >= 50 ? "text-cyan-400" : ""}>50%</span>
              <span className={sliderPercentage >= 75 ? "text-cyan-400" : ""}>75%</span>
              <span className={sliderPercentage >= 100 ? "text-cyan-400" : ""}>100%</span>
            </div>
          </div>
          
          {/* Position & Risk Specs */}
          <div className="space-y-1 mb-4 text-[11px] font-mono">
            <div className="flex justify-between text-gray-500 font-sans">
              <span>Max Tradable Qty</span>
              <span className="text-gray-300 font-mono">{maxQuantity.toLocaleString(undefined, { maximumFractionDigits: market.quantityPrecision })} {market.baseAsset}</span>
            </div>
            <div className="flex justify-between text-gray-500 font-sans">
              <span>Available Margin</span>
              <span className="text-white font-mono font-bold">{availMargin.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT</span>
            </div>
            <div className="flex justify-between text-gray-500 font-sans">
              <span>Position Notional</span>
              <span className="text-gray-300 font-mono">{estimatedFeeResult ? Number(estimatedFeeResult.notional).toFixed(2) : '0.00'} USDT</span>
            </div>
            <div className="flex justify-between text-gray-500 font-sans">
              <span>Est. Trading Fee</span>
              <span className="text-gray-400 font-mono">{estimatedFeeResult ? Number(estimatedFeeResult.feeAmount).toFixed(4) : '0.0000'} USDT</span>
            </div>
          </div>

          <Button 
            variant={orderSide === 'LONG' ? 'buy' : 'sell'}
            fullWidth
            isLoading={isSubmitting}
            onClick={handleAction}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Processing...' : (orderSide === 'LONG' ? 'Buy / Long' : 'Sell / Short')}
          </Button>


          {orderFeedback && (
            <div className={`mt-2.5 p-2.5 rounded-xl text-xs font-bold border ${
              orderFeedback.type === 'success' 
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' 
                : 'bg-red-500/10 border-red-500/30 text-red-400'
            }`}>
              {orderFeedback.text}
            </div>
          )}
        </div>

        {/* Right Column: Order Book */}
        <div className="w-[42%] flex flex-col justify-between text-[10px] font-mono border-l border-gray-850 pl-3 relative">
          <div className="flex justify-between text-gray-500 mb-1.5 px-1 font-bold text-[10px] uppercase font-sans">
            <span>Price</span>
            <span>Qty</span>
          </div>

          {/* Asks (Sell Orders) */}
          <div className="flex flex-col gap-[1.5px] mb-2 flex-1 justify-end">
            {orderBook.asks.slice(-7).map((ask, i) => (
              <div 
                key={`ask-${i}`} 
                className="flex justify-between relative text-red-400 py-[2px] px-1 rounded hover:bg-gray-850/60 transition-colors cursor-pointer"
                onClick={() => { if (orderType === 'LIMIT') setPriceInput(ask.price.toFixed(market.quantityPrecision)); }}
              >
                <div className="absolute right-0 top-0 bottom-0 bg-red-500/15 rounded-r z-0" style={{ width: `${(ask.total / maxTotal) * 100}%` }}></div>
                <span className="z-10 relative font-bold tabular-nums">{ask.price.toLocaleString(undefined, { minimumFractionDigits: market.quantityPrecision, maximumFractionDigits: market.quantityPrecision })}</span>
                <span className="text-gray-400 z-10 relative tabular-nums">{ask.quantity.toLocaleString(undefined, { maximumFractionDigits: 3 })}</span>
              </div>
            ))}
          </div>

          {/* Mid Market Price */}
          <div 
            className="py-2.5 px-1.5 bg-gray-950 border-y border-gray-850 my-1 flex flex-col items-center justify-center cursor-pointer rounded-lg hover:border-cyan-500/40 transition-all" 
            onClick={() => { if (orderType === 'LIMIT') setPriceInput(market.lastPrice); }}
          >
            <div className="flex items-center gap-1">
              <span className={`text-sm font-black tabular-nums ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
                {parseFloat(market.lastPrice).toLocaleString(undefined, { minimumFractionDigits: market.quantityPrecision, maximumFractionDigits: market.quantityPrecision })}
              </span>
              {isPositive ? <ArrowUpRight size={14} className="text-emerald-400" /> : <ArrowDownRight size={14} className="text-red-400" />}
            </div>
            <span className="text-gray-500 text-[10px] font-mono">≈ ${parseFloat(market.indexPrice).toFixed(2)}</span>
          </div>

          {/* Bids (Buy Orders) */}
          <div className="flex flex-col gap-[1.5px] flex-1">
            {orderBook.bids.slice(0, 7).map((bid, i) => (
              <div 
                key={`bid-${i}`} 
                className="flex justify-between relative text-emerald-400 py-[2px] px-1 rounded hover:bg-gray-850/60 transition-colors cursor-pointer"
                onClick={() => { if (orderType === 'LIMIT') setPriceInput(bid.price.toFixed(market.quantityPrecision)); }}
              >
                <div className="absolute right-0 top-0 bottom-0 bg-emerald-500/15 rounded-r z-0" style={{ width: `${(bid.total / maxTotal) * 100}%` }}></div>
                <span className="z-10 relative font-bold tabular-nums">{bid.price.toLocaleString(undefined, { minimumFractionDigits: market.quantityPrecision, maximumFractionDigits: market.quantityPrecision })}</span>
                <span className="text-gray-400 z-10 relative tabular-nums">{bid.quantity.toLocaleString(undefined, { maximumFractionDigits: 3 })}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Futures Positions & Records Tabs */}
      <div className="px-4 mt-2">
        <div className="flex gap-4 border-b border-gray-800/80 mb-3 overflow-x-auto hide-scrollbar whitespace-nowrap">
          <button 
            type="button"
            className={`pb-2.5 text-xs font-black transition-all cursor-pointer ${historyTab === 'positions' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-gray-400 hover:text-gray-200'}`} 
            onClick={() => setHistoryTab('positions')}
          >
            Positions ({positions.filter(p => p.status === 'OPEN' && parseFloat(p.quantity) > 0).length})
          </button>
          <button 
            type="button"
            className={`pb-2.5 text-xs font-black transition-all cursor-pointer ${historyTab === 'open' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-gray-400 hover:text-gray-200'}`} 
            onClick={() => setHistoryTab('open')}
          >
            Open Orders
          </button>
          <button 
            type="button"
            className={`pb-2.5 text-xs font-black transition-all cursor-pointer ${historyTab === 'history' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-gray-400 hover:text-gray-200'}`} 
            onClick={() => setHistoryTab('history')}
          >
            Order History
          </button>
          <button 
            type="button"
            className={`pb-2.5 text-xs font-black transition-all cursor-pointer ${historyTab === 'trades' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-gray-400 hover:text-gray-200'}`} 
            onClick={() => setHistoryTab('trades')}
          >
            Trade History
          </button>
          <button 
            type="button"
            className={`pb-2.5 text-xs font-black transition-all cursor-pointer ${historyTab === 'funding' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-gray-400 hover:text-gray-200'}`} 
            onClick={() => setHistoryTab('funding')}
          >
            Funding
          </button>
          <button 
            type="button"
            className={`pb-2.5 text-xs font-black transition-all cursor-pointer ${historyTab === 'fees' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-gray-400 hover:text-gray-200'}`} 
            onClick={() => setHistoryTab('fees')}
          >
            Fees
          </button>
        </div>

        <div className="flex flex-col gap-2.5">
            {historyTab === 'positions' && positions.filter(p => p.status === 'OPEN' && parseFloat(p.quantity) > 0 && p.symbol === selectedSymbol).map(pos => {
              const currentMarket = markets.find(m => m.symbol === pos.symbol) || market;
              const liveMarkPrice = currentMarket?.markPrice || pos.markPrice;
              const liveUpnl = futuresRiskService.calculateUnrealizedPnl(pos, liveMarkPrice);
              const liveRoe = futuresRiskService.calculateRoe(liveUpnl, pos.initialMargin);
              const isPnlPositive = parseFloat(liveUpnl) >= 0;
              
              return (
              <div key={pos.positionId} className="bg-gray-900/90 p-4 rounded-2xl flex flex-col gap-3 border border-gray-800/80 shadow-md">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <span className={`font-black text-sm ${pos.side === 'LONG' ? 'text-emerald-400' : 'text-red-400'}`}>{pos.symbol}</span>
                    <span className={`text-[10px] font-black px-1.5 py-0.5 rounded ${pos.side === 'LONG' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-red-500/20 text-red-400 border border-red-500/30'}`}>
                      {pos.side} {pos.leverage}x
                    </span>
                  </div>
                  <span className="text-gray-400 font-mono text-xs font-bold">Margin: ${parseFloat(pos.initialMargin).toFixed(2)}</span>
                </div>
                
                <div className="grid grid-cols-3 gap-2 text-xs font-mono">
                  <div className="flex flex-col">
                    <span className="text-gray-500 text-[10px] font-sans">Position Size</span>
                    <span className="text-white font-bold">{pos.quantity}</span>
                  </div>
                  <div className="flex flex-col text-center">
                    <span className="text-gray-500 text-[10px] font-sans">Entry Price</span>
                    <span className="text-white font-bold">${parseFloat(pos.entryPrice).toFixed(2)}</span>
                  </div>
                  <div className="flex flex-col text-right">
                    <span className="text-gray-500 text-[10px] font-sans">Mark Price</span>
                    <span className="text-cyan-400 font-bold">${parseFloat(liveMarkPrice).toFixed(2)}</span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs font-mono pt-1 border-t border-gray-800/60">
                   <div className="flex flex-col">
                      <span className="text-gray-500 text-[10px] font-sans">Est. Liq. Price</span>
                      <span className="text-amber-400 font-black">${parseFloat(pos.liquidationPrice).toFixed(2)}</span>
                   </div>
                   <div className="flex flex-col text-right">
                      <span className="text-gray-500 text-[10px] font-sans">Unrealized PnL (ROE%)</span>
                      <span className={`font-black ${isPnlPositive ? 'text-emerald-400' : 'text-red-400'}`}>
                         {isPnlPositive ? '+' : ''}${parseFloat(liveUpnl).toFixed(2)} ({liveRoe === 'Infinity' || isNaN(parseFloat(liveRoe)) ? '--' : parseFloat(liveRoe).toFixed(2)}%)
                      </span>
                   </div>
                </div>

                <div className="flex justify-end gap-2 mt-1">
                  <Button size="sm" variant="outline" className="text-xs py-1 h-8 rounded-lg" onClick={() => { setActionPositionId(pos.positionId); setPositionAction('ADD_MARGIN'); }}>Add Margin</Button>
                  <Button size="sm" variant="outline" className="text-xs py-1 h-8 rounded-lg" onClick={() => { setActionPositionId(pos.positionId); setPositionAction('REMOVE_MARGIN'); }}>Rem Margin</Button>
                  <Button size="sm" variant="danger" className="text-xs py-1 h-8 rounded-lg font-bold" onClick={() => { setActionPositionId(pos.positionId); setPositionAction('CLOSE'); setCloseQuantity(pos.quantity); setClosePrice(currentMarket?.lastPrice || ''); }}>Close Position</Button>
                </div>
              </div>
            )})}
            
            {historyTab === 'open' && orders.filter(o => (o.status === 'NEW' || o.status === 'PENDING') && o.symbol === selectedSymbol).map(o => (
               <div key={o.id} className="bg-gray-900 p-3 rounded-lg flex flex-col gap-2 border border-gray-800 text-xs text-gray-300">
                  <div className="flex justify-between">
                     <span className="font-bold text-white">{o.symbol}</span>
                     <span>{o.side} {o.type}</span>
                  </div>
                  <div className="flex justify-between">
                     <span>Price: {o.price || 'Market'}</span>
                     <span>Qty: {o.quantity}</span>
                  </div>
                  <div className="flex justify-between">
                     <span>Status: {o.status}</span>
                     <Button 
                       size="sm" 
                       variant="outline" 
                       className="text-[10px] py-0 h-5" 
                       disabled={!!cancellingIds[o.id]}
                       onClick={() => handleCancelFuturesOrder(o.id)}
                     >
                       {cancellingIds[o.id] ? 'Cancelling...' : 'Cancel'}
                     </Button>
                  </div>
               </div>
            ))}

            {historyTab === 'history' && <OrderHistory />}

            {historyTab === 'trades' && <TradeHistory />}

            {historyTab === 'funding' && futuresFundingService.getHistory(user?.id || 'demo-user-1').filter(f => f.symbol === selectedSymbol).map(f => (
               <div key={f.id} className="bg-gray-900 p-3 rounded-lg flex flex-col gap-2 border border-gray-800 text-xs text-gray-300">
                  <div className="flex justify-between">
                     <span className="font-bold text-white">{f.symbol} {f.side}</span>
                     <span>Rate: {(parseFloat(f.fundingRate) * 100).toFixed(4)}%</span>
                  </div>
                  <div className="flex justify-between">
                     <span>{f.payerReceiver === 'RECEIVER' ? 'Received' : 'Paid'}</span>
                     <span className={f.payerReceiver === 'RECEIVER' ? 'text-emerald-500' : 'text-red-500'}>{parseFloat(f.fundingAmount).toFixed(4)} USDT</span>
                  </div>
               </div>
            ))}

            {historyTab === 'fees' && trades.filter(t => parseFloat(t.fee) > 0 && t.symbol === selectedSymbol).map(t => (
               <div key={t.id + '_fee'} className="bg-gray-900 p-3 rounded-lg flex flex-col gap-2 border border-gray-800 text-xs text-gray-300">
                  <div className="flex justify-between">
                     <span className="font-bold text-white">{t.symbol}</span>
                     <span>Role: {t.feeType}</span>
                  </div>
                  <div className="flex justify-between">
                     <span>Fee:</span>
                     <span className="text-gray-300">{parseFloat(t.fee).toFixed(4)} USDT</span>
                  </div>
               </div>
            ))}

          </div>
        </div>

      {actionPositionId && positionAction === 'CLOSE' && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 rounded-xl p-4 w-full max-w-sm border border-gray-800">
            <h3 className="text-lg font-bold text-white mb-4">Close Position</h3>
            
            <div className="flex bg-gray-950 p-1 rounded mb-4">
              <button 
                className={`flex-1 py-1 text-xs font-bold rounded ${closeType === 'MARKET' ? 'bg-gray-800 text-white' : 'text-gray-500'}`}
                onClick={() => setCloseType('MARKET')}
              >
                Market
              </button>
              <button 
                className={`flex-1 py-1 text-xs font-bold rounded ${closeType === 'LIMIT' ? 'bg-gray-800 text-white' : 'text-gray-500'}`}
                onClick={() => setCloseType('LIMIT')}
              >
                Limit
              </button>
            </div>
            
            {closeType === 'LIMIT' && (
              <div className="mb-4">
                <label className="block text-xs text-gray-400 mb-1">Price</label>
                <input 
                  type="number" 
                  value={closePrice} 
                  onChange={e => setClosePrice(e.target.value)} 
                  className="w-full bg-gray-950 border border-gray-800 rounded p-2 text-white text-sm"
                />
              </div>
            )}
            
            <div className="mb-6">
              <label className="block text-xs text-gray-400 mb-1">Quantity</label>
              <input 
                type="number" 
                value={closeQuantity} 
                onChange={e => setCloseQuantity(e.target.value)} 
                className="w-full bg-gray-950 border border-gray-800 rounded p-2 text-white text-sm"
              />
            </div>
            
            {modalError && (
              <div className="mb-4 bg-red-500/10 border border-red-500/30 text-red-400 p-2.5 rounded text-xs">
                {modalError}
              </div>
            )}
            
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => { setActionPositionId(null); setModalError(null); }}>Cancel</Button>
              <Button 
                className="flex-1 bg-emerald-600 hover:bg-emerald-500" 
                disabled={isClosingPosition || !closeQuantity || (closeType === 'LIMIT' && !closePrice)}
                onClick={async () => {
                   if (isClosingPositionRef.current) return;
                   isClosingPositionRef.current = true;
                   setIsClosingPosition(true);
                   try {
                     const pos = positions.find(p => p.positionId === actionPositionId);
                     if (pos) {
                        if (closeType === 'MARKET') {
                           await handleClosePosition(pos, closeQuantity);
                        } else {
                           try {
                              setModalError(null);
                              await futuresOrderService.placeOrder({
                                accountId: user?.id || 'demo-user-1',
                                symbol: pos.symbol,
                                side: pos.side === 'LONG' ? 'SELL' : 'BUY',
                                positionSide: pos.side,
                                type: 'LIMIT',
                                price: closePrice,
                                quantity: closeQuantity,
                                leverage: pos.leverage,
                                marginMode: pos.marginMode,
                                reduceOnly: true
                              });
                           } catch (e: any) { setModalError(e.message || 'Failed to place limit close order'); return; }
                        }
                        setActionPositionId(null);
                        setModalError(null);
                        setPositions(futuresOrderService.getPositions(user?.id || 'demo-user-1'));
                     }
                   } finally {
                     isClosingPositionRef.current = false;
                     setIsClosingPosition(false);
                   }
                }}
              >
                {isClosingPosition ? 'Processing...' : 'Confirm'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {actionPositionId && (positionAction === 'ADD_MARGIN' || positionAction === 'REMOVE_MARGIN') && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 rounded-xl p-4 w-full max-w-sm border border-gray-800">
            <h3 className="text-lg font-bold text-white mb-4">{positionAction === 'ADD_MARGIN' ? 'Add Margin' : 'Remove Margin'}</h3>
            
            {modalError && (
              <div className="mb-4 bg-red-500/10 border border-red-500/30 text-red-400 p-2.5 rounded text-xs">
                {modalError}
              </div>
            )}

            <div className="mb-6">
              <label className="block text-xs text-gray-400 mb-1">Amount (USDT)</label>
              <input 
                type="number" 
                value={marginAmount} 
                onChange={e => setMarginAmount(e.target.value)} 
                className="w-full bg-gray-950 border border-gray-800 rounded p-2 text-white text-sm"
              />
            </div>
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => { setActionPositionId(null); setModalError(null); }}>Cancel</Button>
              <Button 
                className="flex-1 bg-emerald-600 hover:bg-emerald-500" 
                disabled={isUpdatingMargin || !marginAmount || Number(marginAmount) <= 0}
                onClick={async () => {
                   if (isUpdatingMarginRef.current) return;
                   isUpdatingMarginRef.current = true;
                   setIsUpdatingMargin(true);
                   try {
                     const pos = positions.find(p => p.positionId === actionPositionId);
                     if (pos) {
                        try {
                            setModalError(null);
                            if (positionAction === 'ADD_MARGIN') {
                                await futuresOrderService.addIsolatedMargin(user?.id || 'demo-user-1', pos.positionId, marginAmount);
                            } else {
                                await futuresOrderService.removeIsolatedMargin(user?.id || 'demo-user-1', pos.positionId, marginAmount);
                            }
                            setActionPositionId(null);
                            setModalError(null);
                            setPositions(futuresOrderService.getPositions(user?.id || 'demo-user-1'));
                        } catch (e: any) {
                            setModalError(e.message || 'Margin update failed');
                        }
                     }
                   } finally {
                     isUpdatingMarginRef.current = false;
                     setIsUpdatingMargin(false);
                   }
                }}
              >
                {isUpdatingMargin ? 'Processing...' : 'Confirm'}
              </Button>
            </div>
          </div>
        </div>
      )}
      <PriceAlertModal isOpen={showAlerts} onClose={() => setShowAlerts(false)} defaultSymbol={selectedSymbol} />
    </div>
  );
}
