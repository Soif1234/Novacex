import { eventBus } from './event-bus';
import { db } from '../../config/database';
import { logger } from '../../config/logger';
import { decimalCompare } from '../ledger/decimal';
import { spotService } from '../spot/spot.service';
import { futuresService } from '../futures/futures.service';

interface ConditionalOrder {
  id: string;
  market: 'SPOT' | 'FUTURES';
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'STOP_LIMIT' | 'TAKE_PROFIT_LIMIT';
  stopPrice: string;
}

export class ConditionalTriggerService {
  private activeTriggers = new Map<string, ConditionalOrder[]>();

  constructor() {
    eventBus.subscribe('market.trade', this.onMarketTrade.bind(this));
    eventBus.subscribe('spot.order.created', this.onOrderCreated.bind(this));
    eventBus.subscribe('futures.order.created', this.onOrderCreated.bind(this));
    eventBus.subscribe('spot.order.updated', this.onOrderUpdated.bind(this));
    eventBus.subscribe('futures.order.updated', this.onOrderUpdated.bind(this));
  }

  public async loadFromDatabase(): Promise<void> {
    const res = await db.query<any>(
      "SELECT id, market, symbol, side, type, stop_price FROM orders WHERE status = 'UNTRIGGERED'"
    );
    for (const row of res.rows) {
      this.addTrigger({
        id: row.id,
        market: row.market as 'SPOT' | 'FUTURES',
        symbol: row.symbol,
        side: row.side as 'BUY' | 'SELL',
        type: row.type as 'STOP_LIMIT' | 'TAKE_PROFIT_LIMIT',
        stopPrice: row.stop_price
      });
    }
    logger.info(`Loaded ${res.rows.length} untriggered conditional orders into memory`);
  }

  private addTrigger(order: ConditionalOrder) {
    if (!this.activeTriggers.has(order.symbol)) {
      this.activeTriggers.set(order.symbol, []);
    }
    const list = this.activeTriggers.get(order.symbol)!;
    if (!list.find(o => o.id === order.id)) {
      list.push(order);
      logger.info(`Added conditional trigger for order ${order.id} (${order.market} ${order.symbol} @ ${order.stopPrice})`);
    }
  }

  private onOrderCreated(event: any) {
    const payload = event.payload || event;
    if (payload.status === 'UNTRIGGERED' && payload.stopPrice) {
      this.addTrigger({
        id: payload.id || payload.orderId,
        market: event.type.startsWith('spot') ? 'SPOT' : 'FUTURES',
        symbol: payload.symbol,
        side: payload.side,
        type: payload.type,
        stopPrice: payload.stopPrice
      });
    }
  }

  private onOrderUpdated(event: any) {
    const payload = event.payload || event;
    if (payload.status === 'CANCELLED' || payload.status === 'NEW') {
      const orderId = payload.id || payload.orderId;
      if (!orderId) return;
      for (const [sym, list] of this.activeTriggers.entries()) {
        const filtered = list.filter(o => o.id !== orderId);
        if (filtered.length !== list.length) {
          this.activeTriggers.set(sym, filtered);
          logger.info(`Removed conditional trigger for order ${orderId}`);
        }
      }
    }
  }

  private async onMarketTrade(event: any) {
    const trade = event.payload;
    if (!trade || !trade.symbol || !trade.price) return;
    
    const symbol = trade.symbol;
    const ltp = trade.price;
    const triggers = this.activeTriggers.get(symbol);
    if (!triggers || triggers.length === 0) return;

    const toTrigger: ConditionalOrder[] = [];

    for (const order of triggers) {
      let triggered = false;
      const cmp = decimalCompare(ltp, order.stopPrice);

      if (order.type === 'STOP_LIMIT') {
        if (order.side === 'BUY' && cmp >= 0) triggered = true; // LTP >= stopPrice
        if (order.side === 'SELL' && cmp <= 0) triggered = true; // LTP <= stopPrice
      } else if (order.type === 'TAKE_PROFIT_LIMIT') {
        if (order.side === 'BUY' && cmp <= 0) triggered = true; // LTP <= stopPrice
        if (order.side === 'SELL' && cmp >= 0) triggered = true; // LTP >= stopPrice
      }

      if (triggered) {
        toTrigger.push(order);
      }
    }

    if (toTrigger.length > 0) {
      // Optimistically remove to prevent double trigger
      this.activeTriggers.set(symbol, triggers.filter(o => !toTrigger.find(t => t.id === o.id)));

      for (const order of toTrigger) {
        try {
          logger.info(`Triggering conditional order ${order.id} due to LTP ${ltp} crossing ${order.stopPrice}`);
          if (order.market === 'SPOT') {
            await spotService.triggerOrder(order.id);
          } else {
            await futuresService.triggerOrder(order.id);
          }
        } catch (err) {
          logger.error(`Failed to trigger conditional order ${order.id}`, {}, err as Error);
        }
      }
    }
  }
}

export const conditionalTriggerService = new ConditionalTriggerService();
