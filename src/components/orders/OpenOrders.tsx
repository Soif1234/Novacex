import React, { useState, useEffect, useRef } from "react";
import { orderCoreService } from "../../services/orders/OrderCoreService";
import { useAuth } from "../../contexts/AuthContext";
import { orderService as spotOrderService } from "../../services/OrderService";
import { futuresOrderService } from "../../services/futures/FuturesOrderService";
import { Button } from "../ui/Button";

export function OpenOrders({ symbol }: { symbol?: string }) {
  const { user } = useAuth();
  const accountId = user?.id || 'demo-user-1';
  const [orders, setOrders] = useState(orderCoreService.getOrders(accountId));
  const [filterMarket, setFilterMarket] = useState<string>('ALL');
  const [filterSymbol, setFilterSymbol] = useState<string>('ALL');
  const [cancellingIds, setCancellingIds] = useState<Record<string, boolean>>({});
  const cancellingIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const loadOrders = () => setOrders(orderCoreService.getOrders(accountId));
    loadOrders();
    const unsubscribe = orderCoreService.subscribe(loadOrders);
    return () => unsubscribe();
  }, [user, accountId]);

  const handleCancel = async (o: { id: string; market?: string }) => {
    if (cancellingIdsRef.current.has(o.id)) return;
    cancellingIdsRef.current.add(o.id);
    setCancellingIds(prev => ({ ...prev, [o.id]: true }));
    try {
      if (o.market === "FUTURES") {
        await futuresOrderService.cancelOrder(o.id);
      } else {
        await spotOrderService.cancelOrder(o.id);
      }
      setOrders(orderCoreService.getOrders(accountId));
    } catch (err) {
      console.error('Failed to cancel order', err);
    } finally {
      cancellingIdsRef.current.delete(o.id);
      setCancellingIds(prev => {
        const next = { ...prev };
        delete next[o.id];
        return next;
      });
    }
  };

  const openOrders = orders.filter(
    (o) => o.status === "OPEN" || o.status === "PARTIALLY_FILLED" || o.status === "NEW"
  );

  const filteredOrders = openOrders.filter((o) => {
    const symbolMatches = symbol ? o.symbol === symbol : (filterSymbol === "ALL" || o.symbol === filterSymbol);
    const marketMatches = filterMarket === "ALL" || o.market === filterMarket;
    return symbolMatches && marketMatches;
  });

  const uniqueSymbols = Array.from(new Set(openOrders.map((o) => o.symbol)));

  if (openOrders.length === 0) {
    return <div className="text-gray-500 p-4 text-center">No open orders</div>;
  }

  return (
    <div className="flex flex-col gap-4">
      {!symbol && (
        <div className="flex gap-4">
          <select
            value={filterMarket}
            onChange={(e) => setFilterMarket(e.target.value)}
            className="bg-gray-800 text-white rounded p-1"
          >
            <option value="ALL">All Markets</option>
            <option value="SPOT">Spot</option>
            <option value="FUTURES">Futures</option>
          </select>

          <select
            value={filterSymbol}
            onChange={(e) => setFilterSymbol(e.target.value)}
            className="bg-gray-800 text-white rounded p-1"
          >
            <option value="ALL">All Symbols</option>
            {uniqueSymbols.map((sym) => (
              <option key={sym} value={sym}>
                {sym}
              </option>
            ))}
          </select>
        </div>
      )}

      {filteredOrders.length === 0 ? (
        <div className="text-gray-500 p-4 text-center">No matching orders</div>
      ) : (
        filteredOrders.map((o) => (
          <div
            key={o.id}
            className="bg-gray-900 p-3 rounded-lg flex flex-col gap-2 border border-gray-800 text-xs text-gray-300"
          >
            <div className="flex justify-between">
              <span className="font-bold text-white">{o.symbol}</span>
              <span>
                {o.side} {o.type} {o.status === "PARTIALLY_FILLED" ? "(PARTIAL)" : ""}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Price: {o.price || "Market"}</span>
              <span>Qty: {o.quantity}</span>
            </div>
            <div className="flex justify-between">
              <span>Status: {o.status}</span>
              <Button
                size="sm"
                variant="outline"
                className="text-[10px] py-0 h-5"
                disabled={!!cancellingIds[o.id]}
                onClick={() => handleCancel(o)}
              >
                {cancellingIds[o.id] ? "Cancelling..." : "Cancel"}
              </Button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
