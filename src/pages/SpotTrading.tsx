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
import { OrderBookService } from '../services/OrderBookService';
import { useAuth } from '../contexts/AuthContext';
import { Decimal } from 'decimal.js';

import { FeeService } from '../services/FeeService';

import { useSelectedSymbol } from '../hooks/useSelectedSymbol';
import { MarketSelector } from '../components/MarketSelector';
import { tradingPairRegistry } from '../services/market/TradingPairRegistry';
import { PriceAlertModal } from '../components/alerts/PriceAlertModal';
import { FuturesChart } from '../components/futures/FuturesChart';

export function SpotTrading({ selectedSymbol: initialSymbol = 'BTCUSDT', onNavigate }: { selectedSymbol?: string, onNavigate?: (tab: string, symbol?: string) => void }) {
  const { user } = useAuth();
  const accountId = user?.id || 'demo-user-1';
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
  const { balances } = useLedger();
  const { orders, pendingOrders, orderService } = useOrders(accountId);
  const { trades } = useTrades(accountId);
  
  const market = (markets && markets.length > 0)
    ? (markets.find(m => m.id === selectedSymbol || (m.baseAsset === targetBase && m.quoteAsset === targetQuote) || m.baseAsset === targetBase) || markets[0])
    : null;

  const currentPrice = parseFloat(ticker?.lastPrice || market?.price?.toString() || '0');
  const currentChange = parseFloat(ticker?.priceChangePercent || market?.change24h?.toString() || '0');
  
  const orderBook = React.useMemo(() => {
    if (!market) return { asks: [], bids: [] };
    return OrderBookService.generateSimulatedBook(market.baseAsset, currentPrice, 8, 0.0005);
  }, [market?.baseAsset, currentPrice]);

  const maxTotal = React.useMemo(() => {
    const maxAsk = orderBook.asks.length > 0 ? orderBook.asks[0].total : 0;
    const maxBid = orderBook.bids.length > 0 ? orderBook.bids[orderBook.bids.length - 1].total : 0;
    return Math.max(maxAsk, maxBid, 1);
  }, [orderBook]);

  const chartData = React.useMemo(() => {
    if (!market) return [];
    const data = [];
    let current = currentPrice * 0.95;
    
    // Stable random based on asset
    let seed = market.baseAsset.charCodeAt(0) + market.baseAsset.charCodeAt(market.baseAsset.length - 1);
    const random = () => {
      const x = Math.sin(seed++) * 10000;
      return x - Math.floor(x);
    };

    for(let i=0; i < 20; i++) {
      data.push({ time: i, price: current });
      current = current + (random() - 0.5) * (currentPrice * 0.015);
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

  const isPositive = currentChange >= 0;
  
  const availableQuote = new Decimal(balances[market.quoteAsset] || '0').toNumber();
  const availableBase = new Decimal(balances[market.baseAsset] || '0').toNumber();
  const available = orderSide === 'BUY' ? availableQuote : availableBase;
  const availableAsset = orderSide === 'BUY' ? market.quoteAsset : market.baseAsset;
  
  const priceToUse = orderType === 'LIMIT' ? (priceInput ? new Decimal(priceInput).toNumber() : 0) : currentPrice;
  const estimatedTotal = (amountInput ? new Decimal(amountInput).toNumber() : 0) * priceToUse;
  
  // Fee calculation (0.1% of received asset)
  let estimatedFee = '0';
  let feeAsset = '';
  if (amountInput && priceToUse > 0) {
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
      const budget = availableQuote * (percent / 100);
      if (priceToUse > 0) {
        setAmountInput((budget / priceToUse).toFixed(6).replace(/\.?0+$/, ''));
      }
    } else {
      const amt = availableBase * (percent / 100);
      setAmountInput(amt.toFixed(6).replace(/\.?0+$/, ''));
    }
  };

  return (
    <div className="pb-6 flex flex-col min-h-screen relative">
      {/* Trading Pair Header */}
      <div className="px-4 py-3 flex items-center justify-between border-b border-gray-900 bg-gray-950">
        <div className="flex items-center gap-2 relative">
          <Menu size={20} className="text-gray-400" />
          <h1 
            className="text-lg font-bold text-white flex items-center gap-1 cursor-pointer hover:text-gray-200"
            onClick={() => setShowPairs(!showPairs)}
          >
            {market.baseAsset}/{market.quoteAsset} <ChevronDown size={16} className="text-gray-500" />
          </h1>
          <span className={`text-sm font-medium ${isPositive ? 'text-emerald-500' : 'text-red-500'}`}>
            {isPositive ? '+' : ''}{currentChange.toFixed(2)}%</span>
          
          {/* Pair Selector Dropdown */}
          <MarketSelector isOpen={showPairs} onClose={() => setShowPairs(false)} onSelect={(symbol) => { const pair = tradingPairRegistry.getPair(symbol); if (pair?.marketType === 'FUTURES') { if (onNavigate) onNavigate('futures', symbol); } else { setSelectedSymbol(symbol); } setShowPairs(false); }} />
        </div>
        <div>
          <button onClick={() => setShowAlerts(true)} className="p-2 text-gray-400 hover:text-white rounded-full hover:bg-gray-800 transition-colors">
            <Bell size={20} />
          </button>
          {false && (
            <div className="absolute top-10 left-6 w-48 bg-gray-900 border border-gray-800 rounded-lg shadow-xl z-50 overflow-hidden">
              {markets.map(m => (
                <div 
                  key={m.id}
                  className="px-4 py-2 hover:bg-gray-800 cursor-pointer flex justify-between items-center"
                  onClick={() => {
                    setSelectedSymbol(`${m.baseAsset}USDT`);
                    setShowPairs(false);
                  }}
                >
                  <span className="font-bold text-gray-200">{m.baseAsset}/{m.quoteAsset}</span>
                  <span className={`text-xs ${m.change24h >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                    {m.change24h >= 0 ? '+' : ''}{m.change24h}%
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-col items-end">
          <div className="text-[10px] font-bold text-blue-400 px-2 py-0.5 rounded bg-blue-500/10 border border-blue-500/20">
            DEMO TRADING
          </div>
        </div>
      </div>

      {/* Market Stats */}
      <div className="px-4 py-2 flex items-center gap-6 border-b border-gray-900 bg-gray-950/80 text-[11px] font-medium text-gray-500 overflow-x-auto hide-scrollbar whitespace-nowrap">
        <div className="flex flex-col">
          <span>24h High</span>
          <span className="text-gray-200">{market.high24h?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) || '--'}</span>
        </div>
        <div className="flex flex-col">
          <span>24h Low</span>
          <span className="text-gray-200">{market.low24h?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) || '--'}</span>
        </div>
        <div className="flex flex-col">
          <span>24h Vol({market.baseAsset})</span>
          <span className="text-gray-200">{(market.volume).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
        </div>
      </div>

      {/* Chart Section */}
      <div className="w-full h-[250px] bg-gray-950 border-b border-gray-900 flex-shrink-0">
        <FuturesChart market={market!} />
      </div>

      {/* Main Trading Area */}
      <div className="flex flex-1 px-4 py-4 gap-4">
        {/* Left Col: Order Form */}
        <div className="w-[60%] flex flex-col pr-2">
          {/* Buy/Sell Tabs */}
          <div className="flex bg-gray-900 rounded-lg p-1 mb-4">
            <button 
              className={`flex-1 py-1.5 text-sm font-bold rounded-md transition-all ${
                orderSide === 'BUY' ? 'bg-emerald-500 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'
              }`}
              onClick={() => setOrderSide('BUY')}
            >
              Buy
            </button>
            <button 
              className={`flex-1 py-1.5 text-sm font-bold rounded-md transition-all ${
                orderSide === 'SELL' ? 'bg-red-500 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'
              }`}
              onClick={() => setOrderSide('SELL')}
            >
              Sell
            </button>
          </div>

          {/* Order Type */}
          <div 
            className="flex items-center gap-1 mb-4 text-sm text-gray-400 font-medium cursor-pointer hover:text-gray-200"
            onClick={() => setOrderType(orderType === 'LIMIT' ? 'MARKET' : 'LIMIT')}
          >
            <span>{orderType === 'LIMIT' ? 'Limit Order' : 'Market Order'}</span>
            <ChevronDown size={14} />
          </div>

          {/* Price Input */}
          <div className={`bg-gray-900 border border-gray-800 focus-within:border-gray-600 transition-colors rounded-lg flex items-center px-3 py-2.5 mb-2 ${orderType === 'MARKET' ? 'opacity-50 pointer-events-none' : ''}`}>
            <span className="text-gray-500 text-sm mr-2">-</span>
            <input 
              type="number" 
              step="any"
              className="bg-transparent flex-1 w-full text-gray-100 text-sm focus:outline-none text-center font-bold"
              value={orderType === 'LIMIT' ? priceInput : currentPrice.toFixed(2)}
              onChange={(e) => setPriceInput(e.target.value)}
              placeholder="Price"
              readOnly={orderType === 'MARKET'}
            />
            <span className="text-gray-500 text-sm ml-2">+</span>
          </div>
          <div className="text-[11px] text-gray-500 text-right mb-4">≈ ${currentPrice.toFixed(2)}</div>

          {/* Amount Input */}
          <div className="bg-gray-900 border border-gray-800 focus-within:border-gray-600 transition-colors rounded-lg flex items-center px-3 py-2.5 mb-3 relative">
            <input 
              type="number" 
              step="any"
              className="bg-transparent flex-1 w-full text-gray-100 text-sm font-bold focus:outline-none"
              placeholder="Amount"
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
            />
            <span className="text-gray-500 text-sm font-medium">{market.baseAsset}</span>
          </div>

          {/* Slider Mock */}
          <div className="flex items-center justify-between mb-6 px-1 relative before:absolute before:inset-0 before:top-1 before:h-[2px] before:bg-gray-800 before:z-0">
            {[25, 50, 75, 100].map((percent) => (
              <div 
                key={percent} 
                onClick={() => setPercentage(percent)}
                className="w-2.5 h-2.5 rounded-full bg-gray-700 z-10 ring-2 ring-gray-950 cursor-pointer hover:bg-gray-400 transition-colors"
              ></div>
            ))}
          </div>

          {/* Total */}
          <div className="bg-gray-900 border border-gray-800 focus-within:border-gray-600 transition-colors rounded-lg flex items-center px-3 py-2.5 mb-2 relative opacity-70">
            <input 
              type="text" 
              className="bg-transparent flex-1 w-full text-gray-100 text-sm font-bold focus:outline-none"
              placeholder="Total"
              value={estimatedTotal > 0 ? estimatedTotal.toFixed(2) : ''}
              readOnly
            />
            <span className="text-gray-500 text-sm font-medium">{market.quoteAsset}</span>
          </div>
          
          {/* Fee & Balance info */}
          <div className="flex justify-between text-[11px] text-gray-500 mb-1 font-medium">
            <span>Est. Fee (0.1%)</span>
            <span className="text-gray-400">{estimatedFee ? `${parseFloat(estimatedFee).toLocaleString(undefined, {maximumFractionDigits: 6})} ${feeAsset}` : '--'}</span>
          </div>
          <div className="flex justify-between text-[11px] text-gray-500 mb-4 font-medium">
            <span>Available</span>
            <span className="text-gray-200">{available.toLocaleString(undefined, { maximumFractionDigits: 6 })} {availableAsset}</span>
          </div>

          {errorMsg && <div className="text-xs font-bold text-red-500 mb-2">{errorMsg}</div>}
          {successMsg && <div className="text-xs font-bold text-emerald-500 mb-2">{successMsg}</div>}

          <Button 
            className={`py-3 shadow-md ${orderSide === 'BUY' ? 'bg-emerald-500 hover:bg-emerald-600' : 'bg-red-500 hover:bg-red-600'}`}
            fullWidth
            onClick={handleSubmit}
            disabled={isSubmitting || !amountInput || (orderType === 'LIMIT' && !priceInput) || (amountInput ? new Decimal(amountInput).lte(0) : true)}
          >
            {isSubmitting ? 'Processing...' : (orderSide === 'BUY' ? `Buy ${market.baseAsset}` : `Sell ${market.baseAsset}`)}
          </Button>
        </div>

        {/* Right Col: Order Book */}
      <div className="w-[40%] flex flex-col text-[11px] font-medium relative">
        <div className="absolute top-0 right-0 p-1 opacity-50 z-10 pointer-events-none mt-[-24px]">
          <div className="text-[9px] font-bold text-blue-400 px-1 py-0.5 rounded bg-blue-500/10 border border-blue-500/20 shadow-sm">
            DEMO BOOK
          </div>
        </div>
        <div className="flex justify-between text-gray-500 mb-2 font-medium">
            <span>Price</span>
            <span>Amount</span>
          </div>
          
          {/* Asks (Sell Orders) */}
          <div className="flex flex-col gap-[2px] mb-2">
            {orderBook.asks.map((ask, i) => (
            <div 
              key={`ask-${i}`} 
              className="flex justify-between relative text-red-500 py-[2px] cursor-pointer hover:bg-gray-900/50"
              onClick={() => { if (orderType === 'LIMIT') setPriceInput(ask.price.toFixed(4)); }}
            >
              <div className="absolute right-0 top-0 bottom-0 bg-red-500/10 z-0" style={{ width: `${(ask.total / maxTotal) * 100}%` }}></div>
              <span className="z-10 relative font-bold">{ask.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</span>
              <span className="text-gray-300 z-10 relative">{ask.quantity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</span>
            </div>
          ))}
          </div>

          {/* Current Price */}
          <div className="py-2 flex flex-col items-center gap-0.5 mb-2 cursor-pointer" onClick={() => { if (orderType === 'LIMIT') setPriceInput(currentPrice.toString()); }}>
            <div className="flex items-center gap-1">
              <span className={`text-lg font-bold ${isPositive ? 'text-emerald-500' : 'text-red-500'}`}>
                {currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
              </span>
              {isPositive ? <ArrowUpRight size={16} className="text-emerald-500" /> : <ArrowDownRight size={16} className="text-red-500" />}
            </div>
            <span className="text-gray-500 text-[10px]">≈ ${currentPrice.toFixed(2)}</span>
          </div>

          {/* Bids (Buy Orders) */}
          <div className="flex flex-col gap-[2px]">
            {orderBook.bids.map((bid, i) => (
            <div 
              key={`bid-${i}`} 
              className="flex justify-between relative text-emerald-500 py-[2px] cursor-pointer hover:bg-gray-900/50"
              onClick={() => { if (orderType === 'LIMIT') setPriceInput(bid.price.toFixed(4)); }}
            >
              <div className="absolute right-0 top-0 bottom-0 bg-emerald-500/10 z-0" style={{ width: `${(bid.total / maxTotal) * 100}%` }}></div>
              <span className="z-10 relative font-bold">{bid.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</span>
              <span className="text-gray-300 z-10 relative">{bid.quantity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</span>
            </div>
          ))}
          </div>
        </div>
      </div>

      {/* History Section */}
      <div className="px-4 mt-4 pb-20">
        <div className="flex items-center justify-between border-b border-gray-800 pb-2 mb-4">
          <div className="flex gap-4 text-sm font-bold overflow-x-auto hide-scrollbar whitespace-nowrap">
            <button 
              onClick={() => setHistoryTab('open')}
              className={`pb-2 ${historyTab === 'open' ? 'text-white border-b-2 border-white' : 'text-gray-500 hover:text-gray-300'}`}
            >
              Open Orders ({pendingOrders.length})
            </button>
            <button 
              onClick={() => setHistoryTab('orders')}
              className={`pb-2 ${historyTab === 'orders' ? 'text-white border-b-2 border-white' : 'text-gray-500 hover:text-gray-300'}`}
            >
              Order History
            </button>
            <button 
              onClick={() => setHistoryTab('trades')}
              className={`pb-2 ${historyTab === 'trades' ? 'text-white border-b-2 border-white' : 'text-gray-500 hover:text-gray-300'}`}
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
