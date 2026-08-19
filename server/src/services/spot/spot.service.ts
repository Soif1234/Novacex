import crypto from 'crypto';
import { db, IDatabaseConnection } from '../../config/database';
import { OrderEntity, TradeEntity, TradingPairEntity, OrderSide, OrderType, OrderStatus } from '../../models/order.model';
import { LedgerService, ledgerService } from '../ledger/ledger.service';
import { matchingEngine, MatchingEngine, MatchResult, OrderBookDepth } from './matching.engine';
import {
  validateAmount,
  decimalNormalize,
  decimalMultiply,
  decimalSubtract,
  decimalAdd,
  decimalCompare,
  decimalMin,
} from '../ledger/decimal';
import { logger } from '../../config/logger';
import {
  SpotError,
  SpotErrorCode,
  InvalidTradingPairError,
  PairDisabledError,
  InvalidOrderSideError,
  InvalidOrderTypeError,
  OrderNotFoundError,
  OrderNotCancellableError,
  NoLiquidityError,
  BelowMinNotionalError,
} from './errors';
import {
  AccountNotFoundError,
  AccountOwnershipDeniedError,
  WalletError,
} from '../wallet/errors';
import { ReferenceConflictError } from '../ledger/errors';

export interface CreateOrderDto {
  userId: string;
  accountId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  price?: string;
  quantity: string;
  clientOrderId?: string;
  timeInForce?: string;
}

export interface OrderExecutionResult {
  order: OrderEntity;
  trades: TradeEntity[];
}

export interface GetOrdersOptions {
  accountId?: string;
  symbol?: string;
  status?: OrderStatus;
  side?: OrderSide;
  page?: number;
  pageSize?: number;
}

export interface GetTradesOptions {
  accountId?: string;
  symbol?: string;
  orderId?: string;
  page?: number;
  pageSize?: number;
}

export class SpotService {
  constructor(
    private database: IDatabaseConnection = db,
    private ledger: LedgerService = ledgerService,
    private engine: MatchingEngine = matchingEngine
  ) {}

  /**
   * Validate trading pair and order parameters.
   */
  public async validateTradingPair(symbol: string): Promise<TradingPairEntity> {
    if (!symbol || typeof symbol !== 'string') {
      throw new InvalidTradingPairError(String(symbol), 'Symbol is required');
    }

    const cleanSymbol = symbol.trim().toUpperCase();
    const res = await this.database.query<any>(
      'SELECT symbol, base_asset AS "baseAsset", quote_asset AS "quoteAsset", market_type AS "marketType", tick_size AS "tickSize", lot_size AS "lotSize", min_notional AS "minNotional", maker_fee_rate AS "makerFeeRate", taker_fee_rate AS "takerFeeRate", is_active AS "isActive", created_at AS "createdAt" FROM trading_pairs WHERE symbol = $1',
      [cleanSymbol]
    );

    const row = res.rows[0];
    if (!row) {
      throw new InvalidTradingPairError(cleanSymbol);
    }

    const pair: TradingPairEntity = {
      symbol: row.symbol,
      baseAsset: row.baseAsset || row.base_asset,
      quoteAsset: row.quoteAsset || row.quote_asset,
      marketType: (row.marketType || row.market_type) as any,
      tickSize: row.tickSize || row.tick_size || '0.01',
      lotSize: row.lotSize || row.lot_size || '0.0001',
      minNotional: row.minNotional || row.min_notional || '5.0',
      makerFeeRate: row.makerFeeRate || row.maker_fee_rate || '0.001',
      takerFeeRate: row.takerFeeRate || row.taker_fee_rate || '0.001',
      isActive: Boolean(row.isActive ?? row.is_active),
      createdAt: row.createdAt ? new Date(row.createdAt) : new Date(),
    };

    if (!pair.isActive) {
      throw new PairDisabledError(cleanSymbol);
    }

    return pair;
  }

  /**
   * Place and match a new Spot order.
   */
  public async placeOrder(dto: CreateOrderDto): Promise<OrderExecutionResult> {
    // 1. Verify authenticated ownership of Spot account
    const accRes = await this.database.query<any>(
      'SELECT id, user_id AS "userId", type FROM accounts WHERE id = $1',
      [dto.accountId]
    );

    const acc = accRes.rows[0];
    if (!acc) {
      throw new AccountNotFoundError(dto.accountId);
    }
    if ((acc.userId || acc.user_id) !== dto.userId) {
      throw new AccountOwnershipDeniedError(dto.accountId);
    }

    // 2. Validate parameters
    const pair = await this.validateTradingPair(dto.symbol);

    if (dto.side !== 'BUY' && dto.side !== 'SELL') {
      throw new InvalidOrderSideError(dto.side);
    }

    if (dto.type !== 'LIMIT' && dto.type !== 'MARKET') {
      throw new InvalidOrderTypeError(dto.type);
    }

    validateAmount(dto.quantity);

    if (dto.type === 'LIMIT') {
      if (!dto.price) {
        throw new SpotError('Limit price is required for LIMIT orders', 400, SpotErrorCode.INVALID_PRICE);
      }
      validateAmount(dto.price);
    }

    const cleanSymbol = pair.symbol;
    const cleanQty = decimalNormalize(dto.quantity);
    const cleanPrice = dto.price ? decimalNormalize(dto.price) : undefined;
    const cleanClientOrderId = dto.clientOrderId?.trim();

    // 3. Check idempotency if clientOrderId is provided
    if (cleanClientOrderId) {
      const existingRes = await this.database.query<any>(
        'SELECT * FROM orders WHERE account_id = $1 AND client_order_id = $2',
        [dto.accountId, cleanClientOrderId]
      );
      const existing = existingRes.rows[0];
      if (existing) {
        // Check if parameters match
        const match =
          existing.symbol === cleanSymbol &&
          existing.side === dto.side &&
          existing.type === dto.type &&
          decimalCompare(existing.quantity, cleanQty) === 0 &&
          (!cleanPrice || (existing.price && decimalCompare(existing.price, cleanPrice) === 0));

        if (match) {
          const tradesRes = await this.database.query<any>(
            'SELECT * FROM trades WHERE order_id = $1',
            [existing.id]
          );
          return {
            order: existing,
            trades: tradesRes.rows,
          };
        } else {
          throw new ReferenceConflictError(cleanClientOrderId);
        }
      }
    }

    // 4. Determine required reservation amount & asset
    let lockedAsset: string;
    let lockedAmount: string;

    if (dto.side === 'BUY') {
      lockedAsset = pair.quoteAsset;
      if (dto.type === 'LIMIT') {
        lockedAmount = decimalMultiply(cleanQty, cleanPrice!);
      } else {
        // MARKET BUY: Calculate required quote amount from available asks in order book
        const book = this.engine.getBook(cleanSymbol);
        if (book.asks.length === 0) {
          throw new NoLiquidityError(cleanSymbol, 'BUY');
        }

        let needed = cleanQty;
        let totalQuote = '0';
        for (const ask of book.asks) {
          if (ask.accountId === dto.accountId) continue; // Skip self
          const take = decimalMin(needed, ask.remainingQuantity);
          totalQuote = decimalAdd(totalQuote, decimalMultiply(take, ask.price || '0'));
          needed = decimalSubtract(needed, take);
          if (decimalCompare(needed, '0') <= 0) break;
        }

        if (decimalCompare(totalQuote, '0') <= 0) {
          throw new NoLiquidityError(cleanSymbol, 'BUY');
        }
        lockedAmount = totalQuote;
      }
    } else {
      // SELL: Reserve base asset
      lockedAsset = pair.baseAsset;
      lockedAmount = cleanQty;
    }

    const orderId = crypto.randomUUID();
    const lockRef = `SPOT-LOCK-${orderId}`;

    // 5. Reserve funds via authoritative LedgerService
    await this.ledger.reserve(
      dto.accountId,
      lockedAsset,
      lockedAmount,
      'SPOT_ORDER_LOCK',
      lockRef,
      `Spot ${dto.side} ${dto.type} order lock (${cleanSymbol})`,
      {
        orderId,
        symbol: cleanSymbol,
        side: dto.side,
        type: dto.type,
        quantity: cleanQty,
        price: cleanPrice,
      }
    );

    // 6. Create Order Entity
    const order: OrderEntity = {
      id: orderId,
      clientOrderId: cleanClientOrderId,
      accountId: dto.accountId,
      market: 'SPOT',
      symbol: cleanSymbol,
      side: dto.side,
      type: dto.type,
      price: cleanPrice,
      quantity: cleanQty,
      filledQuantity: '0',
      remainingQuantity: cleanQty,
      lockedAmount,
      lockedAsset,
      status: 'NEW',
      timeInForce: dto.timeInForce || 'GTC',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // 7. Persist order in PostgreSQL
    await this.database.query(
      `INSERT INTO orders (
        id, client_order_id, account_id, market, symbol, side, type, price, quantity,
        filled_quantity, remaining_quantity, locked_amount, locked_asset, status,
        time_in_force, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        order.id,
        order.clientOrderId,
        order.accountId,
        order.market,
        order.symbol,
        order.side,
        order.type,
        order.price,
        order.quantity,
        order.filledQuantity,
        order.remainingQuantity,
        order.lockedAmount,
        order.lockedAsset,
        order.status,
        order.timeInForce,
        order.createdAt,
        order.updatedAt,
      ]
    );

    // 8. Match order in Matching Engine
    const book = this.engine.getBook(cleanSymbol);
    const matches = book.match(order);
    const executedTrades: TradeEntity[] = [];

    // 9. Atomically settle each trade fill
    for (const match of matches) {
      const tradeResults = await this.settleMatch(match, pair);
      executedTrades.push(...tradeResults);
    }

    // 10. Update order status and handle remaining quantity
    if (decimalCompare(order.remainingQuantity, '0') <= 0) {
      order.status = 'FILLED';
      order.filledQuantity = order.quantity;
      order.remainingQuantity = '0';
    } else if (decimalCompare(order.filledQuantity, '0') > 0) {
      order.status = 'PARTIALLY_FILLED';
    }

    if (order.type === 'LIMIT' && (order.status === 'NEW' || order.status === 'PARTIALLY_FILLED')) {
      // Add resting limit order to the book
      book.addRestingOrder(order);
    } else if (order.type === 'MARKET' && decimalCompare(order.remainingQuantity, '0') > 0) {
      // Market order exhausted liquidity -> release unused reservation and expire remaining
      order.status = decimalCompare(order.filledQuantity, '0') > 0 ? 'PARTIALLY_FILLED' : 'EXPIRED';
      if (order.side === 'BUY') {
        // Calculate remaining locked quote amount to release
        let usedQuote = '0';
        for (const t of executedTrades.filter(t => t.orderId === order.id)) {
          usedQuote = decimalAdd(usedQuote, t.quoteQuantity);
        }
        const unusedQuote = decimalSubtract(order.lockedAmount, usedQuote);
        if (decimalCompare(unusedQuote, '0') > 0) {
          await this.ledger.release(
            order.accountId,
            pair.quoteAsset,
            unusedQuote,
            'SPOT_ORDER_UNLOCK',
            `SPOT-UNLOCK-${order.id}`,
            'Release unused market buy quote reserve'
          );
        }
      } else {
        // Market sell: release remaining base asset
        await this.ledger.release(
          order.accountId,
          pair.baseAsset,
          order.remainingQuantity,
          'SPOT_ORDER_UNLOCK',
          `SPOT-UNLOCK-${order.id}`,
          'Release unused market sell base reserve'
        );
      }
    }

    // Persist final order state
    await this.database.query(
      'UPDATE orders SET status = $1, filled_quantity = $2, remaining_quantity = $3, updated_at = NOW() WHERE id = $4',
      [order.status, order.filledQuantity, order.remainingQuantity, order.id]
    );

    logger.info('Spot order processed', {
      orderId: order.id,
      symbol: cleanSymbol,
      side: order.side,
      type: order.type,
      status: order.status,
      filledQuantity: order.filledQuantity,
      tradesCount: executedTrades.length,
    });

    return {
      order,
      trades: executedTrades,
    };
  }

  /**
   * Atomically settle a matched trade between Maker and Taker via LedgerService.
   */
  private async settleMatch(match: MatchResult, pair: TradingPairEntity): Promise<TradeEntity[]> {
    const { makerOrder, takerOrder, execPrice, execQty } = match;
    const quoteQty = decimalMultiply(execQty, execPrice);

    const buyerOrder = takerOrder.side === 'BUY' ? takerOrder : makerOrder;
    const sellerOrder = takerOrder.side === 'SELL' ? takerOrder : makerOrder;

    const buyerIsMaker = buyerOrder.id === makerOrder.id;
    const sellerIsMaker = sellerOrder.id === makerOrder.id;

    const tradeIdBuyer = crypto.randomUUID();
    const tradeIdSeller = crypto.randomUUID();
    const matchRef = `SPOT-TRADE-${tradeIdBuyer}`;

    // Prepare ledger entries for double-entry atomic trade settlement
    // 1. Buyer: debit quote from locked, credit base to available
    // 2. Seller: debit base from locked, credit quote to available
    // 3. Price improvement for buyer if limit price > execPrice
    const entries: Array<{
      accountId: string;
      asset: string;
      amount: string;
      direction: 'CREDIT' | 'DEBIT';
      balancePool?: 'available' | 'locked';
    }> = [
      // Buyer settlements
      {
        accountId: buyerOrder.accountId,
        asset: pair.quoteAsset,
        amount: quoteQty,
        direction: 'DEBIT',
        balancePool: 'locked',
      },
      {
        accountId: buyerOrder.accountId,
        asset: pair.baseAsset,
        amount: execQty,
        direction: 'CREDIT',
        balancePool: 'available',
      },
      // Seller settlements
      {
        accountId: sellerOrder.accountId,
        asset: pair.baseAsset,
        amount: execQty,
        direction: 'DEBIT',
        balancePool: 'locked',
      },
      {
        accountId: sellerOrder.accountId,
        asset: pair.quoteAsset,
        amount: quoteQty,
        direction: 'CREDIT',
        balancePool: 'available',
      },
    ];

    // Check for price improvement refund for buyer (if buyer limit price was higher than executed maker price)
    if (buyerOrder.type === 'LIMIT' && buyerOrder.price && decimalCompare(buyerOrder.price, execPrice) > 0) {
      const priceDiff = decimalSubtract(buyerOrder.price, execPrice);
      const refundAmount = decimalMultiply(execQty, priceDiff);
      if (decimalCompare(refundAmount, '0') > 0) {
        // Move refundAmount from locked -> available for buyer
        entries.push(
          {
            accountId: buyerOrder.accountId,
            asset: pair.quoteAsset,
            amount: refundAmount,
            direction: 'DEBIT',
            balancePool: 'locked',
          },
          {
            accountId: buyerOrder.accountId,
            asset: pair.quoteAsset,
            amount: refundAmount,
            direction: 'CREDIT',
            balancePool: 'available',
          }
        );
      }
    }

    // Execute atomic settlement via LedgerService
    await this.ledger.postTransaction({
      accountId: buyerOrder.accountId,
      transactionType: 'SPOT_TRADE_SETTLE',
      referenceId: matchRef,
      description: `Spot Trade Settlement: ${pair.symbol} ${execQty} @ ${execPrice}`,
      entries,
      metadata: {
        symbol: pair.symbol,
        execPrice,
        execQty,
        quoteQty,
        buyerOrderId: buyerOrder.id,
        sellerOrderId: sellerOrder.id,
      },
    });


    // Create trade entities
    const buyerTrade: TradeEntity = {
      id: tradeIdBuyer,
      orderId: buyerOrder.id,
      accountId: buyerOrder.accountId,
      market: 'SPOT',
      symbol: pair.symbol,
      side: 'BUY',
      price: execPrice,
      quantity: execQty,
      quoteQuantity: quoteQty,
      fee: '0',
      feeAsset: pair.baseAsset,
      isMaker: buyerIsMaker,
      counterpartyOrderId: sellerOrder.id,
      createdAt: new Date(),
    };

    const sellerTrade: TradeEntity = {
      id: tradeIdSeller,
      orderId: sellerOrder.id,
      accountId: sellerOrder.accountId,
      market: 'SPOT',
      symbol: pair.symbol,
      side: 'SELL',
      price: execPrice,
      quantity: execQty,
      quoteQuantity: quoteQty,
      fee: '0',
      feeAsset: pair.quoteAsset,
      isMaker: sellerIsMaker,
      counterpartyOrderId: buyerOrder.id,
      createdAt: new Date(),
    };

    // Persist trades in PostgreSQL
    await Promise.all([
      this.database.query(
        `INSERT INTO trades (
          id, order_id, account_id, market, symbol, side, price, quantity, quote_quantity,
          fee, fee_asset, is_maker, counterparty_order_id, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          buyerTrade.id,
          buyerTrade.orderId,
          buyerTrade.accountId,
          buyerTrade.market,
          buyerTrade.symbol,
          buyerTrade.side,
          buyerTrade.price,
          buyerTrade.quantity,
          buyerTrade.quoteQuantity,
          buyerTrade.fee,
          buyerTrade.feeAsset,
          buyerTrade.isMaker,
          buyerTrade.counterpartyOrderId,
          buyerTrade.createdAt,
        ]
      ),
      this.database.query(
        `INSERT INTO trades (
          id, order_id, account_id, market, symbol, side, price, quantity, quote_quantity,
          fee, fee_asset, is_maker, counterparty_order_id, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          sellerTrade.id,
          sellerTrade.orderId,
          sellerTrade.accountId,
          sellerTrade.market,
          sellerTrade.symbol,
          sellerTrade.side,
          sellerTrade.price,
          sellerTrade.quantity,
          sellerTrade.quoteQuantity,
          sellerTrade.fee,
          sellerTrade.feeAsset,
          sellerTrade.isMaker,
          sellerTrade.counterpartyOrderId,
          sellerTrade.createdAt,
        ]
      ),
    ]);

    // Update maker order state
    makerOrder.filledQuantity = decimalAdd(makerOrder.filledQuantity, execQty);
    if (decimalCompare(makerOrder.remainingQuantity, '0') <= 0) {
      makerOrder.status = 'FILLED';
    } else {
      makerOrder.status = 'PARTIALLY_FILLED';
    }

    await this.database.query(
      'UPDATE orders SET filled_quantity = $1, remaining_quantity = $2, status = $3, updated_at = NOW() WHERE id = $4',
      [makerOrder.filledQuantity, makerOrder.remainingQuantity, makerOrder.status, makerOrder.id]
    );

    // Update taker order state
    takerOrder.filledQuantity = decimalAdd(takerOrder.filledQuantity, execQty);

    return [buyerTrade, sellerTrade];
  }

  /**
   * Cancel an open order and release remaining locked funds.
   */
  public async cancelOrder(userId: string, orderId: string): Promise<OrderEntity> {
    // 1. Fetch order
    const orderRes = await this.database.query<any>('SELECT * FROM orders WHERE id = $1', [orderId]);
    const orderRow = orderRes.rows[0];
    if (!orderRow) {
      throw new OrderNotFoundError(orderId);
    }

    // 2. Verify account ownership
    const accRes = await this.database.query<any>('SELECT id, user_id AS "userId" FROM accounts WHERE id = $1', [
      orderRow.accountId || orderRow.account_id,
    ]);
    const acc = accRes.rows[0];
    if (!acc || (acc.userId || acc.user_id) !== userId) {
      throw new AccountOwnershipDeniedError(orderRow.accountId || orderRow.account_id);
    }

    const order: OrderEntity = {
      id: orderRow.id,
      clientOrderId: orderRow.clientOrderId || orderRow.client_order_id,
      accountId: orderRow.accountId || orderRow.account_id,
      market: orderRow.market,
      symbol: orderRow.symbol,
      side: orderRow.side,
      type: orderRow.type,
      price: orderRow.price,
      quantity: orderRow.quantity,
      filledQuantity: orderRow.filledQuantity || orderRow.filled_quantity,
      remainingQuantity: orderRow.remainingQuantity || orderRow.remaining_quantity,
      lockedAmount: orderRow.lockedAmount || orderRow.locked_amount,
      lockedAsset: orderRow.lockedAsset || orderRow.locked_asset,
      status: orderRow.status,
      timeInForce: orderRow.timeInForce || orderRow.time_in_force,
      createdAt: new Date(orderRow.createdAt || orderRow.created_at),
      updatedAt: new Date(orderRow.updatedAt || orderRow.updated_at),
    };

    // 3. Idempotent return if already cancelled
    if (order.status === 'CANCELLED') {
      return order;
    }

    if (order.status !== 'NEW' && order.status !== 'PARTIALLY_FILLED') {
      throw new OrderNotCancellableError(orderId, order.status);
    }

    // 4. Remove from matching book
    this.engine.removeOrder(orderId, order.symbol);

    // 5. Calculate remaining locked amount to release
    let releaseAmount: string;
    if (order.side === 'BUY') {
      if (order.price) {
        releaseAmount = decimalMultiply(order.remainingQuantity, order.price);
      } else {
        releaseAmount = order.lockedAmount;
      }
    } else {
      releaseAmount = order.remainingQuantity;
    }

    if (decimalCompare(releaseAmount, '0') > 0) {
      const unlockRef = `SPOT-UNLOCK-${order.id}`;
      await this.ledger.release(
        order.accountId,
        order.lockedAsset,
        releaseAmount,
        'SPOT_ORDER_UNLOCK',
        unlockRef,
        `Cancel Spot ${order.side} Order (${order.symbol})`
      );
    }

    // 6. Update status to CANCELLED
    order.status = 'CANCELLED';
    order.updatedAt = new Date();

    await this.database.query('UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2', [
      'CANCELLED',
      order.id,
    ]);

    logger.info('Spot order cancelled', {
      orderId: order.id,
      symbol: order.symbol,
      releasedAmount: releaseAmount,
    });

    return order;
  }

  /**
   * Get single order by ID with ownership verification.
   */
  public async getOrder(userId: string, orderId: string): Promise<OrderEntity> {
    const orderRes = await this.database.query<any>('SELECT * FROM orders WHERE id = $1', [orderId]);
    const orderRow = orderRes.rows[0];
    if (!orderRow) {
      throw new OrderNotFoundError(orderId);
    }

    const accRes = await this.database.query<any>('SELECT id, user_id AS "userId" FROM accounts WHERE id = $1', [
      orderRow.accountId || orderRow.account_id,
    ]);
    const acc = accRes.rows[0];
    if (!acc || (acc.userId || acc.user_id) !== userId) {
      throw new AccountOwnershipDeniedError(orderRow.accountId || orderRow.account_id);
    }

    return {
      id: orderRow.id,
      clientOrderId: orderRow.clientOrderId || orderRow.client_order_id,
      accountId: orderRow.accountId || orderRow.account_id,
      market: orderRow.market,
      symbol: orderRow.symbol,
      side: orderRow.side,
      type: orderRow.type,
      price: orderRow.price,
      quantity: orderRow.quantity,
      filledQuantity: orderRow.filledQuantity || orderRow.filled_quantity,
      remainingQuantity: orderRow.remainingQuantity || orderRow.remaining_quantity,
      lockedAmount: orderRow.lockedAmount || orderRow.locked_amount,
      lockedAsset: orderRow.lockedAsset || orderRow.locked_asset,
      status: orderRow.status,
      timeInForce: orderRow.timeInForce || orderRow.time_in_force,
      createdAt: new Date(orderRow.createdAt || orderRow.created_at),
      updatedAt: new Date(orderRow.updatedAt || orderRow.updated_at),
    };
  }

  /**
   * Get open orders for authenticated user.
   */
  public async getOpenOrders(userId: string, symbol?: string): Promise<OrderEntity[]> {
    const accRes = await this.database.query<any>(
      "SELECT id FROM accounts WHERE user_id = $1 AND type = 'SPOT'",
      [userId]
    );
    const spotAcc = accRes.rows[0];
    if (!spotAcc) {
      return [];
    }

    const ordersRes = await this.database.query<any>(
      "SELECT * FROM orders WHERE account_id = $1 AND status IN ('NEW', 'PARTIALLY_FILLED')",
      [spotAcc.id]
    );

    let orders: OrderEntity[] = ordersRes.rows.map(r => ({
      id: r.id,
      clientOrderId: r.clientOrderId || r.client_order_id,
      accountId: r.accountId || r.account_id,
      market: r.market,
      symbol: r.symbol,
      side: r.side,
      type: r.type,
      price: r.price,
      quantity: r.quantity,
      filledQuantity: r.filledQuantity || r.filled_quantity,
      remainingQuantity: r.remainingQuantity || r.remaining_quantity,
      lockedAmount: r.lockedAmount || r.locked_amount,
      lockedAsset: r.lockedAsset || r.locked_asset,
      status: r.status,
      timeInForce: r.timeInForce || r.time_in_force,
      createdAt: new Date(r.createdAt || r.created_at),
      updatedAt: new Date(r.updatedAt || r.updated_at),
    }));

    if (symbol) {
      orders = orders.filter(o => o.symbol === symbol.toUpperCase());
    }

    return orders;
  }

  /**
   * Get paginated order history for authenticated user.
   */
  public async getOrderHistory(userId: string, options: GetOrdersOptions = {}): Promise<OrderEntity[]> {
    const accRes = await this.database.query<any>(
      "SELECT id FROM accounts WHERE user_id = $1 AND type = 'SPOT'",
      [userId]
    );
    const spotAcc = accRes.rows[0];
    if (!spotAcc) {
      return [];
    }

    const page = options.page || 1;
    const pageSize = options.pageSize || 50;
    const offset = (page - 1) * pageSize;

    const ordersRes = await this.database.query<any>(
      'SELECT * FROM orders WHERE account_id = $1',
      [spotAcc.id, options.symbol, options.status, pageSize, offset]
    );

    return ordersRes.rows.map(r => ({
      id: r.id,
      clientOrderId: r.clientOrderId || r.client_order_id,
      accountId: r.accountId || r.account_id,
      market: r.market,
      symbol: r.symbol,
      side: r.side,
      type: r.type,
      price: r.price,
      quantity: r.quantity,
      filledQuantity: r.filledQuantity || r.filled_quantity,
      remainingQuantity: r.remainingQuantity || r.remaining_quantity,
      lockedAmount: r.lockedAmount || r.locked_amount,
      lockedAsset: r.lockedAsset || r.locked_asset,
      status: r.status,
      timeInForce: r.timeInForce || r.time_in_force,
      createdAt: new Date(r.createdAt || r.created_at),
      updatedAt: new Date(r.updatedAt || r.updated_at),
    }));
  }

  /**
   * Get paginated trade history for authenticated user.
   */
  public async getTradeHistory(userId: string, options: GetTradesOptions = {}): Promise<TradeEntity[]> {
    const accRes = await this.database.query<any>(
      "SELECT id FROM accounts WHERE user_id = $1 AND type = 'SPOT'",
      [userId]
    );
    const spotAcc = accRes.rows[0];
    if (!spotAcc) {
      return [];
    }

    const page = options.page || 1;
    const pageSize = options.pageSize || 50;
    const offset = (page - 1) * pageSize;

    const tradesRes = await this.database.query<any>(
      'SELECT * FROM trades WHERE account_id = $1',
      [spotAcc.id, options.symbol, pageSize, offset]
    );

    return tradesRes.rows.map(r => ({
      id: r.id,
      orderId: r.orderId || r.order_id,
      accountId: r.accountId || r.account_id,
      market: r.market,
      symbol: r.symbol,
      side: r.side,
      price: r.price,
      quantity: r.quantity,
      quoteQuantity: r.quoteQuantity || r.quote_quantity,
      fee: r.fee,
      feeAsset: r.feeAsset || r.fee_asset,
      isMaker: Boolean(r.isMaker ?? r.is_maker),
      counterpartyOrderId: r.counterpartyOrderId || r.counterparty_order_id,
      createdAt: new Date(r.createdAt || r.created_at),
    }));
  }

  /**
   * Order book recovery on server startup.
   * Loads all active open/partially-filled orders from database into in-memory matching books.
   */
  public async recoverMatchingEngine(): Promise<number> {
    this.engine.clear();

    const openOrdersRes = await this.database.query<any>(
      "SELECT * FROM orders WHERE status IN ('NEW', 'PARTIALLY_FILLED')"
    );

    const openOrders: OrderEntity[] = openOrdersRes.rows.map(r => ({
      id: r.id,
      clientOrderId: r.clientOrderId || r.client_order_id,
      accountId: r.accountId || r.account_id,
      market: r.market,
      symbol: r.symbol,
      side: r.side,
      type: r.type,
      price: r.price,
      quantity: r.quantity,
      filledQuantity: r.filledQuantity || r.filled_quantity,
      remainingQuantity: r.remainingQuantity || r.remaining_quantity,
      lockedAmount: r.lockedAmount || r.locked_amount,
      lockedAsset: r.lockedAsset || r.locked_asset,
      status: r.status,
      timeInForce: r.timeInForce || r.time_in_force,
      createdAt: new Date(r.createdAt || r.created_at),
      updatedAt: new Date(r.updatedAt || r.updated_at),
    }));

    for (const ord of openOrders) {
      if (ord.type === 'LIMIT') {
        const book = this.engine.getBook(ord.symbol);
        book.addRestingOrder(ord);
      }
    }

    logger.info('Matching engine recovered from database', { recoveredOrdersCount: openOrders.length });
    return openOrders.length;
  }

  /**
   * Get public simulated order book depth.
   */
  public getOrderBookDepth(symbol: string, limit = 20): OrderBookDepth {
    return this.engine.getDepth(symbol, limit);
  }
}

export const spotService = new SpotService();
