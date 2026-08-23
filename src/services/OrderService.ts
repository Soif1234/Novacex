import { syncOrderToCore, syncFillToCore } from './orders/integration';
import { orderCoreService } from './orders/OrderCoreService';
import { DemoOrder, OrderStatus } from '../types/orders';
import { validateDemoOrder } from './orderValidation';
import { TradeService, tradeService } from './TradeService';
import { Decimal } from 'decimal.js';
import { safeParseArray, isValidFinancialString } from './storageUtil';
import { apiClient } from './api/client';
import { OrderEntity, TradeEntity } from './api/types';

export class OrderService {
  private orders: DemoOrder[] = [];
  private persistKey = 'demo_orders';
  private subscribers: Set<() => void> = new Set();

  constructor(
    private tradeSvc: TradeService,
    private persist: boolean = true
  ) {
    if (this.persist) {
      this.load();
    }
  }

  private load() {
    try {
      if (typeof window === 'undefined' && typeof sessionStorage === 'undefined') return;
      const data = sessionStorage.getItem(this.persistKey);
      if (data) {
        const parsed = safeParseArray<DemoOrder>(data, item => (
          item && typeof item.id === 'string' && typeof item.symbol === 'string' && isValidFinancialString(item.quantity) && (item.type !== 'LIMIT' || isValidFinancialString(item.price))
        ));
        if (parsed.length > 0 || data.trim() === '[]') {
          this.orders = parsed;
          this.orders.forEach(o => {
            const status = o.status === 'PENDING' ? 'OPEN' : o.status;
            syncOrderToCore(o.id, o.accountId, o.symbol, 'SPOT', o.side, o.type as any, o.quantity, o.price, undefined, status as any);
          });
        }
      }
    } catch (e) {
      
    }
  }

  private save() {
    if (!this.persist) return;
    try {
      sessionStorage.setItem(this.persistKey, JSON.stringify(this.orders));
    } catch (e) {
      
    }
  }

  public subscribe(callback: () => void) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private notify() {
    this.subscribers.forEach(cb => cb());
  }

  public getOrdersByAccount(accountId: string): DemoOrder[] {
    return this.orders.filter(o => o.accountId === accountId);
  }

  public getPendingOrders(): DemoOrder[] {
    return this.orders.filter(o => o.status === 'PENDING');
  }

  public async fetchOrdersFromBackend(accountId?: string): Promise<DemoOrder[]> {
    try {
      if (typeof window !== 'undefined') {
        const backendOrders = await apiClient.get<OrderEntity[]>('/spot/orders');
        if (Array.isArray(backendOrders)) {
          for (const bo of backendOrders) {
            const existing = this.orders.find(o => o.id === bo.id);
            const status: OrderStatus = bo.status === 'NEW' || bo.status === 'PARTIALLY_FILLED' ? 'PENDING' : (bo.status as OrderStatus);
            if (existing) {
              existing.status = status;
              existing.filledQuantity = bo.filledQuantity;
            } else {
              this.orders.unshift({
                id: bo.id,
                accountId: bo.accountId,
                symbol: bo.symbol,
                side: bo.side,
                type: bo.type,
                price: bo.price,
                quantity: bo.quantity,
                filledQuantity: bo.filledQuantity,
                status,
                createdAt: new Date(bo.createdAt).getTime(),
                updatedAt: new Date(bo.updatedAt).getTime(),
              });
            }
          }
          this.save();
          this.notify();
        }
      }
    } catch {}
    return this.orders;
  }

    public async placeOrder(orderPayload: Partial<DemoOrder>): Promise<DemoOrder> {
    const validation = validateDemoOrder(orderPayload);
    if (!validation.valid) {
      throw new Error(`Invalid order: ${validation.errors.join(', ')}`);
    }

    const order = { ...orderPayload } as DemoOrder;

    if (typeof window !== 'undefined') {
      const backendRes = await apiClient.post<{ order: OrderEntity; trades: TradeEntity[] }>('/spot/orders', {
        accountId: order.accountId,
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        price: order.price,
        quantity: order.quantity,
        clientOrderId: order.id,
      });

      if (backendRes && backendRes.order) {
        const bo = backendRes.order;
        order.id = bo.id;
        order.status = bo.status === 'NEW' || bo.status === 'PARTIALLY_FILLED' ? 'PENDING' : (bo.status as OrderStatus);
        order.filledQuantity = bo.filledQuantity;
        
        this.orders.unshift(order);
        this.save();
        this.notify();

        const coreStatus = order.status === 'PENDING' ? 'OPEN' : order.status;
        syncOrderToCore(order.id, order.accountId, order.symbol, 'SPOT', order.side, order.type as any, order.quantity, order.price, undefined, coreStatus as any);

        if (backendRes.trades && backendRes.trades.length > 0) {
          for (const t of backendRes.trades) {
            this.tradeSvc.recordTrade({
              orderId: t.orderId,
              accountId: t.accountId,
              symbol: t.symbol,
              side: t.side,
              price: t.price,
              quantity: t.quantity,
              fee: t.fee,
              feeAsset: t.feeAsset,
            });
            syncFillToCore(t.id, t.orderId, t.accountId, t.symbol, 'SPOT', t.side, t.quantity, t.price, t.fee, t.feeAsset);
          }
        }

        return order;
      } else {
        throw new Error('Order placement failed: no response from backend');
      }
    } else {
      throw new Error('Order placement not supported offline');
    }
  }

  public async cancelOrder(orderId: string) {
    const order = this.orders.find(o => o.id === orderId);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'PENDING') throw new Error('Only PENDING orders can be cancelled');

    if (typeof window !== 'undefined') {
      await apiClient.post(`/spot/orders/${orderId}/cancel`);
    } else {
      throw new Error('Order cancellation not supported offline');
    }

    order.status = 'CANCELLED';
    order.updatedAt = Date.now();
    this.save();
    this.notify();
    syncOrderToCore(order.id, order.accountId, order.symbol, 'SPOT', order.side, order.type as any, order.quantity, order.price, undefined, 'CANCELLED');
  }

  private updateOrderStatus(orderId: string, status: OrderStatus) {
    const order = this.orders.find(o => o.id === orderId);
    if (order) {
      order.status = status;
      order.updatedAt = Date.now();
      this.save();
      this.notify();
      const coreStatus = status === 'PENDING' ? 'OPEN' : status;
      syncOrderToCore(order.id, order.accountId, order.symbol, 'SPOT', order.side, order.type as any, order.quantity, order.price, undefined, coreStatus as any);
    }
  }

  public reset(accountId?: string) {
    if (accountId) {
      this.orders = this.orders.filter(o => o.accountId !== accountId && (o.accountId || accountId !== 'demo-user-1'));
    } else {
      this.orders = [];
    }
    this.save();
    this.notify();
    orderCoreService.reset(accountId);
  }
}

export const orderService = new OrderService(tradeService, typeof window !== 'undefined');
