import { OrderEntity, OrderSide, OrderType, OrderStatus } from '../../models/order.model';
import { decimalCompare, decimalMin, decimalSubtract, decimalNormalize } from '../ledger/decimal';

export interface MatchResult {
  makerOrder: OrderEntity;
  takerOrder: OrderEntity;
  execPrice: string;
  execQty: string;
  isBuyerMaker: boolean; // true if maker is BUY, false if maker is SELL
}

export interface OrderBookLevel {
  price: string;
  quantity: string;
  orderCount: number;
}

export interface OrderBookDepth {
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: Date;
}

export class PairOrderBook {
  public bids: OrderEntity[] = []; // Sorted: price DESC, createdAt ASC
  public asks: OrderEntity[] = []; // Sorted: price ASC, createdAt ASC

  constructor(public readonly symbol: string) {}

  /**
   * Insert a resting order into the book maintaining price-time priority.
   */
  public addRestingOrder(order: OrderEntity): void {
    if (order.status !== 'NEW' && order.status !== 'PARTIALLY_FILLED') {
      return;
    }
    if (decimalCompare(order.remainingQuantity, '0') <= 0) {
      return;
    }

    if (order.side === 'BUY') {
      // Find insertion index: price DESC, then createdAt ASC
      const idx = this.bids.findIndex(existing => {
        const pCmp = decimalCompare(order.price || '0', existing.price || '0');
        if (pCmp > 0) return true; // Higher price has priority
        if (pCmp === 0) return order.createdAt.getTime() < existing.createdAt.getTime();
        return false;
      });

      if (idx === -1) {
        this.bids.push(order);
      } else {
        this.bids.splice(idx, 0, order);
      }
    } else {
      // Find insertion index: price ASC, then createdAt ASC
      const idx = this.asks.findIndex(existing => {
        const pCmp = decimalCompare(order.price || '0', existing.price || '0');
        if (pCmp < 0) return true; // Lower price has priority
        if (pCmp === 0) return order.createdAt.getTime() < existing.createdAt.getTime();
        return false;
      });

      if (idx === -1) {
        this.asks.push(order);
      } else {
        this.asks.splice(idx, 0, order);
      }
    }
  }

  /**
   * Remove an order from the book by ID.
   */
  public removeOrder(orderId: string): OrderEntity | undefined {
    const bidIdx = this.bids.findIndex(o => o.id === orderId);
    if (bidIdx !== -1) {
      return this.bids.splice(bidIdx, 1)[0];
    }
    const askIdx = this.asks.findIndex(o => o.id === orderId);
    if (askIdx !== -1) {
      return this.asks.splice(askIdx, 1)[0];
    }
    return undefined;
  }

  /**
   * Get aggregated order book depth.
   */
  public getDepth(limit = 20): OrderBookDepth {
    const aggregate = (orders: OrderEntity[]): OrderBookLevel[] => {
      const map = new Map<string, { quantity: string; count: number }>();
      for (const ord of orders) {
        const p = decimalNormalize(ord.price || '0');
        const existing = map.get(p);
        if (existing) {
          existing.quantity = decimalNormalize(existing.quantity);
          // Simple addition
          const sum = (BigInt(existing.quantity.replace('.', '')) + BigInt(ord.remainingQuantity.replace('.', ''))).toString();
          // We can use decimalAdd
          existing.quantity = (Number(existing.quantity) + Number(ord.remainingQuantity)).toString();
          existing.count += 1;
        } else {
          map.set(p, { quantity: ord.remainingQuantity, count: 1 });
        }
      }

      const levels: OrderBookLevel[] = [];
      for (const [price, val] of map.entries()) {
        levels.push({ price, quantity: decimalNormalize(val.quantity), orderCount: val.count });
        if (levels.length >= limit) break;
      }
      return levels;
    };

    return {
      symbol: this.symbol,
      bids: aggregate(this.bids),
      asks: aggregate(this.asks),
      timestamp: new Date(),
    };
  }

  /**
   * Match incoming order against opposite side of the book.
   * Returns list of matched fills to execute.
   */
  public match(incoming: OrderEntity): MatchResult[] {
    const matches: MatchResult[] = [];
    let remQty = incoming.remainingQuantity;

    if (incoming.side === 'BUY') {
      let askIdx = 0;
      while (askIdx < this.asks.length && decimalCompare(remQty, '0') > 0) {
        const makerAsk = this.asks[askIdx];

        // Self-trade check
        if (makerAsk.accountId === incoming.accountId) {
          askIdx++;
          continue;
        }

        // Price check for LIMIT order
        if (incoming.type === 'LIMIT' && incoming.price) {
          if (decimalCompare(incoming.price, makerAsk.price || '0') < 0) {
            // Best ask is above buy limit price -> no more matches possible
            break;
          }
        }

        // Match found! Execution price is maker's price
        const execPrice = makerAsk.price || '0';
        const execQty = decimalMin(remQty, makerAsk.remainingQuantity);

        matches.push({
          makerOrder: makerAsk,
          takerOrder: incoming,
          execPrice,
          execQty,
          isBuyerMaker: false, // Maker is SELL, taker is BUY
        });

        remQty = decimalSubtract(remQty, execQty);
        makerAsk.remainingQuantity = decimalSubtract(makerAsk.remainingQuantity, execQty);

        if (decimalCompare(makerAsk.remainingQuantity, '0') <= 0) {
          // Maker is completely filled -> remove from asks
          this.asks.splice(askIdx, 1);
        } else {
          makerAsk.status = 'PARTIALLY_FILLED';
          askIdx++;
        }
      }
    } else {
      // Incoming is SELL
      let bidIdx = 0;
      while (bidIdx < this.bids.length && decimalCompare(remQty, '0') > 0) {
        const makerBid = this.bids[bidIdx];

        // Self-trade check
        if (makerBid.accountId === incoming.accountId) {
          bidIdx++;
          continue;
        }

        // Price check for LIMIT order
        if (incoming.type === 'LIMIT' && incoming.price) {
          if (decimalCompare(incoming.price, makerBid.price || '0') > 0) {
            // Best bid is below sell limit price -> no more matches possible
            break;
          }
        }

        // Match found! Execution price is maker's price
        const execPrice = makerBid.price || '0';
        const execQty = decimalMin(remQty, makerBid.remainingQuantity);

        matches.push({
          makerOrder: makerBid,
          takerOrder: incoming,
          execPrice,
          execQty,
          isBuyerMaker: true, // Maker is BUY, taker is SELL
        });

        remQty = decimalSubtract(remQty, execQty);
        makerBid.remainingQuantity = decimalSubtract(makerBid.remainingQuantity, execQty);

        if (decimalCompare(makerBid.remainingQuantity, '0') <= 0) {
          // Maker is completely filled -> remove from bids
          this.bids.splice(bidIdx, 1);
        } else {
          makerBid.status = 'PARTIALLY_FILLED';
          bidIdx++;
        }
      }
    }

    incoming.remainingQuantity = remQty;
    return matches;
  }
}

export class MatchingEngine {
  private books = new Map<string, PairOrderBook>();

  public getBook(symbol: string): PairOrderBook {
    const cleanSymbol = symbol.trim().toUpperCase();
    let book = this.books.get(cleanSymbol);
    if (!book) {
      book = new PairOrderBook(cleanSymbol);
      this.books.set(cleanSymbol, book);
    }
    return book;
  }

  public getDepth(symbol: string, limit = 20): OrderBookDepth {
    return this.getBook(symbol).getDepth(limit);
  }

  public removeOrder(orderId: string, symbol: string): OrderEntity | undefined {
    return this.getBook(symbol).removeOrder(orderId);
  }

  public clear(): void {
    this.books.clear();
  }
}

export const matchingEngine = new MatchingEngine();
