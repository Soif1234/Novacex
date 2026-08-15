import { DemoOrder, OrderStatus } from '../types/orders';
import { validateDemoOrder } from './orderValidation';
import { DemoLedger, demoLedger } from './ledger';
import { TradeService, tradeService } from './TradeService';
import { fetchMarketData } from './marketData';
import { Decimal } from 'decimal.js';

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
      const data = sessionStorage.getItem(this.persistKey);
      if (data) {
        this.orders = JSON.parse(data);
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

  public async placeOrder(orderPayload: Partial<DemoOrder>): Promise<DemoOrder> {
    const validation = validateDemoOrder(orderPayload);
    if (!validation.valid) {
      throw new Error(`Invalid order: ${validation.errors.join(', ')}`);
    }

    const order = { ...orderPayload } as DemoOrder;
    
    // For LIMIT orders, lock funds immediately
    if (order.type === 'LIMIT') {
      this.lockFundsForOrder(order);
    }

    this.orders.unshift(order);
    this.save();
    this.notify();

    if (order.type === 'MARKET') {
      await this.executeMarketOrder(order);
    } else if (order.type === 'LIMIT') {
      await this.checkLimitOrders();
    }

    return order;
  }

  private lockFundsForOrder(order: DemoOrder) {
    const baseAsset = order.symbol.replace('USDT', '');
    const quoteAsset = 'USDT'; // Simplified for this demo
    
    const qty = new Decimal(order.quantity);
    
    if (order.side === 'BUY') {
      const price = new Decimal(order.price!);
      const cost = qty.mul(price);
      this.ledger.debit(quoteAsset, cost.toString(), `Lock for limit order ${order.id}`);
    } else {
      this.ledger.debit(baseAsset, qty.toString(), `Lock for limit order ${order.id}`);
    }
  }

  private unlockFundsForOrder(order: DemoOrder) {
    const baseAsset = order.symbol.replace('USDT', '');
    const quoteAsset = 'USDT';
    
    const qty = new Decimal(order.quantity);
    
    if (order.side === 'BUY') {
      const price = new Decimal(order.price!);
      const cost = qty.mul(price);
      this.ledger.credit(quoteAsset, cost.toString(), `Unlock for cancelled order ${order.id}`);
    } else {
      this.ledger.credit(baseAsset, qty.toString(), `Unlock for cancelled order ${order.id}`);
    }
  }

  public cancelOrder(orderId: string) {
    const order = this.orders.find(o => o.id === orderId);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'PENDING') throw new Error('Only PENDING orders can be cancelled');

    if (order.type === 'LIMIT') {
      this.unlockFundsForOrder(order);
    }

    order.status = 'CANCELLED';
    order.updatedAt = Date.now();
    this.save();
    this.notify();
  }

  private async executeMarketOrder(order: DemoOrder) {
    try {
      const markets = await fetchMarketData();
      
      if (order.status !== 'PENDING') {
        return; // Order was cancelled while waiting for market data
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

      if (order.side === 'BUY') {
        this.ledger.debit(quoteAsset, cost.toString(), `Market BUY ${order.id}`);
        this.ledger.credit(baseAsset, qty.toString(), `Market BUY ${order.id}`);
      } else {
        this.ledger.debit(baseAsset, qty.toString(), `Market SELL ${order.id}`);
        this.ledger.credit(quoteAsset, cost.toString(), `Market SELL ${order.id}`);
      }

      // Record Trade
      this.tradeSvc.recordTrade({
        orderId: order.id,
        accountId: order.accountId,
        symbol: order.symbol,
        side: order.side,
        price: price.toString(),
        quantity: qty.toString(),
      });

      this.updateOrderStatus(order.id, 'FILLED');
    } catch (err: any) {
      
      this.updateOrderStatus(order.id, 'REJECTED');
      // Let the caller handle or just leave it rejected
    }
  }

  public async checkLimitOrders() {
    const pendingLimits = this.orders.filter(o => o.status === 'PENDING' && o.type === 'LIMIT');
    if (pendingLimits.length === 0) return;

    try {
      const markets = await fetchMarketData();
      
      for (const order of pendingLimits) {
        if (order.status !== 'PENDING') continue; // Prevent race conditions
        
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
          order.status = 'FILLED'; // Lock status immediately to prevent duplicate execution
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

    if (order.side === 'BUY') {
      // Funds were locked, we now credit the base asset.
      this.ledger.credit(baseAsset, qty.toString(), `Limit BUY execution ${order.id}`);
      
      // If executed at a better price, refund the difference
      if (actualCost.lt(lockedCost)) {
        const refund = lockedCost.minus(actualCost);
        this.ledger.credit(quoteAsset, refund.toString(), `Limit BUY price improvement refund ${order.id}`);
      }
    } else {
      // Base asset was locked, we now credit the quote asset.
      this.ledger.credit(quoteAsset, actualCost.toString(), `Limit SELL execution ${order.id}`);
    }

    this.tradeSvc.recordTrade({
      orderId: order.id,
      accountId: order.accountId,
      symbol: order.symbol,
      side: order.side,
      price: executionPrice.toString(),
      quantity: qty.toString(),
    });

    this.updateOrderStatus(order.id, 'FILLED');
  }

  private updateOrderStatus(orderId: string, status: OrderStatus) {
    const order = this.orders.find(o => o.id === orderId);
    if (order) {
      order.status = status;
      order.updatedAt = Date.now();
      this.save();
      this.notify();
    }
  }

  public reset() {
    this.orders = [];
    this.save();
    this.notify();
  }
}

export const orderService = new OrderService(demoLedger, tradeService, typeof window !== 'undefined');
