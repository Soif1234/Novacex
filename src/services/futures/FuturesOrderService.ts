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
import { futuresRiskService } from './FuturesRiskService';
import { futuresTpSlService } from './FuturesTpSlService';
import { futuresPositionService } from './FuturesPositionService';
import { liquidationService } from './LiquidationService';
import { futuresMarketService } from './FuturesMarketService';
import { DemoLedger, demoLedger } from '../ledger';
import { futuresFeeService } from './FuturesFeeService';
import { safeParseArray, isValidFinancialString } from '../storageUtil';

export class FuturesOrderService {
  private orders: FuturesOrder[] = [];
  private trades: FuturesTrade[] = [];
  private positions: FuturesPosition[] = [];
  
  private persistKeyOrders = 'demo_futures_orders';
  private persistKeyTrades = 'demo_futures_trades';
  private persistKeyPositions = 'demo_futures_positions';
  
  private subscribers: Set<() => void> = new Set();
  
  constructor(private ledger: DemoLedger, private persist: boolean = true) {
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

  public async placeOrder(orderPayload: Partial<FuturesOrder>): Promise<FuturesOrder> {
    if (!orderPayload.accountId || !orderPayload.symbol || !orderPayload.quantity || !orderPayload.leverage || !orderPayload.marginMode) {
      throw new Error('Missing required order fields');
    }

    if (!['MARKET', 'LIMIT', 'STOP_MARKET', 'STOP_LIMIT'].includes(orderPayload.type!)) {
      throw new Error('Unsupported order type');
    }

    if (orderPayload.type === 'LIMIT' && !orderPayload.price) {
      throw new Error('LIMIT order requires a price');
    }

    if ((orderPayload.type === 'STOP_MARKET' || orderPayload.type === 'STOP_LIMIT') && !orderPayload.stopPrice) {
      throw new Error('STOP order requires a stopPrice');
    }

    if ((orderPayload.type === 'STOP_MARKET' || orderPayload.type === 'STOP_LIMIT')) {
        const stopPriceDec = new Decimal(orderPayload.stopPrice!);
        if (stopPriceDec.lte(0)) throw new Error('Invalid stop price');
    }

    if (orderPayload.type === 'STOP_LIMIT' && !orderPayload.price) {
      throw new Error('STOP_LIMIT order requires a limit price');
    }


    if (orderPayload.type === 'LIMIT') {
        const priceDec = new Decimal(orderPayload.price!);
        if (priceDec.lte(0)) throw new Error('Invalid limit price');
    }

    const market = await futuresMarketService.getMarket(orderPayload.symbol);
    if (!market) {
      throw new Error(`Invalid symbol: ${orderPayload.symbol}`);
    }

    const qty = new Decimal(orderPayload.quantity);
    if (qty.lte(0) || qty.lt(new Decimal(market.minimumQuantity))) {
      throw new Error(`Quantity is below the minimum for ${orderPayload.symbol}.`);
    }

    if (!futuresRiskService.isValidLeverage(orderPayload.leverage)) {
      throw new Error(`Invalid leverage: ${orderPayload.leverage}`);
    }

    if (orderPayload.leverage > market.maximumLeverage) {
      throw new Error(`Leverage exceeds maximum allowed: ${market.maximumLeverage}`);
    }

    const orderId = Math.random().toString(36).substring(2, 11);
    const isOpening = (orderPayload.side === 'BUY' && orderPayload.positionSide === 'LONG') || (orderPayload.side === 'SELL' && orderPayload.positionSide === 'SHORT');

    if (orderPayload.type === 'LIMIT' && isOpening) {
        const requiredMargin = futuresRiskService.calculateInitialMargin(orderPayload.quantity, orderPayload.price!, orderPayload.leverage);
        const availableMargin = this.ledger.getBalance('FUTURES_USDT', orderPayload.accountId);
        
        if (!futuresRiskService.hasSufficientMargin(availableMargin, requiredMargin)) {
            throw new Error(`Insufficient margin. Required: ${requiredMargin} USDT, Available: ${availableMargin} USDT`);
        }
        
        // Debit immediately to reserve
        this.ledger.debit('FUTURES_USDT', requiredMargin, `Lock for ${orderPayload.symbol} LIMIT order ${orderId}`, 'MARGIN', `margin_lock_${orderId}`, orderPayload.accountId);
    }

    const now = Date.now();
    const order: FuturesOrder = {
      id: orderId,
      accountId: orderPayload.accountId,
      symbol: orderPayload.symbol,
      side: orderPayload.side as OrderSide,
      positionSide: orderPayload.positionSide as PositionSide,
      type: orderPayload.type,
      reduceOnly: orderPayload.reduceOnly,
      filledQuantity: "0",
      remainingQuantity: orderPayload.quantity,
      closePosition: orderPayload.closePosition,
      price: orderPayload.price,
      stopPrice: orderPayload.stopPrice,
      isTriggered: false,
      quantity: orderPayload.quantity,
      status: 'NEW',
      leverage: orderPayload.leverage,
      marginMode: orderPayload.marginMode as MarginMode,
      createdAt: now,
      updatedAt: now
    };

    this.orders.unshift(order);
    this.save();
    this.notify();

    // Prevent duplicate execution by locking status
    if (order.status !== 'NEW') {
        throw new Error('Order already processing');
    }
    
    order.status = 'PENDING';
    
    
    try {
      if (order.type === 'MARKET') {
        await this.executeOrder(order, market, new Decimal(market.lastPrice));
      } else {
        this.save();
        this.notify();
        await this.checkLimitOrders();
        await this.checkStopOrders();
      }
    }
 catch (e: any) {
      order.status = 'REJECTED';
      order.updatedAt = Date.now();
      
      // refund reserved margin if limit
      if (order.type === 'LIMIT' && isOpening) {
        const requiredMargin = futuresRiskService.calculateInitialMargin(order.quantity, order.price!, order.leverage);
        this.ledger.credit('FUTURES_USDT', requiredMargin, `Refund for rejected ${order.symbol} LIMIT order ${order.id}`, 'MARGIN', `margin_refund_${order.id}`, order.accountId);
      }
      
      this.save();
      this.notify();
      throw e;
    }

    return order;
  }

  public async cancelOrder(orderId: string) {
    const order = this.orders.find(o => o.id === orderId);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'PENDING') throw new Error('Only PENDING orders can be cancelled');

    order.status = 'CANCELLED';
    order.updatedAt = Date.now();

    const isOpening = (order.side === 'BUY' && order.positionSide === 'LONG') || (order.side === 'SELL' && order.positionSide === 'SHORT');
    if ((order.type === 'LIMIT' || (order.type === 'STOP_LIMIT' && order.isTriggered)) && isOpening) {
        const requiredMargin = futuresRiskService.calculateInitialMargin(order.quantity, order.price!, order.leverage);
        this.ledger.credit('FUTURES_USDT', requiredMargin, `Unlock for cancelled order ${order.id}`, 'MARGIN', `margin_unlock_${order.id}`, order.accountId);
    }

    this.save();
    this.notify();
  }

  
  public async checkStopOrders(markPrices?: Record<string, string>) {
    const pendingStops = this.orders.filter(o => o.status === 'PENDING' && !o.isTriggered && (o.type === 'STOP_MARKET' || o.type === 'STOP_LIMIT'));
    if (pendingStops.length === 0) return;

    for (const order of pendingStops) {
        if (order.status !== 'PENDING' || order.isTriggered) continue;

        const market = await futuresMarketService.getMarket(order.symbol);
        if (!market) continue;

        const priceStr = (markPrices && markPrices[order.symbol]) ? markPrices[order.symbol] : market.lastPrice;
        const currentPrice = new Decimal(priceStr);
        if (currentPrice.lte(0)) continue;
        const stopPrice = new Decimal(order.stopPrice!);

        let shouldTrigger = false;
        // Basic stop logic:
        // BUY STOP triggers when market price >= stopPrice
        // SELL STOP triggers when market price <= stopPrice
        if (order.side === 'BUY' && currentPrice.gte(stopPrice)) {
            shouldTrigger = true;
        } else if (order.side === 'SELL' && currentPrice.lte(stopPrice)) {
            shouldTrigger = true;
        }

        if (shouldTrigger) {
            order.isTriggered = true;
            
            if (order.type === 'STOP_MARKET') {
                order.status = 'PROCESSING' as any;
                try {
                    await this.executeOrder(order, market, currentPrice);
                } catch (e) {
                    order.status = 'REJECTED';
                    order.updatedAt = Date.now();
                    this.save();
                    this.notify();
                }
            } else if (order.type === 'STOP_LIMIT') {
                // Now it acts as a limit order, we lock margin if it's opening
                const isOpening = (order.side === 'BUY' && order.positionSide === 'LONG') || (order.side === 'SELL' && order.positionSide === 'SHORT');
                if (isOpening) {
                    const requiredMargin = futuresRiskService.calculateInitialMargin(order.quantity, order.price!, order.leverage);
                    const availableMargin = this.ledger.getBalance('FUTURES_USDT', order.accountId);
                    
                    if (futuresRiskService.hasSufficientMargin(availableMargin, requiredMargin)) {
                        this.ledger.debit('FUTURES_USDT', requiredMargin, `Lock for ${order.symbol} STOP_LIMIT order`, 'OTHER', `lock_stop_${order.id}`, order.accountId);
                        order.updatedAt = Date.now();
                        this.save();
                        this.notify();
                        await this.checkLimitOrders(markPrices); // might execute immediately
                    } else {
                        order.status = 'REJECTED';
                        order.updatedAt = Date.now();
                        this.save();
                        this.notify();
                    }
                } else {
                    order.updatedAt = Date.now();
                    this.save();
                    this.notify();
                    await this.checkLimitOrders(markPrices);
                }
            }
        }
    }
  }

  public async checkLimitOrders(markPrices?: Record<string, string>) {
    const pendingLimits = this.orders.filter(o => o.status === 'PENDING' && (o.type === 'LIMIT' || (o.type === 'STOP_LIMIT' && o.isTriggered)));
    if (pendingLimits.length === 0) return;

    for (const order of pendingLimits) {
        if (order.status !== 'PENDING') continue;

        const market = await futuresMarketService.getMarket(order.symbol);
        if (!market) continue;

        const priceStr = (markPrices && markPrices[order.symbol]) ? markPrices[order.symbol] : market.lastPrice;
        const currentPrice = new Decimal(priceStr);
        if (currentPrice.lte(0)) continue;
        const limitPrice = new Decimal(order.price!);

        let shouldExecute = false;
        console.log('checkLimitOrders debug', { side: order.side, currentPrice: currentPrice.toString(), limitPrice: limitPrice.toString() });
        // LONG: BUY (open) or SELL (close)
        // BUY order executes when market <= limit
        // SELL order executes when market >= limit
        if (order.side === 'BUY' && currentPrice.lte(limitPrice)) {
            shouldExecute = true;
        } else if (order.side === 'SELL' && currentPrice.gte(limitPrice)) {
            shouldExecute = true;
        }

        if (shouldExecute) {
            order.status = 'PROCESSING' as any; // lock
            try {
                // For LIMIT orders, execution price is typically the limit price or better.
                // Note: margin was already reserved upon placement in 'margin_lock_${order.id}'
                // executeOrder consumes this reservation without calling ledger.debit again.
                await this.executeOrder(order, market, limitPrice);
            } catch (e) {
                order.status = 'REJECTED';
                order.updatedAt = Date.now();
                const isOpening = (order.side === 'BUY' && order.positionSide === 'LONG') || (order.side === 'SELL' && order.positionSide === 'SHORT');
                if (isOpening) {
                    const requiredMargin = futuresRiskService.calculateInitialMargin(order.quantity, order.price!, order.leverage);
                    this.ledger.credit('FUTURES_USDT', requiredMargin, `Refund for rejected ${order.symbol} LIMIT order ${order.id}`, 'MARGIN', `margin_refund_${order.id}`, order.accountId);
                }
                this.save();
                this.notify();
            }
        }
    }
  }

  private async executeOrder(order: FuturesOrder, market: any, execPrice: Decimal) {
    if (order.status !== 'PENDING' && (order.status as any) !== 'TRIGGERED' && (order.status as any) !== 'PROCESSING') throw new Error('Order already executed');
    if (execPrice.lte(0)) {
        throw new Error('Invalid market price');
    }

    const isOpening = (order.side === 'BUY' && order.positionSide === 'LONG') || (order.side === 'SELL' && order.positionSide === 'SHORT');
    const isClosing = (order.side === 'SELL' && order.positionSide === 'LONG') || (order.side === 'BUY' && order.positionSide === 'SHORT');

    let realizedPnl = '0';

    const existingPositionIndex = this.positions.findIndex(p => 
      p.accountId === order.accountId && 
      p.symbol === order.symbol && 
      p.side === order.positionSide &&
      p.status === 'OPEN'
    );
    const existingPosition = existingPositionIndex !== -1 ? this.positions[existingPositionIndex] : null;

    if (isOpening) {
        // Calculate required margin
        let requiredMargin = futuresRiskService.calculateInitialMargin(order.quantity, execPrice.toString(), order.leverage);
        
        const isLimitReserved = (order.type === 'LIMIT' || (order.type === 'STOP_LIMIT' && order.isTriggered));

        if (!isLimitReserved) {
            // MARKET opening order: debit required margin once at execution
            const availableMargin = this.ledger.getBalance('FUTURES_USDT', order.accountId);
            if (!futuresRiskService.hasSufficientMargin(availableMargin, requiredMargin)) {
                throw new Error(`Insufficient margin. Required: ${requiredMargin} USDT, Available: ${availableMargin} USDT`);
            }
            this.ledger.debit('FUTURES_USDT', requiredMargin, `Margin for ${order.symbol} ${order.positionSide} order ${order.id}`, 'MARGIN', `margin_${order.id}`, order.accountId);
        } else {
            // LIMIT opening order: margin was already reserved at placement via margin_lock_${order.id}.
            // Consumes existing reservation without debiting again.
        }

        if (existingPosition) {
            if (existingPosition.leverage !== order.leverage) {
                throw new Error('Leverage must match existing position');
            }
            if (existingPosition.marginMode !== order.marginMode) {
                throw new Error('Margin mode must match existing position');
            }
            const updated = futuresPositionService.increasePosition(existingPosition, order.quantity, execPrice.toString(), market.maintenanceMarginRate);
            this.positions[existingPositionIndex] = updated;
        } else {
            const newPos = futuresPositionService.createPosition({
                accountId: order.accountId,
                symbol: order.symbol,
                side: order.positionSide,
                quantity: order.quantity,
                entryPrice: execPrice.toString(),
                leverage: order.leverage,
                marginMode: order.marginMode,
                maintenanceMarginRate: market.maintenanceMarginRate
            });
            this.positions.push(newPos);
        }
    } else if (isClosing) {
        console.log(`Checking isClosing: orderSide=${order.side}, orderPositionSide=${order.positionSide}, accountId=${order.accountId}, symbol=${order.symbol}. Found: ${existingPosition ? existingPosition.positionId : 'null'}, Positions: ${JSON.stringify(this.positions.map(p => ({accountId: p.accountId, symbol: p.symbol, side: p.side, status: p.status})))}`);
        if (!existingPosition) {
            throw new Error('No open position to close');
        }
        
        // Reduce position
        const result = futuresPositionService.reducePosition(existingPosition, order.quantity, execPrice.toString(), market.maintenanceMarginRate);
        const updatedPosition = result.updatedPosition;
        realizedPnl = result.realizedPnl;
        
        // Return freed margin and PNL
        const freedMargin = new Decimal(existingPosition.initialMargin).minus(new Decimal(updatedPosition.initialMargin || '0'));
        let totalCredit = freedMargin.plus(new Decimal(realizedPnl));
        
        if (totalCredit.gt(0)) {
            this.ledger.credit('FUTURES_USDT', totalCredit.toString(), `Closed ${order.symbol} ${order.positionSide} order ${order.id}`, 'REALIZED_PNL', order.id, order.accountId);
        } else if (totalCredit.lt(0)) {
            const loss = totalCredit.abs();
            const avail = new Decimal(this.ledger.getBalance('FUTURES_USDT', order.accountId));
            if (avail.gte(loss)) {
                this.ledger.debit('FUTURES_USDT', loss.toString(), `Realized loss for ${order.symbol} ${order.positionSide} order ${order.id}`, 'REALIZED_PNL', order.id, order.accountId);
            } else {
                this.ledger.debit('FUTURES_USDT', avail.toString(), `Bankruptcy loss for ${order.symbol} order ${order.id}`, 'REALIZED_PNL', order.id, order.accountId);
            }
        }
        
        this.positions[existingPositionIndex] = updatedPosition;
        
        if (updatedPosition.status === 'CLOSED') {
             futuresTpSlService.autoCancelForPosition(updatedPosition.positionId);
        } else {
             futuresTpSlService.syncWithPositionSize(updatedPosition.positionId, updatedPosition.quantity);
        }
    }

    let executedQty = new Decimal(order.quantity);
    if (isClosing && existingPosition) {
        const currentQty = new Decimal(existingPosition.quantity);
        if (executedQty.gt(currentQty)) {
            executedQty = currentQty;
        }
    }

    // Calculate Trading Fee
    // LIMIT orders executed from book are considered MAKER. MARKET or STOP execution immediately against book is TAKER.
    // For this simulation, LIMIT = MAKER, others = TAKER.
    const isMaker = order.type === 'LIMIT'; 
    const feeResult = futuresFeeService.calculateExecutionFee(executedQty.toString(), execPrice.toString(), isMaker);
    const fee = new Decimal(feeResult.feeAmount);
    
    const tradeId = Math.random().toString(36).substring(2, 11);

    const availMargin = new Decimal(this.ledger.getBalance('FUTURES_USDT', order.accountId));
    if (availMargin.gte(fee)) {
        this.ledger.debit('FUTURES_USDT', feeResult.feeAmount, `TRADING_FEE (${feeResult.feeType}) for ${order.symbol} order ${order.id}`, 'TRADING_FEE', tradeId, order.accountId);
    }

    // Update cumulative fee on the position
    const posIndex = this.positions.findIndex(p => p.accountId === order.accountId && p.symbol === order.symbol && p.side === order.positionSide && (p.status === 'OPEN' || p.status === 'CLOSED'));
    // Since it could be closed just now, we find the most recent one or the one we just updated
    // Actually, we can just find it from the end
    for (let i = this.positions.length - 1; i >= 0; i--) {
        const p = this.positions[i];
        if (p.accountId === order.accountId && p.symbol === order.symbol && p.side === order.positionSide) {
            const currentCumFee = p.cumulativeFee ? new Decimal(p.cumulativeFee) : new Decimal(0);
            p.cumulativeFee = currentCumFee.plus(fee).toString();
            break;
        }
    }

    const trade: FuturesTrade = {
        id: tradeId,
        orderId: order.id,
        accountId: order.accountId,
        symbol: order.symbol,
        side: order.side,
        positionSide: order.positionSide,
        price: execPrice.toString(),
        quantity: order.quantity,
        fee: fee.toString(),
        feeAsset: 'FUTURES_USDT',
        realizedPnl: isClosing ? realizedPnl || '0' : '0',
        timestamp: Date.now()
    };
    
    this.trades.unshift(trade);
    syncFillToCore(trade.id, trade.orderId, trade.accountId, trade.symbol, 'FUTURES', trade.side, trade.quantity, trade.price, trade.fee, trade.feeAsset, trade.realizedPnl);
    
    order.status = 'FILLED';
    order.filledQuantity = order.quantity;
    order.remainingQuantity = '0';
    order.updatedAt = Date.now();
    this.save();
    this.notify();
  }


  public async updateMarkPrices(markets: any[]) {
    let changed = false;
    for (const position of this.positions) {
      if (position.status !== 'OPEN') continue;
      const market = markets.find(m => m.symbol === position.symbol);
      if (market && market.markPrice) {
        // Calculate liquidation price
        const liqPrice = futuresRiskService.calculateLiquidationPrice(
            position, 
            market.maintenanceMarginRate, 
            this.ledger.getBalance('FUTURES_USDT', position.accountId)
        );
        position.liquidationPrice = liqPrice;
        
        const newUnrealizedPnl = futuresRiskService.calculateUnrealizedPnl(position, market.markPrice);
        if (position.markPrice !== market.markPrice || position.unrealizedPnl !== newUnrealizedPnl) {
          position.markPrice = market.markPrice;
          position.unrealizedPnl = newUnrealizedPnl;
          position.updatedAt = Date.now();
          changed = true;
          
          // Check liquidation
          if (futuresRiskService.checkLiquidation(position, this.ledger.getBalance('FUTURES_USDT', position.accountId))) {
             const liqPos = liquidationService.liquidatePosition(position);
             if (liqPos) {
                 // update position
                 Object.assign(position, liqPos);
                 changed = true;
             }
          }
        }
      }
    }
    
    const markPrices: Record<string, string> = {};
    for (const m of markets) {
        if (m.markPrice) markPrices[m.symbol] = m.markPrice;
    }
    await futuresTpSlService.checkTriggers(this.positions, markPrices, async (orderPayload, execPrice) => {
        await this.placeOrder(orderPayload);
    });
    if (changed) {
      this.save();
      this.notify();
    }

  }

  public async addIsolatedMargin(accountId: string, positionId: string, amount: string): Promise<FuturesPosition> {
      const position = this.positions.find(p => p.accountId === accountId && p.positionId === positionId);
      if (!position) throw new Error('Position not found');
      if (position.status !== 'OPEN') throw new Error('Position is not open');
      if (position.marginMode !== 'ISOLATED') throw new Error('Margin can only be modified for ISOLATED positions. CROSS margin uses shared balance.');
      
      const amt = new Decimal(amount);
      if (amt.lte(0)) throw new Error('Amount must be greater than 0');
      
      const availableMargin = new Decimal(this.ledger.getBalance('FUTURES_USDT', accountId));
      if (availableMargin.lt(amt)) throw new Error(`Insufficient available margin. Available: ${availableMargin.toString()} USDT`);
      
      this.ledger.debit('FUTURES_USDT', amt.toString(), `MARGIN_ADDED for ${position.symbol} ${position.side}`, 'MARGIN', position.positionId, accountId);
      
      position.initialMargin = new Decimal(position.initialMargin).plus(amt).toString();
      
      const market = await futuresMarketService.getMarket(position.symbol);
      if (market) {
          position.liquidationPrice = futuresRiskService.calculateLiquidationPrice(position, market.maintenanceMarginRate, '0');
      }
      
      this.save();
      this.notify();
      return position;
  }
  
  public async removeIsolatedMargin(accountId: string, positionId: string, amount: string): Promise<FuturesPosition> {
      const position = this.positions.find(p => p.accountId === accountId && p.positionId === positionId);
      if (!position) throw new Error('Position not found');
      if (position.status !== 'OPEN') throw new Error('Position is not open');
      if (position.marginMode !== 'ISOLATED') throw new Error('Margin can only be modified for ISOLATED positions. CROSS margin uses shared balance.');
      
      const amt = new Decimal(amount);
      if (amt.lte(0)) throw new Error('Amount must be greater than 0');
      
      const currentIm = new Decimal(position.initialMargin);
      
      const equityWithoutRemoval = new Decimal(futuresRiskService.calculatePositionEquity(position, '0'));
      const equityAfterRemoval = equityWithoutRemoval.minus(amt);
      const mm = new Decimal(position.maintenanceMargin);
      
      if (equityAfterRemoval.lte(mm)) {
          throw new Error('Unsafe margin removal: position would be instantly liquidated or invalid.');
      }
      
      const minRequiredIM = new Decimal(futuresRiskService.calculateInitialMargin(position.quantity, position.entryPrice, position.leverage));
      const remainingIm = currentIm.minus(amt);
      
      if (remainingIm.lt(minRequiredIM)) {
           if (remainingIm.lt(0)) throw new Error('Cannot remove more margin than currently allocated to the position');
      }
      
      this.ledger.credit('FUTURES_USDT', amt.toString(), `MARGIN_REMOVED for ${position.symbol} ${position.side}`, 'MARGIN', position.positionId, accountId);
      position.initialMargin = remainingIm.toString();
      
      const market = await futuresMarketService.getMarket(position.symbol);
      if (market) {
          position.liquidationPrice = futuresRiskService.calculateLiquidationPrice(position, market.maintenanceMarginRate, '0');
      }
      
      this.save();
      this.notify();
      return position;
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

export const futuresOrderService = new FuturesOrderService(demoLedger, typeof window !== 'undefined');
