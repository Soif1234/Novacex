import { useState, useEffect } from 'react';
import { orderService } from '../services/OrderService';
import { DemoOrder } from '../types/orders';

export function useOrders(accountId: string = 'demo-user-1') {
  const [orders, setOrders] = useState<DemoOrder[]>(orderService.getOrdersByAccount(accountId));
  const [pendingOrders, setPendingOrders] = useState<DemoOrder[]>(orderService.getPendingOrders().filter(o => o.accountId === accountId));

  useEffect(() => {
    const unsubscribe = orderService.subscribe(() => {
      setOrders(orderService.getOrdersByAccount(accountId));
      setPendingOrders(orderService.getPendingOrders().filter(o => o.accountId === accountId));
    });
    return () => {
      unsubscribe();
    };
  }, [accountId]);

  return { orders, pendingOrders, orderService };
}
