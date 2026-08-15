import { useState, useEffect } from 'react';
import { orderService } from '../services/OrderService';
import { DemoOrder } from '../types/orders';

export function useOrders(accountId: string = 'demo-account') {
  const [orders, setOrders] = useState<DemoOrder[]>(orderService.getOrdersByAccount(accountId));
  const [pendingOrders, setPendingOrders] = useState<DemoOrder[]>(orderService.getPendingOrders().filter(o => o.accountId === accountId));

  useEffect(() => {
    return orderService.subscribe(() => {
      setOrders(orderService.getOrdersByAccount(accountId));
      setPendingOrders(orderService.getPendingOrders().filter(o => o.accountId === accountId));
    });
  }, [accountId]);

  return { orders, pendingOrders, orderService };
}
