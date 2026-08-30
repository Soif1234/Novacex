import { IDatabaseConnection } from '../../config/database';
import { OrderEntity } from '../../models/order.model';
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

export class MatchingEngine {
  public clear(): void {}

  /**
   * Get aggregated order book depth from database.
   */
  public async getDepth(db: IDatabaseConnection, symbol: string, limit = 20): Promise<OrderBookDepth> {
    const cleanSymbol = symbol?.trim().toUpperCase() || "";

    const bidsRes = await db.query<any>(
      `SELECT price, SUM(remaining_quantity::numeric) as quantity, COUNT(*) as order_count
       FROM orders
       WHERE symbol = $1 AND side = 'BUY' AND status IN ('NEW', 'PARTIALLY_FILLED')
       GROUP BY price
       ORDER BY price::numeric DESC
       LIMIT $2`,
      [cleanSymbol, limit]
    );

    const asksRes = await db.query<any>(
      `SELECT price, SUM(remaining_quantity::numeric) as quantity, COUNT(*) as order_count
       FROM orders
       WHERE symbol = $1 AND side = 'SELL' AND status IN ('NEW', 'PARTIALLY_FILLED')
       GROUP BY price
       ORDER BY price::numeric ASC
       LIMIT $2`,
      [cleanSymbol, limit]
    );

    return {
      symbol: cleanSymbol,
      bids: bidsRes.rows.map((r: any) => ({
        price: r.price,
        quantity: decimalNormalize(r.quantity.toString()),
        orderCount: Number(r.order_count),
      })),
      asks: asksRes.rows.map((r: any) => ({
        price: r.price,
        quantity: decimalNormalize(r.quantity.toString()),
        orderCount: Number(r.order_count),
      })),
      timestamp: new Date(),
    };
  }

  /**
   * Match incoming order against resting orders in the database.
   * Returns list of matched fills to execute.
   */
  public async match(txClient: IDatabaseConnection, incoming: OrderEntity): Promise<MatchResult[]> {
    const matches: MatchResult[] = [];
    let remQty = incoming.remainingQuantity;

    const oppSide = incoming.side === 'BUY' ? 'SELL' : 'BUY';
    const orderDir = oppSide === 'SELL' ? 'ASC' : 'DESC';

    const makersRes = await txClient.query<any>(
      `SELECT * FROM orders
       WHERE symbol = $1 AND side = $2 AND status IN ('NEW', 'PARTIALLY_FILLED')
       ORDER BY price::numeric ${orderDir}, created_at ASC
       FOR UPDATE`,
      [incoming.symbol, oppSide]
    );

    for (const row of makersRes.rows) {
      if (decimalCompare(remQty, '0') <= 0) break;

      const makerOrder: OrderEntity = {
        id: row.id,
        clientOrderId: row.client_order_id,
        accountId: row.account_id,
        market: row.market,
        symbol: row.symbol,
        side: row.side,
        type: row.type,
        price: row.price,
        stopPrice: row.stop_price,
        quantity: row.quantity,
        filledQuantity: row.filled_quantity,
        remainingQuantity: row.remaining_quantity,
        lockedAmount: row.locked_amount,
        lockedAsset: row.locked_asset,
        status: row.status,
        timeInForce: row.time_in_force,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      };

      // Self-trade check
      if (makerOrder.accountId === incoming.accountId) {
        continue;
      }

      // Price check for LIMIT order
      if (incoming.type === 'LIMIT' && incoming.price) {
        if (incoming.side === 'BUY' && decimalCompare(incoming.price, makerOrder.price || '0') < 0) {
          // Best ask is above buy limit price
          break;
        }
        if (incoming.side === 'SELL' && decimalCompare(incoming.price, makerOrder.price || '0') > 0) {
          // Best bid is below sell limit price
          break;
        }
      }

      const execPrice = makerOrder.price || '0';
        if (incoming.type === 'LIMIT' && incoming.price) {
          if (incoming.side === 'BUY' && decimalCompare(execPrice, incoming.price) > 0) break;
          if (incoming.side === 'SELL' && decimalCompare(execPrice, incoming.price) < 0) break;
        }
      const execQty = decimalMin(remQty, makerOrder.remainingQuantity);

      matches.push({
        makerOrder,
        takerOrder: incoming,
        execPrice,
        execQty,
        isBuyerMaker: makerOrder.side === 'BUY',
      });

      remQty = decimalSubtract(remQty, execQty);
    }

    incoming.remainingQuantity = remQty;
    return matches;
  }
}

export const matchingEngine = new MatchingEngine();
