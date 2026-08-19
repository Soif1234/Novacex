import { useState, useEffect } from 'react';
import { orderService } from '../services/OrderService';
import { DemoOrder } from '../types/orders';
import { wsClient } from '../services/websocket/wsClient';

export function useOrders(accountId: string = 'demo-user-1') {
  const [orders, setOrders] = useState<DemoOrder[]>(orderService.getOrdersByAccount(accountId));
  const [pendingOrders, setPendingOrders] = useState<DemoOrder[]>(orderService.getPendingOrders().filter(o => o.accountId === accountId));

  useEffect(() => {
    // Initial fetch from backend if available
    orderService.fetchOrdersFromBackend(accountId);

    const unsubscribe = orderService.subscribe(() => {
      setOrders(orderService.getOrdersByAccount(accountId));
      setPendingOrders(orderService.getPendingOrders().filter(o => o.accountId === accountId));
    });

    const unsubWs = wsClient.subscribe('user:orders', () => {
      orderService.fetchOrdersFromBackend(accountId);
    });

    return () => {
      unsubscribe();
      unsubWs();
    };
  }, [accountId]);

  return { orders, pendingOrders, orderService };
}
