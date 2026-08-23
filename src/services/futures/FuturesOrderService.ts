import { syncOrderToCore, syncFillToCore } from '../orders/integration';
import { orderCoreService } from '../orders/OrderCoreService';
import { Decimal } from 'decimal.js';
import { 
  FuturesOrder, 
  FuturesTrade, 
  FuturesPosition, 
  PositionSide, 
  OrderSide,
  MarginMode
} from '../../types/futures';
import { futuresTpSlService } from './FuturesTpSlService';
import { futuresMarketService } from './FuturesMarketService';
import { safeParseArray, isValidFinancialString } from '../storageUtil';
import { apiClient } from '../api/client';
import { OrderEntity, FuturesOrderEntity, FuturesPositionEntity, TradeEntity } from '../api/types';

export class FuturesOrderService {
  public updateMarkPrices() {}
  public checkLimitOrders() {}
  public checkStopOrders() {}
  private orders: FuturesOrder[] = [];
  private trades: FuturesTrade[] = [];
  private positions: FuturesPosition[] = [];
  
  private persistKeyOrders = 'demo_futures_orders';
  private persistKeyTrades = 'demo_futures_trades';
  private persistKeyPositions = 'demo_futures_positions';
  
  private subscribers: Set<() => void> = new Set();
  
  constructor(private persist: boolean = true) {
    if (this.persist) {
      this.load();
    }
  }

  private load() {
    try {
      if (typeof window === 'undefined' && typeof sessionStorage === 'undefined') return;

      const o = sessionStorage.getItem(this.persistKeyOrders);
      if (o) {
        const parsed = safeParseArray<FuturesOrder>(o, ord => (
          ord && typeof ord.id === 'string' && typeof ord.symbol === 'string' && isValidFinancialString(ord.quantity)
        ));
        if (parsed.length > 0 || o.trim() === '[]') {
          this.orders = parsed;
          this.orders.forEach(ord => {
            let status: any = ord.status;
            if (status === 'PENDING' || status === 'TRIGGERED' || status === 'PROCESSING') status = 'OPEN';
            syncOrderToCore(ord.id, ord.accountId, ord.symbol, 'FUTURES', ord.side as any, ord.type as any, ord.quantity, ord.price, ord.stopPrice, status as any);
          });
        }
      }
      
      const t = sessionStorage.getItem(this.persistKeyTrades);
      if (t) {
        const parsed = safeParseArray<FuturesTrade>(t, tr => (
          tr && typeof tr.id === 'string' && typeof tr.symbol === 'string' && isValidFinancialString(tr.quantity)
        ));
        if (parsed.length > 0 || t.trim() === '[]') {
          this.trades = parsed;
        }
      }
      
      const p = sessionStorage.getItem(this.persistKeyPositions);
      if (p) {
        const parsed = safeParseArray<FuturesPosition>(p, pos => (
          pos && typeof pos.positionId === 'string' && typeof pos.symbol === 'string' && isValidFinancialString(pos.quantity)
        ));
        if (parsed.length > 0 || p.trim() === '[]') {
          this.positions = parsed;
        }
      }
    } catch (e) {
    }
  }

  private save() {
    if (!this.persist) return;
    
    // Sync to core
    this.orders.forEach(o => {
      let status: any = o.status;
      if (status === 'PENDING' || status === 'TRIGGERED' || status === 'PROCESSING') status = 'OPEN';
      syncOrderToCore(o.id, o.accountId, o.symbol, 'FUTURES', o.side as any, o.type as any, o.quantity, o.price, o.stopPrice, status as any);
    });

    try {
      sessionStorage.setItem(this.persistKeyOrders, JSON.stringify(this.orders));
      sessionStorage.setItem(this.persistKeyTrades, JSON.stringify(this.trades));
      sessionStorage.setItem(this.persistKeyPositions, JSON.stringify(this.positions));
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

  public getOrders(accountId: string): FuturesOrder[] {
    return this.orders.filter(o => o.accountId === accountId);
  }
  
  public getAllOrders(): FuturesOrder[] {
    return [...this.orders];
  }
  
  public getPositions(accountId: string): FuturesPosition[] {
    return this.positions.filter(p => p.accountId === accountId);
  }

  public getAllPositions(): FuturesPosition[] {
    return [...this.positions];
  }

  public getTrades(accountId: string): FuturesTrade[] {
    return this.trades.filter(t => t.accountId === accountId);
  }

  public async fetchPositionsFromBackend(accountId?: string): Promise<FuturesPosition[]> {
    try {
      if (typeof window !== 'undefined') {
        const backendPositions = await apiClient.get<FuturesPositionEntity[]>('/futures/positions');
        if (Array.isArray(backendPositions)) {
          this.positions = backendPositions.map(bp => ({
            positionId: bp.id,
            accountId: bp.accountId,
            symbol: bp.symbol,
            side: bp.side as PositionSide,
            quantity: bp.quantity,
            entryPrice: bp.entryPrice,
            markPrice: bp.markPrice,
            liquidationPrice: bp.liquidationPrice,
            leverage: bp.leverage,
            marginMode: bp.marginMode as MarginMode,
            initialMargin: bp.initialMargin,
            maintenanceMargin: bp.maintenanceMargin,
            realizedPnl: bp.realizedPnl,
            unrealizedPnl: bp.unrealizedPnl || '0',
            status: bp.status as any,
            createdAt: new Date(bp.createdAt).getTime(),
            updatedAt: new Date(bp.updatedAt).getTime(),
          }));
          this.save();
          this.notify();
        }
      }
    } catch {}
    return this.positions;
  }

  public async fetchOrdersFromBackend(accountId?: string): Promise<FuturesOrder[]> {
    try {
      if (typeof window !== 'undefined') {
        const backendOrders = await apiClient.get<OrderEntity[]>('/futures/orders');
        if (Array.isArray(backendOrders)) {
          for (const bo of backendOrders) {
            const existing = this.orders.find(o => o.id === bo.id);
            const status: any = bo.status === 'NEW' || bo.status === 'PARTIALLY_FILLED' ? 'PENDING' : bo.status;
            if (existing) {
              existing.status = status;
              existing.filledQuantity = bo.filledQuantity;
            } else {
              this.orders.unshift({
                id: bo.id,
                accountId: bo.accountId,
                symbol: bo.symbol,
                side: bo.side as OrderSide,
                positionSide: 'LONG',
                type: bo.type as any,
                price: bo.price,
                quantity: bo.quantity,
                filledQuantity: bo.filledQuantity,
                remainingQuantity: bo.remainingQuantity,
                status,
                leverage: 10,
                marginMode: 'ISOLATED',
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

    public async placeOrder(orderPayload: Partial<FuturesOrder>): Promise<FuturesOrder> {
    if (!orderPayload.accountId || !orderPayload.symbol || !orderPayload.quantity || !orderPayload.leverage || !orderPayload.marginMode) {
      throw new Error('Missing required order fields');
    }

    if (typeof window !== 'undefined') {
      const backendRes = await apiClient.post<{
        order: OrderEntity;
        futuresOrder: FuturesOrderEntity;
        position?: FuturesPositionEntity;
        trade?: TradeEntity;
      }>('/futures/orders', {
        accountId: orderPayload.accountId,
        symbol: orderPayload.symbol,
        side: orderPayload.side,
        positionSide: orderPayload.positionSide,
        type: orderPayload.type,
        price: orderPayload.price,
        quantity: orderPayload.quantity,
        leverage: orderPayload.leverage,
        marginMode: orderPayload.marginMode,
        reduceOnly: orderPayload.reduceOnly,
        closePosition: orderPayload.closePosition,
      });

      if (backendRes && backendRes.order) {
        const bo = backendRes.order;
        const fo = backendRes.futuresOrder;
        const status: any = bo.status === 'NEW' || bo.status === 'PARTIALLY_FILLED' ? 'PENDING' : bo.status;

        const syncedOrder: FuturesOrder = {
          id: bo.id,
          accountId: bo.accountId,
          symbol: bo.symbol,
          side: bo.side as OrderSide,
          positionSide: fo ? (fo.positionSide as PositionSide) : (orderPayload.positionSide as PositionSide),
          type: bo.type as any,
          quantity: bo.quantity,
          price: bo.price,
          status,
          leverage: fo ? fo.leverage : orderPayload.leverage!,
          marginMode: fo ? (fo.marginMode as MarginMode) : (orderPayload.marginMode as MarginMode),
          filledQuantity: bo.filledQuantity,
          remainingQuantity: bo.remainingQuantity,
          reduceOnly: fo ? fo.reduceOnly : orderPayload.reduceOnly,
          closePosition: fo ? fo.closePosition : orderPayload.closePosition,
          createdAt: new Date(bo.createdAt).getTime(),
          updatedAt: new Date(bo.updatedAt).getTime(),
        };

        this.orders.unshift(syncedOrder);
        
        // Also add position to local cache if created
        if (backendRes.position) {
          const bp = backendRes.position;
          const existingPosIndex = this.positions.findIndex(p => p.positionId === bp.id);
      // @ts-ignore
      // @ts-ignore
          const newPos: FuturesPosition = {
            positionId: bp.id,
            accountId: bp.accountId,
            symbol: bp.symbol,
            side: bp.side as PositionSide,
            quantity: bp.quantity,
            entryPrice: bp.entryPrice,
            leverage: bp.leverage,
            marginMode: bp.marginMode as MarginMode,
            initialMargin: bp.initialMargin,
            maintenanceMargin: bp.maintenanceMargin,
            unrealizedPnl: bp.unrealizedPnl,
            liquidationPrice: bp.liquidationPrice,
            status: bp.status as 'OPEN'|'CLOSED',
            createdAt: new Date(bp.createdAt).getTime(),
            updatedAt: new Date(bp.updatedAt).getTime(),
          };
          if (existingPosIndex >= 0) {
            this.positions[existingPosIndex] = newPos;
          } else {
            this.positions.push(newPos);
          }
        }

        this.save();
        this.notify();
        return syncedOrder;
      } else {
        throw new Error('Futures order placement failed: no response from backend');
      }
    } else {
      throw new Error('Futures order placement not supported offline');
    }
  }

  public async cancelOrder(orderId: string) {
    const order = this.orders.find(o => o.id === orderId);
    if (!order) throw new Error('Order not found');

    if (typeof window !== 'undefined') {
      await apiClient.post(`/futures/orders/${orderId}/cancel`);
    } else {
      throw new Error('Futures order cancellation not supported offline');
    }

    order.status = 'CANCELLED';
    order.updatedAt = Date.now();
    this.save();
    this.notify();
  }

  public async addIsolatedMargin(accountId: string, positionId: string, amount: string): Promise<FuturesPosition> {
    if (typeof window !== 'undefined') {
      const res = await apiClient.post<FuturesPositionEntity>(`/futures/positions/${positionId}/margin`, { amount, type: 'ADD' });
      return this.updatePositionFromBackend(res);
    }
    throw new Error('Not supported offline');
  }

  public async removeIsolatedMargin(accountId: string, positionId: string, amount: string): Promise<FuturesPosition> {
    if (typeof window !== 'undefined') {
      const res = await apiClient.post<FuturesPositionEntity>(`/futures/positions/${positionId}/margin`, { amount, type: 'REMOVE' });
      return this.updatePositionFromBackend(res);
    }
    throw new Error('Not supported offline');
  }

  private updatePositionFromBackend(bp: FuturesPositionEntity): FuturesPosition {
      // @ts-ignore
    const existingPosIndex = this.positions.findIndex(p => p.positionId === bp.id);
      // @ts-ignore
    const newPos: FuturesPosition = {
      positionId: bp.id,
      accountId: bp.accountId,
      symbol: bp.symbol,
      side: bp.side as PositionSide,
      quantity: bp.quantity,
      entryPrice: bp.entryPrice,
      leverage: bp.leverage,
      marginMode: bp.marginMode as MarginMode,
      initialMargin: bp.initialMargin,
      maintenanceMargin: bp.maintenanceMargin,
      unrealizedPnl: bp.unrealizedPnl,
      liquidationPrice: bp.liquidationPrice,
      status: bp.status as 'OPEN'|'CLOSED',
      createdAt: new Date(bp.createdAt).getTime(),
      updatedAt: new Date(bp.updatedAt).getTime(),
    };
    if (existingPosIndex >= 0) {
      this.positions[existingPosIndex] = newPos;
    } else {
      this.positions.push(newPos);
    }
    this.save();
    this.notify();
    return newPos;
  }

  public async closePosition(accountId: string, positionId: string, type: 'MARKET' = 'MARKET'): Promise<void> {
    if (typeof window !== 'undefined') {
      await apiClient.post(`/futures/positions/${positionId}/close`, { type });
      await this.fetchPositionsFromBackend(accountId);
    } else {
      throw new Error('Not supported offline');
    }
  }

  public async updateLeverage(accountId: string, symbol: string, marginMode: MarginMode, leverage: number) {
    if (typeof window !== 'undefined') {
      await apiClient.post(`/futures/account/leverage`, { symbol, marginMode, leverage });
      await this.fetchPositionsFromBackend(accountId);
    } else {
      throw new Error('Not supported offline');
    }
  }

  public reset(accountId?: string) {
    if (accountId) {
      this.orders = this.orders.filter(o => o.accountId !== accountId && (o.accountId || accountId !== 'demo-user-1'));
      this.trades = this.trades.filter(t => t.accountId !== accountId && (t.accountId || accountId !== 'demo-user-1'));
      this.positions = this.positions.filter(p => p.accountId !== accountId && (p.accountId || accountId !== 'demo-user-1'));
    } else {
      this.orders = [];
      this.trades = [];
      this.positions = [];
    }
    this.save();
    this.notify();
    orderCoreService.reset(accountId);
  }
}

export const futuresOrderService = new FuturesOrderService(typeof window !== 'undefined');
