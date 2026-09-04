import React, { useState, useEffect } from "react";
import { orderCoreService } from "../../services/orders/OrderCoreService";
import { tradeFillService } from "../../services/orders/TradeFillService";
import { useAuth } from "../../contexts/AuthContext";
import { Button } from "../ui/Button";
import { Order, TradeFill } from "../../types/orderCore";
import { Search, ChevronDown, ChevronUp, X } from "lucide-react";
import { tradingPairRegistry } from "../../services/market/TradingPairRegistry";
import { safeFormatDate } from "../../services/storageUtil";
import { orderService as spotOrderService } from "../../services/OrderService";
import { futuresOrderService } from "../../services/futures/FuturesOrderService";
import { wsClient } from "../../services/websocket/wsClient";

export function OrderHistory() {
  const { user } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  
  const [filterStatus, setFilterStatus] = useState<string>("ALL");
  const [filterMarket, setFilterMarket] = useState<string>("ALL");
  const [filterSymbol, setFilterSymbol] = useState<string>("ALL");
  const [filterSide, setFilterSide] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [orderFills, setOrderFills] = useState<TradeFill[]>([]);

  const accountId = user?.id || 'demo-user-1';

  useEffect(() => {
    let isMounted = true;
    const loadOrders = () => {
      if (isMounted) {
        const allOrders = orderCoreService.getOrders(accountId);
        const completed = allOrders.filter(
          (o) => o.status === "FILLED" || o.status === "CANCELLED" || o.status === "REJECTED" || o.status === "EXPIRED"
        );
        setOrders(completed);
      }
    };

    loadOrders();

    const syncBackend = async () => {
      try {
        const promises: Promise<any>[] = [];
        if (typeof spotOrderService?.fetchOrdersFromBackend === 'function') {
          promises.push(spotOrderService.fetchOrdersFromBackend(accountId));
        }
        if (typeof futuresOrderService?.fetchOrdersFromBackend === 'function') {
          promises.push(futuresOrderService.fetchOrdersFromBackend(accountId));
        }
        if (promises.length > 0) {
          await Promise.allSettled(promises);
          if (isMounted) {
            loadOrders();
          }
        }
      } catch (err) {}
    };

    syncBackend();

    const unsubscribe = orderCoreService.subscribe(loadOrders);

    const unsubWs = typeof wsClient?.subscribe === 'function' ? wsClient.subscribe('user:orders', () => {
      syncBackend();
    }) : () => {};

    const unsubStatus = typeof wsClient?.onStatusChange === 'function' ? wsClient.onStatusChange((status) => {
      if (status === 'CONNECTED') {
        syncBackend();
      }
    }) : () => {};

    return () => {
      isMounted = false;
      unsubscribe();
      unsubWs();
      unsubStatus();
    };
  }, [user, accountId]);

  const handleOrderClick = (order: Order) => {
    setSelectedOrder(order);
    const fills = tradeFillService.getFillsByOrder(order.id, accountId);
    setOrderFills(fills);
  };

  const filteredOrders = orders.filter((o) => {
    if (filterStatus !== "ALL" && o.status !== filterStatus) return false;
    if (filterMarket !== "ALL" && o.market !== filterMarket) return false;
    if (filterSymbol !== "ALL" && o.symbol !== filterSymbol) return false;
    if (filterSide !== "ALL") {
       if (filterSide === "BUY" && o.side !== "BUY" && o.side !== "LONG") return false;
       if (filterSide === "SELL" && o.side !== "SELL" && o.side !== "SHORT") return false;
    }
    
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      if (!o.id.toLowerCase().includes(q) && !o.symbol.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const sortedOrders = [...filteredOrders].sort((a, b) => {
    const timeA = Number(a.completedAt || a.updatedAt || a.createdAt || 0);
    const timeB = Number(b.completedAt || b.updatedAt || b.createdAt || 0);
    return timeB - timeA;
  });

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
            placeholder="Search Order ID or Symbol"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-gray-900 border border-gray-800 rounded-lg pl-9 pr-3 py-2 text-white focus:outline-none focus:border-emerald-500"
          />
        </div>
        
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="bg-gray-900 border border-gray-800 text-white rounded-lg px-3 py-2 focus:outline-none"
        >
          <option value="ALL">All Status</option>
          <option value="FILLED">Filled</option>
          <option value="CANCELLED">Cancelled</option>
          <option value="REJECTED">Rejected</option>
          <option value="EXPIRED">Expired</option>
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

      {sortedOrders.length === 0 ? (
        <div className="text-gray-500 p-8 text-center bg-gray-900 rounded-lg border border-gray-800">
          No order history yet.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sortedOrders.map((o) => (
            <div
              key={o.id}
              onClick={() => handleOrderClick(o)}
              className="bg-gray-900 p-4 rounded-lg flex flex-col gap-3 border border-gray-800 cursor-pointer hover:bg-gray-800 transition-colors"
            >
              <div className="flex justify-between items-start">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-white text-base">{o.symbol}</span>
                    <span className={`text-xs px-2 py-0.5 rounded font-bold ${
                      o.side === 'BUY' || o.side === 'LONG' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'
                    }`}>
                      {o.side}
                    </span>
                    <span className="bg-gray-800 text-gray-300 text-xs px-2 py-0.5 rounded">{o.type}</span>
                    <span className="bg-gray-800 text-gray-300 text-xs px-2 py-0.5 rounded">{o.market}</span>
                  </div>
                  <div className="text-gray-500 text-xs mt-1">ID: {o.id}</div>
                </div>
                <div className="text-right">
                  <div className={`font-bold ${
                    o.status === 'FILLED' ? 'text-emerald-500' :
                    o.status === 'CANCELLED' ? 'text-gray-400' :
                    'text-rose-500'
                  }`}>
                    {o.status}
                  </div>
                  <div className="text-gray-500 text-xs mt-1">
                    {safeFormatDate(o.completedAt || o.updatedAt || o.createdAt)}
                  </div>
                </div>
              </div>
              
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mt-2 pt-3 border-t border-gray-800">
                <div>
                  <div className="text-gray-500 text-xs">Price</div>
                  <div className="text-gray-300">{o.price || 'Market'}</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs">Amount</div>
                  <div className="text-gray-300">{o.quantity}</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs">Filled</div>
                  <div className="text-gray-300">{o.executedQuantity}</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs">Avg Price</div>
                  <div className="text-gray-300">{o.averageFillPrice || '-'}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {selectedOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setSelectedOrder(null)}>
          <div 
            className="bg-gray-900 border border-gray-800 rounded-xl max-w-lg w-full overflow-hidden" 
            onClick={e => e.stopPropagation()}
          >
            <div className="p-4 border-b border-gray-800 flex justify-between items-center">
              <h3 className="font-bold text-white text-lg">Order Details</h3>
              <button onClick={() => setSelectedOrder(null)} className="text-gray-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-6 overflow-y-auto max-h-[70vh]">
              <div className="grid grid-cols-2 gap-y-4 gap-x-8 mb-6">
                <div>
                  <div className="text-gray-500 text-xs mb-1">Order ID</div>
                  <div className="text-white text-sm break-all">{selectedOrder.id}</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs mb-1">Status</div>
                  <div className={`text-sm font-bold ${
                    selectedOrder.status === 'FILLED' ? 'text-emerald-500' :
                    selectedOrder.status === 'CANCELLED' ? 'text-gray-400' :
                    'text-rose-500'
                  }`}>{selectedOrder.status}</div>
                </div>
                
                <div>
                  <div className="text-gray-500 text-xs mb-1">Symbol</div>
                  <div className="text-white text-sm font-bold">{selectedOrder.symbol}</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs mb-1">Market</div>
                  <div className="text-white text-sm">{selectedOrder.market}</div>
                </div>

                <div>
                  <div className="text-gray-500 text-xs mb-1">Side</div>
                  <div className={`text-sm font-bold ${
                    selectedOrder.side === 'BUY' || selectedOrder.side === 'LONG' ? 'text-emerald-500' : 'text-rose-500'
                  }`}>{selectedOrder.side}</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs mb-1">Type</div>
                  <div className="text-white text-sm">{selectedOrder.type}</div>
                </div>

                <div>
                  <div className="text-gray-500 text-xs mb-1">Order Qty</div>
                  <div className="text-white text-sm">{selectedOrder.quantity}</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs mb-1">Order Price</div>
                  <div className="text-white text-sm">{selectedOrder.price || 'Market'}</div>
                </div>
                
                <div>
                  <div className="text-gray-500 text-xs mb-1">Executed Qty</div>
                  <div className="text-white text-sm">{selectedOrder.executedQuantity}</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs mb-1">Avg Fill Price</div>
                  <div className="text-white text-sm">{selectedOrder.averageFillPrice || '-'}</div>
                </div>

                <div>
                  <div className="text-gray-500 text-xs mb-1">Created At</div>
                  <div className="text-white text-sm">{safeFormatDate(selectedOrder.createdAt)}</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs mb-1">Completed At</div>
                  <div className="text-white text-sm">{safeFormatDate(selectedOrder.completedAt || selectedOrder.updatedAt)}</div>
                </div>
              </div>

              {orderFills.length > 0 && (
                <div>
                  <h4 className="font-bold text-white mb-3 pt-4 border-t border-gray-800">Trade Fills</h4>
                  <div className="flex flex-col gap-2">
                    {orderFills.map((fill) => (
                      <div key={fill.id} className="bg-gray-800 p-3 rounded text-sm flex flex-col gap-1">
                        <div className="flex justify-between text-gray-300">
                          <span>Price: {fill.price}</span>
                          <span>Qty: {fill.quantity}</span>
                        </div>
                        <div className="flex justify-between text-xs text-gray-500 mt-1">
                          <span>Fee: {fill.fee} {fill.feeAsset}</span>
                          <span>{safeFormatDate(fill.createdAt)}</span>
                        </div>
                        {fill.realizedPnl && parseFloat(fill.realizedPnl) !== 0 && (
                          <div className={`text-xs mt-1 text-right ${parseFloat(fill.realizedPnl) > 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                            PnL: {parseFloat(fill.realizedPnl) > 0 ? '+' : ''}{fill.realizedPnl}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            
            <div className="p-4 border-t border-gray-800">
              <Button className="w-full" variant="outline" onClick={() => setSelectedOrder(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
