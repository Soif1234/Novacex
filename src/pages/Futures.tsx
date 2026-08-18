import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Menu, ChevronDown, Activity, Info, ArrowUpRight, ArrowDownRight, AlertTriangle, Bell } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { useFuturesMarketData } from '../hooks/useFuturesMarketData';
import { useLedger } from '../hooks/useLedger';

import { OrderBookService } from '../services/OrderBookService';
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

const LEVERAGE_OPTIONS = [1, 2, 3, 5, 10, 20];

import { tradingPairRegistry } from '../services/market/TradingPairRegistry';
import { PriceAlertModal } from '../components/alerts/PriceAlertModal';

export function Futures({ onNavigate }: { onNavigate?: (tab: string, symbol?: string) => void }) {
  const { user } = useAuth();
  const { data: markets, loading } = useFuturesMarketData();
  const { balances } = useLedger();
  
  const { selectedSymbol, setSelectedSymbol } = useSelectedSymbol();
  const ticker = useTicker(selectedSymbol) as any;
  const [showPairs, setShowPairs] = useState(false);
  const [showAlerts, setShowAlerts] = useState(false);

  useEffect(() => {
    const updateCountdown = () => {
      const timeUntil = futuresFundingService.getTimeUntilNextFunding();
      if (timeUntil <= 0) {
         setNextFundingStr('00:00:00');
         futuresFundingService.settleFunding(futuresOrderService.getPositions(user?.id || 'demo-user-1'), {});
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

  // Demo TP/SL checker loop
  useEffect(() => {
    const interval = setInterval(() => {
        const markPrices: Record<string, string> = {};
        markets.forEach(m => {
            markPrices[m.symbol] = m.markPrice;
        });
        futuresTpSlService.checkTriggers(
            positions,
            markPrices,
            async (order, price) => {
                await futuresOrderService.placeOrder(order);
                const updatedPositions = futuresOrderService.getPositions(user?.id || 'demo-user-1');
                setPositions(updatedPositions);
            }
        );
    }, 1000);
    return () => clearInterval(interval);
  }, [positions, markets]);
  

  const market = markets.find(m => m.symbol === selectedSymbol) || markets[0];
  const availMargin = parseFloat(balances['USDT'] || '0');

  useEffect(() => {
    const updateData = () => {
      setPositions(futuresOrderService.getPositions(user?.id || 'demo-user-1'));
      setOrders(futuresOrderService.getOrders(user?.id || 'demo-user-1'));
      setTrades(futuresOrderService.getTrades(user?.id || 'demo-user-1'));
    };
    updateData();
    const unsub = futuresOrderService.subscribe(updateData);
    return () => { unsub(); };
  }, []);
  
  const handleClosePosition = async (pos: any, quantity: string) => {
    try {
      setModalError(null);
      await futuresOrderService.placeOrder({
        accountId: user?.id || 'demo-user-1',
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



  const orderBook = useMemo(() => {
    if (!market) return { bids: [], asks: [] };
    return OrderBookService.generateSimulatedBook(market.baseAsset, parseFloat(market.lastPrice || market.markPrice || '0'), 8, parseFloat(market.tickSize || '0.001'));
  }, [market]);

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
        accountId: user?.id || 'demo-user-1',
        symbol: selectedSymbol,
        side: orderSide === 'LONG' ? 'BUY' : 'SELL',
        positionSide: orderSide,
        type: orderType,
        price: priceInput || undefined,
        quantity: quantityInput,
        leverage: leverage,
        marginMode: marginMode,
      });
      setOrderFeedback({ type: 'success', text: `Order placed successfully (${orderSide} ${quantityInput})` });
      setQuantityInput('');
    } catch (e: any) {
      setOrderFeedback({ type: 'error', text: e.message || 'Order failed' });
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-gray-950 pb-20 relative">
      <div className="bg-blue-600/20 text-blue-400 py-1.5 px-4 text-xs font-bold text-center flex items-center justify-center gap-2">
        <AlertTriangle size={14} /> DEMO / PAPER TRADING
      </div>

      <div className="px-4 py-3 flex flex-col gap-3 border-b border-gray-900 bg-gray-950">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 relative">
            <Menu size={20} className="text-gray-400" />
            <button 
              className="text-lg font-bold text-white flex items-center gap-1"
              onClick={() => setShowPairs(!showPairs)}
            >
              {market.symbol} <ChevronDown size={16} className="text-gray-500" />
            </button>
            <span className="text-xs bg-gray-800 text-gray-400 px-1 rounded">Perp</span>
            
            <MarketSelector isOpen={showPairs} onClose={() => setShowPairs(false)} onSelect={(symbol) => { const pair = tradingPairRegistry.getPair(symbol); if (pair?.marketType === 'SPOT') { if (onNavigate) onNavigate('trade', symbol); } else { setSelectedSymbol(symbol); } setShowPairs(false); }} />
        </div>
        <div>
          <button onClick={() => setShowAlerts(true)} className="p-2 text-gray-400 hover:text-white rounded-full hover:bg-gray-800 transition-colors">
            <Bell size={20} />
          </button>
            {false && (
              <div className="absolute top-full left-0 mt-2 w-48 bg-gray-900 border border-gray-800 rounded-lg shadow-xl z-50 overflow-hidden">
                {markets.map(m => (
                  <button
                    key={m.symbol}
                    className={`w-full text-left px-4 py-3 hover:bg-gray-800 flex justify-between items-center ${m.symbol === selectedSymbol ? 'bg-gray-800/50' : ''}`}
                    onClick={() => {
                      setSelectedSymbol(m.symbol);
                      setShowPairs(false);
                    }}
                  >
                    <span className="font-bold text-sm text-gray-200">{m.symbol}</span>
                    <span className={`text-xs ${parseFloat(m.change24h) >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                      {parseFloat(m.change24h) >= 0 ? '+' : ''}{parseFloat(m.change24h).toFixed(2)}%
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-between items-start">
          <div>
            <div className={`text-2xl font-bold ${isPositive ? 'text-emerald-500' : 'text-red-500'}`}>
              {parseFloat(ticker?.lastPrice || market.lastPrice || '0').toLocaleString(undefined, { minimumFractionDigits: market.quantityPrecision, maximumFractionDigits: market.quantityPrecision > 4 ? market.quantityPrecision : 4 })}
            </div>
            <div className={`text-xs font-medium mt-1 ${isPositive ? 'text-emerald-500' : 'text-red-500'}`}>
              {isPositive ? '+' : ''}{parseFloat(market.change24h).toFixed(2)}%
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-right text-[10px]">
            <div className="text-gray-500">24h High</div>
            <div className="text-gray-300">{ticker?.high24h ? parseFloat(ticker.high24h).toLocaleString() : '--'}</div>
            <div className="text-gray-500">24h Low</div>
            <div className="text-gray-300">{ticker?.low24h ? parseFloat(ticker.low24h).toLocaleString() : '--'}</div>
            <div className="text-gray-500">24h Vol</div>
            <div className="text-gray-300">{ticker?.volume24h ? parseFloat(ticker.volume24h).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '--'} {market.baseAsset}</div>
            <div className="text-gray-500 text-yellow-500/80">Funding / Next</div>
            <div className="text-gray-300 text-yellow-500/80">
               {Number(fundingRate) > 0 ? '+' : ''}{(Number(fundingRate) * 100).toFixed(4)}% / {nextFundingStr}
            </div>
          </div>
        </div>
      </div>

      <div className="h-64 border-b border-gray-900 bg-gray-950">
        <FuturesChart market={market} />
      </div>

      <div className="flex flex-1 px-4 py-4 gap-4">
        <div className="w-[60%] flex flex-col pr-2">
          
          <div className="flex gap-2 mb-3">
            <button 
              className={`flex-1 border px-2 py-1.5 rounded text-xs font-bold ${marginMode === 'ISOLATED' ? 'bg-gray-800 border-gray-700 text-white' : 'bg-transparent border-gray-800 text-gray-500 hover:text-gray-300'}`}
              onClick={() => setMarginMode('ISOLATED')}
            >
              ISOLATED
            </button>
            <button 
              className={`flex-1 border px-2 py-1.5 rounded text-xs font-bold ${marginMode === 'CROSS' ? 'bg-gray-800 border-gray-700 text-white' : 'bg-transparent border-gray-800 text-gray-500 hover:text-gray-300'}`}
              onClick={() => setMarginMode('CROSS')}
            >
              CROSS
            </button>
          </div>

          <div className="flex gap-1 overflow-x-auto pb-2 hide-scrollbar mb-2">
            {LEVERAGE_OPTIONS.map(lev => (
              <button 
                key={lev}
                className={`border px-2 py-1 rounded text-[10px] font-bold min-w-8 ${leverage === lev ? 'bg-blue-600 border-blue-500 text-white' : 'bg-gray-900 border-gray-800 text-gray-400 hover:text-gray-200'}`}
                onClick={() => setLeverage(lev)}
              >
                {lev}x
              </button>
            ))}
          </div>

          <div className="flex bg-gray-900 rounded-lg p-1 mb-4">
            <button
              className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all ${
                orderSide === 'LONG' ? 'bg-emerald-500 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'
              }`}
              onClick={() => setOrderSide('LONG')}
            >
              Open Long
            </button>
            <button
              className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all ${
                orderSide === 'SHORT' ? 'bg-red-500 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'
              }`}
              onClick={() => setOrderSide('SHORT')}
            >
              Open Short
            </button>
          </div>

          <div className="flex gap-4 mb-3 text-xs font-bold text-gray-500 border-b border-gray-900 pb-2">
            <button 
              className={orderType === 'LIMIT' ? 'text-white' : 'hover:text-gray-300'} 
              onClick={() => setOrderType('LIMIT')}
            >
              Limit
            </button>
            <button 
              className={orderType === 'MARKET' ? 'text-white' : 'hover:text-gray-300'} 
              onClick={() => setOrderType('MARKET')}
            >
              Market
            </button>
          </div>

          {orderType === 'LIMIT' && (
            <div className="bg-gray-900 border border-gray-800 focus-within:border-gray-600 transition-colors rounded-lg flex items-center px-3 py-2 mb-2">
              <input 
                type="number" 
                className="bg-transparent flex-1 w-full text-gray-100 text-sm font-bold focus:outline-none"
                placeholder="Price"
                value={priceInput}
                onChange={e => setPriceInput(e.target.value)}
              />
              <span className="text-gray-500 text-xs font-medium">USDT</span>
            </div>
          )}

          {orderType === 'MARKET' && (
            <div className="bg-gray-900/50 border border-gray-800 rounded-lg flex items-center px-3 py-2 mb-2 cursor-not-allowed">
              <span className="text-gray-500 text-sm font-bold flex-1">Market Price</span>
              <span className="text-gray-600 text-xs font-medium">USDT</span>
            </div>
          )}

          <div className="bg-gray-900 border border-gray-800 focus-within:border-gray-600 transition-colors rounded-lg flex flex-col px-3 py-2 mb-2">
            <div className="flex items-center">
                <input 
                  type="number" 
                  className="bg-transparent flex-1 w-full text-gray-100 text-sm font-bold focus:outline-none"
                  placeholder={`Quantity`}
                  value={quantityInput}
                  onChange={handleQuantityChange}
                />
                <span className="text-gray-500 text-xs font-medium">{market.baseAsset}</span>
            </div>
            <div className="flex items-center mt-2 border-t border-gray-800 pt-2">
                <span className="text-gray-400 text-xs flex-1">Amount</span>
                <span className="text-gray-200 text-sm font-bold">{calculatedMargin.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                <span className="text-gray-500 text-xs font-medium ml-1">USDT</span>
            </div>
          </div>
          
          <div className="px-2 mb-4 relative mt-3">
             <input 
                type="range" 
                min="0" max="100" step="1"
                value={sliderPercentage}
                onChange={handleSliderChange}
                className="w-full h-1 bg-gray-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
             />
             <div className="flex justify-between text-[9px] text-gray-500 font-bold mt-1">
                 <span className={sliderPercentage >= 0 ? "text-blue-500" : ""}>0%</span>
                 <span className={sliderPercentage >= 25 ? "text-blue-500" : ""}>25%</span>
                 <span className={sliderPercentage >= 50 ? "text-blue-500" : ""}>50%</span>
                 <span className={sliderPercentage >= 75 ? "text-blue-500" : ""}>75%</span>
                 <span className={sliderPercentage >= 100 ? "text-blue-500" : ""}>100%</span>
             </div>
          </div>
          
          <div className="flex justify-between text-[10px] text-gray-500 mb-1 font-medium">
            <span>Max Qty</span>
            <span className="text-gray-300">{maxQuantity.toLocaleString(undefined, { maximumFractionDigits: market.quantityPrecision })} {market.baseAsset}</span>
          </div>

          <div className="flex justify-between text-[10px] text-gray-500 mb-1 font-medium">
            <span>Avail Margin</span>
            <span className="text-gray-200">{availMargin.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT</span>
          </div>
          <div className="flex justify-between text-[10px] text-gray-500 mb-1 font-medium">
            <span>Position Notional</span>
            <span className="text-gray-200">{estimatedFeeResult ? Number(estimatedFeeResult.notional).toFixed(2) : '0.00'} USDT</span>
          </div>
          <div className="flex justify-between text-[10px] text-gray-500 mb-4 font-medium">
            <span>Est. Trading Fee (DEMO)</span>
            <span className="text-gray-200">{estimatedFeeResult ? Number(estimatedFeeResult.feeAmount).toFixed(4) : '0.0000'} USDT ({estimatedFeeResult?.feeType === 'MAKER' ? 'Maker' : 'Taker'})</span>
          </div>

          <Button 
            className={`py-3 shadow-md ${orderSide === 'LONG' ? 'bg-emerald-500 hover:bg-emerald-600' : 'bg-red-500 hover:bg-red-600'}`}
            fullWidth
            onClick={handleAction}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Processing...' : (orderSide === 'LONG' ? 'Buy / Long' : 'Sell / Short')}
          </Button>

          {orderFeedback && (
            <div className={`mt-2 p-2 rounded text-[11px] font-medium border ${
              orderFeedback.type === 'success' 
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' 
                : 'bg-red-500/10 border-red-500/30 text-red-400'
            }`}>
              {orderFeedback.text}
            </div>
          )}

        </div>

        <div className="w-[40%] flex flex-col justify-between text-[10px] border-l border-gray-900 pl-4 relative">
          <div className="flex justify-between text-gray-500 mb-1 px-1">
            <span>Price</span>
            <span>Qty</span>
          </div>
          <div className="flex flex-col gap-[2px] mb-2 flex-1 justify-end">
            {orderBook.asks.map((ask, i) => (
              <div 
                key={`ask-${i}`} 
                className="flex justify-between relative text-red-500 py-[2px] cursor-pointer hover:bg-gray-900/50 px-1"
                onClick={() => { if (orderType === 'LIMIT') setPriceInput(ask.price.toFixed(market.quantityPrecision)); }}
              >
                <div className="absolute right-0 top-0 bottom-0 bg-red-500/10 z-0" style={{ width: `${(ask.total / maxTotal) * 100}%` }}></div>
                <span className="z-10 relative font-medium">{ask.price.toLocaleString(undefined, { minimumFractionDigits: market.quantityPrecision, maximumFractionDigits: market.quantityPrecision })}</span>
                <span className="text-gray-300 z-10 relative">{ask.quantity.toLocaleString(undefined, { maximumFractionDigits: 3 })}</span>
              </div>
            ))}
          </div>

          <div className="py-2 flex flex-col items-center gap-0.5 mb-2 cursor-pointer" onClick={() => { if (orderType === 'LIMIT') setPriceInput(market.lastPrice); }}>
            <div className="flex items-center gap-1">
              <span className={`text-base font-bold ${isPositive ? 'text-emerald-500' : 'text-red-500'}`}>
                {parseFloat(market.lastPrice).toLocaleString(undefined, { minimumFractionDigits: market.quantityPrecision, maximumFractionDigits: market.quantityPrecision })}
              </span>
              {isPositive ? <ArrowUpRight size={14} className="text-emerald-500" /> : <ArrowDownRight size={14} className="text-red-500" />}
            </div>
            <span className="text-gray-500 text-[10px] line-through decoration-gray-700">≈ ${parseFloat(market.indexPrice).toFixed(2)}</span>
          </div>

          <div className="flex flex-col gap-[2px] flex-1">
            {orderBook.bids.map((bid, i) => (
              <div 
                key={`bid-${i}`} 
                className="flex justify-between relative text-emerald-500 py-[2px] cursor-pointer hover:bg-gray-900/50 px-1"
                onClick={() => { if (orderType === 'LIMIT') setPriceInput(bid.price.toFixed(market.quantityPrecision)); }}
              >
                <div className="absolute right-0 top-0 bottom-0 bg-emerald-500/10 z-0" style={{ width: `${(bid.total / maxTotal) * 100}%` }}></div>
                <span className="z-10 relative font-medium">{bid.price.toLocaleString(undefined, { minimumFractionDigits: market.quantityPrecision, maximumFractionDigits: market.quantityPrecision })}</span>
                <span className="text-gray-300 z-10 relative">{bid.quantity.toLocaleString(undefined, { maximumFractionDigits: 3 })}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

              <div className="px-4 mt-2">
          <div className="flex gap-4 border-b border-gray-900 mb-2 overflow-x-auto hide-scrollbar whitespace-nowrap">
            <button className={`pb-2 text-xs font-bold ${historyTab === 'positions' ? 'text-white border-b-2 border-emerald-500' : 'text-gray-500'}`} onClick={() => setHistoryTab('positions')}>Positions</button>
            <button className={`pb-2 text-xs font-bold ${historyTab === 'open' ? 'text-white border-b-2 border-emerald-500' : 'text-gray-500'}`} onClick={() => setHistoryTab('open')}>Open Orders</button>
            <button className={`pb-2 text-xs font-bold ${historyTab === 'history' ? 'text-white border-b-2 border-emerald-500' : 'text-gray-500'}`} onClick={() => setHistoryTab('history')}>Order History</button>
            <button className={`pb-2 text-xs font-bold ${historyTab === 'trades' ? 'text-white border-b-2 border-emerald-500' : 'text-gray-500'}`} onClick={() => setHistoryTab('trades')}>Trade History</button>
            <button className={`pb-2 text-xs font-bold ${historyTab === 'funding' ? 'text-white border-b-2 border-emerald-500' : 'text-gray-500'}`} onClick={() => setHistoryTab('funding')}>Funding</button>
            <button className={`pb-2 text-xs font-bold ${historyTab === 'fees' ? 'text-white border-b-2 border-emerald-500' : 'text-gray-500'}`} onClick={() => setHistoryTab('fees')}>Fees</button>
          </div>

          <div className="flex flex-col gap-2">
            {historyTab === 'positions' && positions.filter(p => p.status === 'OPEN' && parseFloat(p.quantity) > 0 && p.symbol === selectedSymbol).map(pos => {
              const currentMarket = markets.find(m => m.symbol === pos.symbol) || market;
              const liveMarkPrice = currentMarket?.markPrice || pos.markPrice;
              const liveUpnl = futuresRiskService.calculateUnrealizedPnl(pos, liveMarkPrice);
              const liveRoe = futuresRiskService.calculateRoe(liveUpnl, pos.initialMargin);
              const isPnlPositive = parseFloat(liveUpnl) >= 0;
              
              return (
              <div key={pos.positionId} className="bg-gray-900 p-3 rounded-lg flex flex-col gap-2 border border-gray-800">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <span className={`font-bold text-sm ${pos.side === 'LONG' ? 'text-emerald-500' : 'text-red-500'}`}>{pos.symbol}</span>
                    <span className={`text-[10px] font-bold px-1 rounded ${pos.side === 'LONG' ? 'bg-emerald-500/20 text-emerald-500' : 'bg-red-500/20 text-red-500'}`}>{pos.side} {pos.leverage}x</span>
                  </div>
                  <span className="text-gray-400 text-xs">Margin: {parseFloat(pos.initialMargin).toFixed(2)}</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <div className="flex flex-col">
                    <span className="text-gray-500">Size</span>
                    <span className="text-gray-200">{pos.quantity}</span>
                  </div>
                  <div className="flex flex-col text-right">
                    <span className="text-gray-500">Entry Price</span>
                    <span className="text-gray-200">{parseFloat(pos.entryPrice).toFixed(2)}</span>
                  </div>
                  <div className="flex flex-col text-right">
                    <span className="text-gray-500">Mark Price</span>
                    <span className="text-gray-200">{parseFloat(liveMarkPrice).toFixed(2)}</span>
                  </div>
                </div>
                <div className="flex justify-between items-center text-xs">
                   <div className="flex flex-col">
                      <span className="text-gray-500">Liq. Price</span>
                      <span className="text-orange-500">{parseFloat(pos.liquidationPrice).toFixed(2)}</span>
                   </div>
                   <div className="flex flex-col text-right">
                      <span className="text-gray-500">PNL (ROE%)</span>
                      <span className={isPnlPositive ? 'text-emerald-500' : 'text-red-500'}>
                         {parseFloat(liveUpnl).toFixed(2)} ({liveRoe === 'Infinity' || isNaN(parseFloat(liveRoe)) ? '--' : parseFloat(liveRoe).toFixed(2)}%)
                      </span>
                   </div>
                </div>
                <div className="flex justify-between items-center text-xs">
                   <div className="flex flex-col">
                      <span className="text-gray-500">Realized PNL</span>
                      <span className={parseFloat(pos.realizedPnl) >= 0 ? 'text-emerald-500' : 'text-red-500'}>{parseFloat(pos.realizedPnl).toFixed(2)}</span>
                   </div>
                   <div className="flex flex-col text-right">
                      <span className="text-gray-500">Cum. Fee / Funding</span>
                      <span className="text-gray-300">-{parseFloat(pos.cumulativeFee || '0').toFixed(4)} / {parseFloat(pos.cumulativeFunding || '0').toFixed(4)}</span>
                   </div>
                </div>
                <div className="flex justify-end gap-2 mt-2">
                  <Button size="sm" variant="outline" className="text-[10px] py-1 h-auto" onClick={() => { setActionPositionId(pos.positionId); setPositionAction('ADD_MARGIN'); }}>Add Margin</Button>
                  <Button size="sm" variant="outline" className="text-[10px] py-1 h-auto" onClick={() => { setActionPositionId(pos.positionId); setPositionAction('REMOVE_MARGIN'); }}>Rem Margin</Button>
                  <Button size="sm" className="text-[10px] py-1 h-auto bg-gray-700 hover:bg-gray-600" onClick={() => { setActionPositionId(pos.positionId); setPositionAction('CLOSE'); setCloseQuantity(pos.quantity); setClosePrice(currentMarket?.lastPrice || ''); }}>Close</Button>
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
