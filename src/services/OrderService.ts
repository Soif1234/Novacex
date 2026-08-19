import { syncOrderToCore, syncFillToCore } from './orders/integration';
import { orderCoreService } from './orders/OrderCoreService';
import { DemoOrder, OrderStatus } from '../types/orders';
import { validateDemoOrder } from './orderValidation';
import { DemoLedger, demoLedger } from './ledger';
import { TradeService, tradeService } from './TradeService';
import { fetchMarketData } from './marketData';
import { FeeService } from './FeeService';
import { Decimal } from 'decimal.js';
import { safeParseArray, isValidFinancialString } from './storageUtil';
import { apiClient } from './api/client';
import { OrderEntity, TradeEntity } from './api/types';

export class OrderService {
  private orders: DemoOrder[] = [];
  private persistKey = 'demo_orders';
  private subscribers: Set<() => void> = new Set();

  constructor(
    private ledger: DemoLedger,
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

    // 1. Attempt backend order placement
    try {
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
        }
      }
    } catch (err: any) {
      // If error is a structured API validation/balance error from backend, re-throw it
      if (err.statusCode && err.statusCode >= 400) {
        throw new Error(err.message || 'Order rejected by server');
      }
    }

    // 2. Local fallback for offline/test environments
    if (order.type === 'LIMIT') {
      this.lockFundsForOrder(order);
    }

    this.orders.unshift(order);
    this.save();
    this.notify();
    const coreStatus = order.status === 'PENDING' ? 'OPEN' : order.status;
    syncOrderToCore(order.id, order.accountId, order.symbol, 'SPOT', order.side, order.type as any, order.quantity, order.price, undefined, coreStatus as any);

    if (order.type === 'MARKET') {
      await this.executeMarketOrder(order);
    } else if (order.type === 'LIMIT') {
      await this.checkLimitOrders();
    }

    return order;
  }

  private lockFundsForOrder(order: DemoOrder) {
    const baseAsset = order.symbol.replace('USDT', '');
    const quoteAsset = 'USDT';
    
    const qty = new Decimal(order.quantity);
    
    if (order.side === 'BUY') {
      const price = new Decimal(order.price!);
      const cost = qty.mul(price);
      this.ledger.debit(quoteAsset, cost.toString(), `Lock for limit order ${order.id}`, 'OTHER', `lock_${order.id}`, order.accountId);
    } else {
      this.ledger.debit(baseAsset, qty.toString(), `Lock for limit order ${order.id}`, 'OTHER', `lock_${order.id}`, order.accountId);
    }
  }

  private unlockFundsForOrder(order: DemoOrder) {
    const baseAsset = order.symbol.replace('USDT', '');
    const quoteAsset = 'USDT';
    
    const qty = new Decimal(order.quantity);
    
    if (order.side === 'BUY') {
      const price = new Decimal(order.price!);
      const cost = qty.mul(price);
      this.ledger.credit(quoteAsset, cost.toString(), `Unlock for cancelled order ${order.id}`, 'OTHER', `unlock_${order.id}`, order.accountId);
    } else {
      this.ledger.credit(baseAsset, qty.toString(), `Unlock for cancelled order ${order.id}`, 'OTHER', `unlock_${order.id}`, order.accountId);
    }
  }

  public cancelOrder(orderId: string) {
    const order = this.orders.find(o => o.id === orderId);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'PENDING') throw new Error('Only PENDING orders can be cancelled');

    if (typeof window !== 'undefined') {
      apiClient.post(`/spot/orders/${orderId}/cancel`).catch(() => {});
    }

    if (order.type === 'LIMIT') {
      this.unlockFundsForOrder(order);
    }

    order.status = 'CANCELLED';
    order.updatedAt = Date.now();
    this.save();
    this.notify();
    syncOrderToCore(order.id, order.accountId, order.symbol, 'SPOT', order.side, order.type as any, order.quantity, order.price, undefined, 'CANCELLED');
  }

  private async executeMarketOrder(order: DemoOrder) {
    try {
      const markets = await fetchMarketData();
      
      if (order.status !== 'PENDING') {
        return;
      }
      
      const baseAsset = order.symbol.replace('USDT', '');
      const quoteAsset = 'USDT';
      
      const market = markets.find(m => m.baseAsset === baseAsset);
      if (!market) {
        throw new Error(`Market data not found for ${baseAsset}`);
      }

      const price = new Decimal(market.priceStr);
      const qty = new Decimal(order.quantity);
      const cost = qty.mul(price);

      let fee = new Decimal(0);
      let feeAsset = '';

      const fillId = Date.now().toString() + Math.random().toString().substring(2,8);

      if (order.side === 'BUY') {
        fee = new Decimal(FeeService.calculateFee(qty));
        feeAsset = baseAsset;
        
        this.ledger.debit(quoteAsset, cost.toString(), `Market BUY ${order.id}`, 'OTHER', `buy_${order.id}_debit`, order.accountId);
        this.ledger.credit(baseAsset, qty.toString(), `Market BUY ${order.id}`, 'OTHER', `buy_${order.id}_credit`, order.accountId);
        if (fee.gt(0)) {
          this.ledger.debit(baseAsset, fee.toString(), `TRADING_FEE for ${order.symbol} order ${order.id}`, 'TRADING_FEE', `fee_${fillId}`, order.accountId);
        }
      } else {
        fee = new Decimal(FeeService.calculateFee(cost));
        feeAsset = quoteAsset;
        
        this.ledger.debit(baseAsset, qty.toString(), `Market SELL ${order.id}`, 'OTHER', `sell_${order.id}_debit`, order.accountId);
        this.ledger.credit(quoteAsset, cost.toString(), `Market SELL ${order.id}`, 'OTHER', `sell_${order.id}_credit`, order.accountId);
        if (fee.gt(0)) {
          this.ledger.debit(quoteAsset, fee.toString(), `TRADING_FEE for ${order.symbol} order ${order.id}`, 'TRADING_FEE', `fee_${fillId}`, order.accountId);
        }
      }

      this.tradeSvc.recordTrade({
        orderId: order.id,
        accountId: order.accountId,
        symbol: order.symbol,
        side: order.side,
        price: price.toString(),
        quantity: qty.toString(),
        fee: fee.toString(),
        feeAsset,
      });
      syncFillToCore(Date.now().toString() + Math.random().toString(), order.id, order.accountId, order.symbol, 'SPOT', order.side, qty.toString(), price.toString(), fee.toString(), feeAsset);

      this.updateOrderStatus(order.id, 'FILLED');
    } catch (err: any) {
      this.updateOrderStatus(order.id, 'REJECTED');
    }
  }

  public async checkLimitOrders() {
    const pendingLimits = this.orders.filter(o => o.status === 'PENDING' && o.type === 'LIMIT');
    if (pendingLimits.length === 0) return;

    try {
      const markets = await fetchMarketData();
      
      for (const order of pendingLimits) {
        if (order.status !== 'PENDING') continue;
        
        const baseAsset = order.symbol.replace('USDT', '');
        const market = markets.find(m => m.baseAsset === baseAsset);
        if (!market) continue;

        const currentPrice = new Decimal(market.priceStr);
        const limitPrice = new Decimal(order.price!);

        let shouldExecute = false;
        if (order.side === 'BUY' && currentPrice.lte(limitPrice)) {
          shouldExecute = true;
        } else if (order.side === 'SELL' && currentPrice.gte(limitPrice)) {
          shouldExecute = true;
        }

        if (shouldExecute) {
          order.status = 'FILLED';
          this.executeLimitOrder(order, currentPrice);
        }
      }
    } catch (e) {
      
    }
  }

  private executeLimitOrder(order: DemoOrder, executionPrice: Decimal) {
    const baseAsset = order.symbol.replace('USDT', '');
    const quoteAsset = 'USDT';
    
    const qty = new Decimal(order.quantity);
    const lockedPrice = new Decimal(order.price!);
    const lockedCost = qty.mul(lockedPrice);
    const actualCost = qty.mul(executionPrice);

    let fee = new Decimal(0);
    let feeAsset = '';

    if (order.side === 'BUY') {
      fee = new Decimal(FeeService.calculateFee(qty));
      feeAsset = baseAsset;
      const netQty = qty.minus(fee);

      this.ledger.credit(baseAsset, netQty.toString(), `Limit BUY execution ${order.id}`, 'OTHER', `exec_buy_${order.id}`, order.accountId);
      
      if (actualCost.lt(lockedCost)) {
        const refund = lockedCost.minus(actualCost);
        this.ledger.credit(quoteAsset, refund.toString(), `Limit BUY price improvement refund ${order.id}`, 'OTHER', `refund_${order.id}`, order.accountId);
      }
    } else {
      fee = new Decimal(FeeService.calculateFee(actualCost));
      feeAsset = quoteAsset;
      const netCost = actualCost.minus(fee);

      this.ledger.credit(quoteAsset, netCost.toString(), `Limit SELL execution ${order.id}`, 'OTHER', `exec_sell_${order.id}`, order.accountId);
    }

    this.tradeSvc.recordTrade({
      orderId: order.id,
      accountId: order.accountId,
      symbol: order.symbol,
      side: order.side,
      price: executionPrice.toString(),
      quantity: qty.toString(),
      fee: fee.toString(),
      feeAsset,
    });
    syncFillToCore(Date.now().toString() + Math.random().toString(), order.id, order.accountId, order.symbol, 'SPOT', order.side, qty.toString(), executionPrice.toString(), fee.toString(), feeAsset);

    this.updateOrderStatus(order.id, 'FILLED');
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

export const orderService = new OrderService(demoLedger, tradeService, typeof window !== 'undefined');
