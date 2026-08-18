import React, { useState, useEffect } from "react";
import { tradeFillService } from "../../services/orders/TradeFillService";
import { orderCoreService } from "../../services/orders/OrderCoreService";
import { useAuth } from "../../contexts/AuthContext";
import { Button } from "../ui/Button";
import { TradeFill, Order } from "../../types/orderCore";
import { Search, X } from "lucide-react";
import { tradingPairRegistry } from "../../services/market/TradingPairRegistry";
import { safeFormatDate } from "../../services/storageUtil";

export function TradeHistory() {
  const { user } = useAuth();
  const [trades, setTrades] = useState<TradeFill[]>([]);
  
  const [filterMarket, setFilterMarket] = useState<string>("ALL");
  const [filterSymbol, setFilterSymbol] = useState<string>("ALL");
  const [filterSide, setFilterSide] = useState<string>("ALL");
  const [filterDate, setFilterDate] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  
  const [selectedTrade, setSelectedTrade] = useState<TradeFill | null>(null);
  const [associatedOrder, setAssociatedOrder] = useState<Order | null>(null);

  const accountId = user?.id || 'demo-user-1';

  useEffect(() => {
    const loadTrades = () => {
      setTrades(tradeFillService.getTradeHistory(accountId));
    };

    loadTrades();
    const unsubscribe = tradeFillService.subscribe(loadTrades);
    return () => unsubscribe();
  }, [user, accountId]);

  const handleTradeClick = (trade: TradeFill) => {
    setSelectedTrade(trade);
    const order = orderCoreService.getOrders(accountId).find(o => o.id === trade.orderId) || null;
    setAssociatedOrder(order);
  };

  const filteredTrades = trades.filter((t) => {
    if (filterMarket !== "ALL" && t.market !== filterMarket) return false;
    if (filterSymbol !== "ALL" && t.symbol !== filterSymbol) return false;
    if (filterSide !== "ALL") {
       if (filterSide === "BUY" && t.side !== "BUY" && t.side !== "LONG") return false;
       if (filterSide === "SELL" && t.side !== "SELL" && t.side !== "SHORT") return false;
    }
    
    if (filterDate !== "ALL") {
      const now = Date.now();
      const tradeDate = Number(t.createdAt || 0);
      const oneDay = 24 * 60 * 60 * 1000;
      if (filterDate === "TODAY" && now - tradeDate > oneDay) return false;
      if (filterDate === "7D" && now - tradeDate > 7 * oneDay) return false;
      if (filterDate === "30D" && now - tradeDate > 30 * oneDay) return false;
    }
    
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      if (!t.id.toLowerCase().includes(q) && !t.orderId.toLowerCase().includes(q) && !t.symbol.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const sortedTrades = [...filteredTrades].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

  const allSymbols = Array.from(new Set([
    ...tradingPairRegistry.getSpotPairs().map(p => p.symbol),
    ...tradingPairRegistry.getFuturesPairs().map(p => p.symbol)
  ])).sort();

  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            placeholder="Search Trade ID, Order ID or Symbol"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-gray-900 border border-gray-800 rounded-lg pl-9 pr-3 py-2 text-white focus:outline-none focus:border-emerald-500"
          />
        </div>

        <select
          value={filterDate}
          onChange={(e) => setFilterDate(e.target.value)}
          className="bg-gray-900 border border-gray-800 text-white rounded-lg px-3 py-2 focus:outline-none"
        >
          <option value="ALL">All Dates</option>
          <option value="TODAY">Today</option>
          <option value="7D">Past 7 Days</option>
          <option value="30D">Past 30 Days</option>
        </select>

        <select
          value={filterMarket}
          onChange={(e) => setFilterMarket(e.target.value)}
          className="bg-gray-900 border border-gray-800 text-white rounded-lg px-3 py-2 focus:outline-none"
        >
          <option value="ALL">All Markets</option>
          <option value="SPOT">Spot</option>
          <option value="FUTURES">Futures</option>
        </select>

        <select
          value={filterSymbol}
          onChange={(e) => setFilterSymbol(e.target.value)}
          className="bg-gray-900 border border-gray-800 text-white rounded-lg px-3 py-2 focus:outline-none"
        >
          <option value="ALL">All Symbols</option>
          {allSymbols.map(sym => (
            <option key={sym} value={sym}>{sym}</option>
          ))}
        </select>

        <select
          value={filterSide}
          onChange={(e) => setFilterSide(e.target.value)}
          className="bg-gray-900 border border-gray-800 text-white rounded-lg px-3 py-2 focus:outline-none"
        >
          <option value="ALL">All Sides</option>
          <option value="BUY">Buy</option>
          <option value="SELL">Sell</option>
        </select>
      </div>

      {sortedTrades.length === 0 ? (
        <div className="text-gray-500 p-8 text-center bg-gray-900 rounded-lg border border-gray-800">
          No trades yet.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sortedTrades.map((t) => (
            <div
              key={t.id}
              onClick={() => handleTradeClick(t)}
              className="bg-gray-900 p-4 rounded-lg flex flex-col gap-3 border border-gray-800 cursor-pointer hover:bg-gray-800 transition-colors"
            >
              <div className="flex justify-between items-start">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-white text-base">{t.symbol}</span>
                    <span className={`text-xs px-2 py-0.5 rounded font-bold ${
                      t.side === 'BUY' || t.side === 'LONG' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'
                    }`}>
                      {t.side}
                    </span>
                    <span className="bg-gray-800 text-gray-300 text-xs px-2 py-0.5 rounded">{t.market}</span>
                  </div>
                  <div className="text-gray-500 text-xs mt-1">ID: {t.id}</div>
                </div>
                <div className="text-right">
                  <div className="text-gray-500 text-xs">
                    {safeFormatDate(t.createdAt)}
                  </div>
                </div>
              </div>
              
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mt-2 pt-3 border-t border-gray-800">
                <div>
                  <div className="text-gray-500 text-xs">Exec Price</div>
                  <div className="text-gray-300">{t.price}</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs">Filled Qty</div>
                  <div className="text-gray-300">{t.quantity}</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs">Fee</div>
                  <div className="text-gray-300">{t.fee} {t.feeAsset}</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs">PnL</div>
                  <div className={`text-gray-300 ${t.realizedPnl && parseFloat(t.realizedPnl) > 0 ? 'text-emerald-500' : t.realizedPnl && parseFloat(t.realizedPnl) < 0 ? 'text-rose-500' : ''}`}>
                    {t.realizedPnl ? (parseFloat(t.realizedPnl) > 0 ? `+${t.realizedPnl}` : t.realizedPnl) : '-'}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {selectedTrade && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setSelectedTrade(null)}>
          <div 
            className="bg-gray-900 border border-gray-800 rounded-xl max-w-lg w-full overflow-hidden" 
            onClick={e => e.stopPropagation()}
          >
            <div className="p-4 border-b border-gray-800 flex justify-between items-center">
              <h3 className="font-bold text-white text-lg">Trade Details</h3>
              <button onClick={() => setSelectedTrade(null)} className="text-gray-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-6 overflow-y-auto max-h-[70vh]">
              <div className="grid grid-cols-2 gap-y-4 gap-x-8 mb-6">
                <div>
                  <div className="text-gray-500 text-xs mb-1">Trade ID</div>
                  <div className="text-white text-sm break-all">{selectedTrade.id}</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs mb-1">Order ID</div>
                  <div className="text-white text-sm break-all">{selectedTrade.orderId}</div>
                </div>
                
                <div>
                  <div className="text-gray-500 text-xs mb-1">Symbol</div>
                  <div className="text-white text-sm font-bold">{selectedTrade.symbol}</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs mb-1">Market</div>
                  <div className="text-white text-sm">{selectedTrade.market}</div>
                </div>

                <div>
                  <div className="text-gray-500 text-xs mb-1">Side</div>
                  <div className={`text-sm font-bold ${
                    selectedTrade.side === 'BUY' || selectedTrade.side === 'LONG' ? 'text-emerald-500' : 'text-rose-500'
                  }`}>{selectedTrade.side}</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs mb-1">Execution Time</div>
                  <div className="text-white text-sm">{safeFormatDate(selectedTrade.createdAt)}</div>
                </div>

                <div>
                  <div className="text-gray-500 text-xs mb-1">Executed Qty</div>
                  <div className="text-white text-sm">{selectedTrade.quantity}</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs mb-1">Execution Price</div>
                  <div className="text-white text-sm">{selectedTrade.price}</div>
                </div>
                
                <div>
                  <div className="text-gray-500 text-xs mb-1">Fee</div>
                  <div className="text-white text-sm">{selectedTrade.fee} {selectedTrade.feeAsset}</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs mb-1">Realized PnL</div>
                  <div className={`text-sm ${selectedTrade.realizedPnl && parseFloat(selectedTrade.realizedPnl) > 0 ? 'text-emerald-500' : selectedTrade.realizedPnl && parseFloat(selectedTrade.realizedPnl) < 0 ? 'text-rose-500' : 'text-white'}`}>
                    {selectedTrade.realizedPnl ? (parseFloat(selectedTrade.realizedPnl) > 0 ? `+${selectedTrade.realizedPnl}` : selectedTrade.realizedPnl) : '-'}
                  </div>
                </div>
              </div>

              {associatedOrder && (
                <div>
                  <h4 className="font-bold text-white mb-3 pt-4 border-t border-gray-800">Associated Order</h4>
                  <div className="bg-gray-800 p-3 rounded text-sm flex flex-col gap-1">
                    <div className="flex justify-between text-gray-300">
                      <span>Order Type: {associatedOrder.type}</span>
                      <span>Order Qty: {associatedOrder.quantity}</span>
                    </div>
                    <div className="flex justify-between text-xs text-gray-500 mt-1">
                      <span>Total Filled: {associatedOrder.executedQuantity}</span>
                      <span>Avg Price: {associatedOrder.averageFillPrice}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
            
            <div className="p-4 border-t border-gray-800">
              <Button className="w-full" variant="outline" onClick={() => setSelectedTrade(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
