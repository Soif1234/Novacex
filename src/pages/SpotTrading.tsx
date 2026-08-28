import React, { useState, useEffect, useRef } from 'react';
import { Menu, ChevronDown, MoreHorizontal, Info, ArrowUpRight, ArrowDownRight, Trash2, Activity, Bell } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { OrderHistory } from '../components/orders/OrderHistory';
import { TradeHistory } from '../components/orders/TradeHistory';
import { OpenOrders } from '../components/orders/OpenOrders';
import { useMarketData } from '../hooks/useMarketData';
import { useTicker } from '../hooks/useTicker';
import { useLedger } from '../hooks/useLedger';
import { useOrders } from '../hooks/useOrders';
import { useTrades } from '../hooks/useTrades';
import { OrderBookService, OrderBook } from '../services/OrderBookService';
import { useAuth } from '../contexts/AuthContext';
import { Decimal } from 'decimal.js';
import { wsClient } from '../services/websocket/wsClient';

import { FeeService } from '../services/FeeService';

import { useSelectedSymbol } from '../hooks/useSelectedSymbol';
import { MarketSelector } from '../components/MarketSelector';
import { tradingPairRegistry } from '../services/market/TradingPairRegistry';
import { PriceAlertModal } from '../components/alerts/PriceAlertModal';
import { FuturesChart } from '../components/futures/FuturesChart';
import { CoinAvatar } from '../components/ui/CoinAvatar';

export function SpotTrading({ selectedSymbol: initialSymbol = 'BTCUSDT', onNavigate }: { selectedSymbol?: string, onNavigate?: (tab: string, symbol?: string) => void }) {
  const { user } = useAuth();
  const accountId = user?.spotAccountId || user?.id || 'demo-user-1';
  const { selectedSymbol, setSelectedSymbol } = useSelectedSymbol();
  
  const pair = tradingPairRegistry.getSpotPair(selectedSymbol) || tradingPairRegistry.getPair(selectedSymbol) || tradingPairRegistry.getSpotPairs()[0];
  const targetBase = pair?.baseAsset || (selectedSymbol.endsWith('USDT') ? selectedSymbol.replace('USDT', '') : (selectedSymbol.endsWith('USDC') ? selectedSymbol.replace('USDC', '') : selectedSymbol));
  const targetQuote = pair?.quoteAsset || 'USDT';
  
  const [orderSide, setOrderSide] = useState<'BUY' | 'SELL'>('BUY');
  const [orderType, setOrderType] = useState<'LIMIT' | 'MARKET'>('LIMIT');
  
  const [priceInput, setPriceInput] = useState('');
  const [amountInput, setAmountInput] = useState('');
  
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);
  
  const [historyTab, setHistoryTab] = useState<'open' | 'orders' | 'trades'>('open');
  const [showPairs, setShowPairs] = useState(false);
  const [showAlerts, setShowAlerts] = useState(false);
  
  const { data: markets } = useMarketData();
  const ticker = useTicker(selectedSymbol) as any;
  const { balances } = useLedger(accountId);
  const { orders, pendingOrders, orderService } = useOrders(accountId);
  const { trades } = useTrades(accountId);
  
  const market = (markets && markets.length > 0)
    ? (markets.find(m => m.id === selectedSymbol || (m.baseAsset === targetBase && m.quoteAsset === targetQuote) || m.baseAsset === targetBase) || markets[0])
    : null;

  const currentPriceStr = ticker?.lastPrice || market?.price?.toString() || '0';
  const currentPrice = new Decimal(currentPriceStr);
  const currentChange = new Decimal(ticker?.priceChangePercent || market?.change24h?.toString() || '0');
  
  const [liveOrderBook, setLiveOrderBook] = useState<OrderBook | null>(null);

  useEffect(() => {
    const unsub = wsClient.subscribe(`orderbook:${selectedSymbol}`, (data: any) => {
      if (data && (data.bids || data.asks)) {
        setLiveOrderBook(OrderBookService.fromBackendOrderBook(data.bids, data.asks));
      }
    });
    return () => { unsub(); };
  }, [selectedSymbol]);

  const orderBook = React.useMemo(() => {
    if (liveOrderBook) return liveOrderBook;
    if (!market) return { asks: [], bids: [] };
    return OrderBookService.generateSimulatedBook(market.baseAsset, currentPrice.toNumber(), 8, 0.0005);
  }, [liveOrderBook, market?.baseAsset, currentPrice]);

  const maxTotal = React.useMemo(() => {
    const maxAsk = orderBook.asks.length > 0 ? orderBook.asks[0].total : 0;
    const maxBid = orderBook.bids.length > 0 ? orderBook.bids[orderBook.bids.length - 1].total : 0;
    return Math.max(maxAsk, maxBid, 1);
  }, [orderBook]);

  const chartData = React.useMemo(() => {
    if (!market) return [];
    const data = [];
    let current = currentPrice.mul(0.95);
    
    // Stable random based on asset
    let seed = market.baseAsset.charCodeAt(0) + market.baseAsset.charCodeAt(market.baseAsset.length - 1);
    const random = () => {
      const x = Math.sin(seed++) * 10000;
      return x - Math.floor(x);
    };

    for(let i=0; i < 20; i++) {
      data.push({ time: i, price: current });
      current = current.plus(currentPrice.mul(0.015).mul(random() - 0.5));
    }
    data.push({ time: 20, price: currentPrice });
    return data;
  }, [market?.baseAsset, currentPrice]);

  useEffect(() => {
    setPriceInput('');
    setAmountInput('');
    setErrorMsg('');
    setSuccessMsg('');
  }, [selectedSymbol]);

  if (!market) {
    return (
      <div className="flex items-center justify-center min-h-screen text-gray-500 bg-gray-950">
        <div className="text-center p-4">
          <p className="text-sm">Loading market data...</p>
        </div>
      </div>
    );
  }

  const isPositive = currentChange.gte(0);
  
  const availableQuote = new Decimal(balances[market.quoteAsset] || '0');
  const availableBase = new Decimal(balances[market.baseAsset] || '0');
  const available = orderSide === 'BUY' ? availableQuote : availableBase;
  const availableAsset = orderSide === 'BUY' ? market.quoteAsset : market.baseAsset;
  
  const priceToUse = orderType === 'LIMIT' ? new Decimal(priceInput || '0') : new Decimal(currentPriceStr || '0');
  const estimatedTotal = new Decimal(amountInput || '0').mul(priceToUse);
  
  // Fee calculation (0.1% of received asset)
  let estimatedFee = '0';
  let feeAsset = '';
  if (amountInput && priceToUse.gt(0)) {
    if (orderSide === 'BUY') {
      estimatedFee = FeeService.calculateFee(amountInput);
      feeAsset = market.baseAsset;
    } else {
      estimatedFee = FeeService.calculateFee(estimatedTotal.toString());
      feeAsset = market.quoteAsset;
    }
  }

  const handleSubmit = async () => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    try {
      setErrorMsg('');
      setSuccessMsg('');
      const order = await orderService.placeOrder({
        id: `ord-${Math.random().toString(36).substring(2, 11)}`,
        accountId,
        symbol: `${market.baseAsset}${market.quoteAsset}`,
        side: orderSide,
        type: orderType,
        price: orderType === 'LIMIT' ? priceInput : undefined,
        quantity: amountInput,
        status: 'PENDING',
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
      
      if (order.status === 'FILLED') {
         setSuccessMsg(`FILLED at ${priceToUse} (Qty: ${order.quantity})`);
      } else if (order.status === 'REJECTED') {
         setErrorMsg(`Order REJECTED.`);
      } else {
         setSuccessMsg(`PLACED Limit ${orderSide} at ${order.price}`);
      }
      
      setAmountInput('');
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const setPercentage = (percent: number) => {
    if (orderSide === 'BUY') {
      const budget = availableQuote.mul(percent).div(100);
      if (priceToUse.gt(0)) {
        setAmountInput(budget.div(priceToUse).toFixed(6).replace(/\.?0+$/, ''));
      }
    } else {
      const amt = availableBase.mul(percent).div(100);
      setAmountInput(amt.toFixed(6).replace(/\.?0+$/, ''));
    }
  };

  return (
    <div className="pb-6 flex flex-col min-h-screen relative">
      {/* Trading Pair Header */}
      <div className="px-4 py-3 flex items-center justify-between border-b border-gray-800/80 bg-gray-950/95 sticky top-0 z-30">
        <div className="flex items-center gap-2.5 relative">
          <button
            type="button"
            className="flex items-center gap-1.5 p-1 rounded-xl hover:bg-gray-850 transition-colors cursor-pointer group"
            onClick={() => setShowPairs(!showPairs)}
          >
            <CoinAvatar symbol={market.baseAsset} size="sm" />
            <h1 className="text-base md:text-lg font-black text-white flex items-center gap-1">
              <span>{market.baseAsset}/{market.quoteAsset}</span>
              <ChevronDown size={15} className="text-gray-400 group-hover:text-cyan-400 transition-colors" />
            </h1>
          </button>

          <span className={`text-xs font-mono font-black px-2 py-0.5 rounded-lg flex items-center gap-0.5 ${
            isPositive ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20' : 'bg-red-500/15 text-red-400 border border-red-500/20'
          }`}>
            {isPositive ? '+' : ''}{currentChange.toFixed(2)}%
          </span>
          
          <MarketSelector 
            isOpen={showPairs} 
            onClose={() => setShowPairs(false)} 
            onSelect={(symbol) => { 
              const pair = tradingPairRegistry.getPair(symbol); 
              if (pair?.marketType === 'FUTURES') { 
                if (onNavigate) onNavigate('futures', symbol); 
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
          <span className="text-[10px] font-black text-cyan-400 px-2 py-1 rounded-lg bg-cyan-500/10 border border-cyan-500/20 uppercase tracking-wider">
            SPOT
          </span>
        </div>
      </div>

      {/* Market Stats Ribbon */}
      <div className="px-4 py-2 flex items-center gap-6 border-b border-gray-800/60 bg-gray-950/80 text-[11px] font-mono overflow-x-auto hide-scrollbar whitespace-nowrap">
        <div className="flex flex-col">
          <span className="text-gray-500 text-[10px] font-sans">24h High</span>
          <span className="text-white font-bold">{market.high24h?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) || '--'}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-gray-500 text-[10px] font-sans">24h Low</span>
          <span className="text-white font-bold">{market.low24h?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) || '--'}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-gray-500 text-[10px] font-sans">24h Vol({market.baseAsset})</span>
          <span className="text-white font-bold">{(market.volume).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-gray-500 text-[10px] font-sans">24h Turnover</span>
          <span className="text-gray-400">${(new Decimal(market.volume).mul(currentPrice).div(1000000)).toNumber().toFixed(2)}M</span>
        </div>
      </div>

      {/* Candlestick Chart Section */}
      <div className="w-full h-[240px] bg-gray-950 border-b border-gray-800/80 flex-shrink-0">
        <FuturesChart market={market!} marketType="SPOT" />
      </div>

      {/* Main Trading Area */}
      <div className="flex flex-1 px-4 py-4 gap-4">
        {/* Left Col: Order Ticket Form */}
        <div className="w-[58%] flex flex-col pr-1">
          {/* Buy/Sell Segmented Switcher */}
          <div className="flex bg-gray-950 p-1 border border-gray-800/90 rounded-xl mb-3.5">
            <button 
              type="button"
              className={`flex-1 py-2 text-xs font-black rounded-lg transition-all cursor-pointer ${
                orderSide === 'BUY' 
                  ? 'bg-emerald-500 text-gray-950 shadow-md shadow-emerald-500/20' 
                  : 'text-gray-400 hover:text-gray-200'
              }`}
              onClick={() => setOrderSide('BUY')}
            >
              BUY
            </button>
            <button 
              type="button"
              className={`flex-1 py-2 text-xs font-black rounded-lg transition-all cursor-pointer ${
                orderSide === 'SELL' 
                  ? 'bg-red-500 text-white shadow-md shadow-red-500/20' 
                  : 'text-gray-400 hover:text-gray-200'
              }`}
              onClick={() => setOrderSide('SELL')}
            >
              SELL
            </button>
          </div>

          {/* Order Type Selector */}
          <div className="flex items-center gap-1.5 mb-3">
            {(['LIMIT', 'MARKET'] as const).map(type => (
              <button
                key={type}
                type="button"
                onClick={() => setOrderType(type)}
                className={`px-2.5 py-1 rounded-lg text-xs font-extrabold transition-all cursor-pointer ${
                  orderType === type
                    ? 'bg-gray-800 text-white border border-gray-700'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {type === 'LIMIT' ? 'Limit' : 'Market'}
              </button>
            ))}
          </div>

          {/* Price Input */}
          <div className="mb-2">
            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider block mb-1">Order Price</label>
            <div className={`bg-gray-950 border border-gray-800 focus-within:border-cyan-500/80 focus-within:ring-1 focus-within:ring-cyan-500/30 transition-all rounded-xl flex items-center px-3 py-2 ${orderType === 'MARKET' ? 'opacity-50 pointer-events-none' : ''}`}>
              <input 
                type="number" 
                step="any"
                className="bg-transparent flex-1 w-full text-white text-sm font-mono font-bold focus:outline-none tabular-nums"
                value={orderType === 'LIMIT' ? priceInput : currentPrice.toFixed(2)}
                onChange={(e) => setPriceInput(e.target.value)}
                placeholder="Price"
                readOnly={orderType === 'MARKET'}
              />
              <span className="text-gray-400 text-xs font-bold font-mono ml-2">{market.quoteAsset}</span>
            </div>
            <div className="text-[10px] text-gray-500 text-right mt-1 font-mono">≈ ${currentPrice.toFixed(2)}</div>
          </div>

          {/* Amount Input */}
          <div className="mb-2.5">
            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider block mb-1">Quantity</label>
            <div className="bg-gray-950 border border-gray-800 focus-within:border-cyan-500/80 focus-within:ring-1 focus-within:ring-cyan-500/30 transition-all rounded-xl flex items-center px-3 py-2">
              <input 
                type="number" 
                step="any"
                className="bg-transparent flex-1 w-full text-white text-sm font-mono font-bold focus:outline-none tabular-nums"
                placeholder="0.00"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
              />
              <span className="text-gray-400 text-xs font-bold font-mono ml-2">{market.baseAsset}</span>
            </div>
          </div>

          {/* Percentage Fast Pills */}
          <div className="grid grid-cols-4 gap-1 mb-3.5">
            {[25, 50, 75, 100].map((percent) => (
              <button 
                key={percent} 
                type="button"
                onClick={() => setPercentage(percent)}
                className="py-1 rounded-lg bg-gray-900 hover:bg-gray-800 border border-gray-800/80 text-[11px] font-bold font-mono text-gray-400 hover:text-white transition-all cursor-pointer"
              >
                {percent}%
              </button>
            ))}
          </div>

          {/* Total Value */}
          <div className="bg-gray-950/60 border border-gray-850 rounded-xl p-2.5 mb-3 flex items-center justify-between text-xs font-mono">
            <span className="text-gray-500 font-sans text-[11px]">Order Value</span>
            <span className="font-bold text-white tabular-nums">
              {estimatedTotal.gt(0) ? estimatedTotal.toFixed(2) : '0.00'} {market.quoteAsset}
            </span>
          </div>
          
          {/* Fee & Balance Details */}
          <div className="space-y-1 mb-4 text-[11px]">
            <div className="flex justify-between text-gray-500">
              <span>Fee Rate (0.1%)</span>
              <span className="font-mono text-gray-400">{estimatedFee ? `${new Decimal(estimatedFee).toDecimalPlaces(6).toString()} ${feeAsset}` : '--'}</span>
            </div>
            <div className="flex justify-between text-gray-500">
              <span>Available Balance</span>
              <span className="font-mono text-cyan-400 font-bold">{new Decimal(available).toFixed(4)} {availableAsset}</span>
            </div>
          </div>

          {errorMsg && (
            <div className="text-xs font-bold text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl p-2.5 mb-3 animate-fadeIn">
              {errorMsg}
            </div>
          )}
          {successMsg && (
            <div className="text-xs font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-2.5 mb-3 animate-fadeIn">
              {successMsg}
            </div>
          )}

          <Button 
            variant={orderSide === 'BUY' ? 'buy' : 'sell'}
            fullWidth
            isLoading={isSubmitting}
            onClick={handleSubmit}
            disabled={isSubmitting || !amountInput || (orderType === 'LIMIT' && !priceInput) || (amountInput ? new Decimal(amountInput).lte(0) : true)}
          >
            {orderSide === 'BUY' ? `Buy ${market.baseAsset}` : `Sell ${market.baseAsset}`}
          </Button>
        </div>

        {/* Right Col: Live Order Book Depth */}
        <div className="w-[42%] flex flex-col text-[11px] font-mono">
          <div className="flex justify-between text-gray-500 mb-1.5 font-bold text-[10px] uppercase tracking-wider font-sans">
            <span>Price</span>
            <span>Size</span>
          </div>
          
          {/* Asks (Sell Orders - Crimson) */}
          <div className="flex flex-col gap-[1.5px] mb-2">
            {orderBook.asks.slice(-7).map((ask, i) => (
              <div 
                key={`ask-${i}`} 
                className="flex justify-between relative text-red-400 py-[2px] px-1 rounded hover:bg-gray-850/60 transition-colors cursor-pointer group"
                onClick={() => { if (orderType === 'LIMIT') setPriceInput(ask.price.toFixed(4)); }}
              >
                <div 
                  className="absolute right-0 top-0 bottom-0 bg-red-500/15 rounded-r z-0 transition-all duration-300" 
                  style={{ width: `${(ask.total / maxTotal) * 100}%` }} 
                />
                <span className="z-10 relative font-bold tabular-nums">{ask.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</span>
                <span className="text-gray-400 z-10 relative tabular-nums">{ask.quantity.toFixed(2)}</span>
              </div>
            ))}
          </div>

          {/* Mid Market Price Indicator */}
          <div 
            className="py-2.5 px-2 bg-gray-950 border-y border-gray-850/80 my-1 flex flex-col items-center justify-center cursor-pointer rounded-lg hover:border-cyan-500/40 transition-all" 
            onClick={() => { if (orderType === 'LIMIT') setPriceInput(currentPrice.toString()); }}
          >
            <div className="flex items-center gap-1">
              <span className={`text-base font-black tabular-nums ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
                {currentPrice.toNumber().toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
              </span>
              {isPositive ? <ArrowUpRight size={15} className="text-emerald-400" /> : <ArrowDownRight size={15} className="text-red-400" />}
            </div>
            <span className="text-gray-500 text-[10px] font-mono">≈ ${currentPrice.toFixed(2)}</span>
          </div>

          {/* Bids (Buy Orders - Emerald) */}
          <div className="flex flex-col gap-[1.5px]">
            {orderBook.bids.slice(0, 7).map((bid, i) => (
              <div 
                key={`bid-${i}`} 
                className="flex justify-between relative text-emerald-400 py-[2px] px-1 rounded hover:bg-gray-850/60 transition-colors cursor-pointer group"
                onClick={() => { if (orderType === 'LIMIT') setPriceInput(bid.price.toFixed(4)); }}
              >
                <div 
                  className="absolute right-0 top-0 bottom-0 bg-emerald-500/15 rounded-r z-0 transition-all duration-300" 
                  style={{ width: `${(bid.total / maxTotal) * 100}%` }} 
                />
                <span className="z-10 relative font-bold tabular-nums">{bid.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</span>
                <span className="text-gray-400 z-10 relative tabular-nums">{bid.quantity.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Orders & Activity History Section */}
      <div className="px-4 mt-2 pb-20">
        <div className="border-b border-gray-800/80 pb-2 mb-4">
          <div className="flex gap-4 text-xs md:text-sm font-extrabold overflow-x-auto hide-scrollbar whitespace-nowrap">
            <button 
              type="button"
              onClick={() => setHistoryTab('open')}
              className={`pb-2.5 transition-all flex items-center gap-1.5 cursor-pointer ${
                historyTab === 'open' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              <span>Open Orders</span>
              <span className="px-1.5 py-0.2 bg-cyan-500/20 text-cyan-400 rounded-full text-[10px] font-mono">
                {pendingOrders.length}
              </span>
            </button>
            <button 
              type="button"
              onClick={() => setHistoryTab('orders')}
              className={`pb-2.5 transition-all cursor-pointer ${
                historyTab === 'orders' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              Order History
            </button>
            <button 
              type="button"
              onClick={() => setHistoryTab('trades')}
              className={`pb-2.5 transition-all cursor-pointer ${
                historyTab === 'trades' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              Trade History
            </button>
          </div>
        </div>
        
        {historyTab === 'open' && <OpenOrders symbol={selectedSymbol} />}
        {historyTab === 'orders' && <OrderHistory />}
        {historyTab === 'trades' && <TradeHistory />}
      </div>
      
      <PriceAlertModal isOpen={showAlerts} onClose={() => setShowAlerts(false)} defaultSymbol={selectedSymbol} />
    </div>
  );
}

