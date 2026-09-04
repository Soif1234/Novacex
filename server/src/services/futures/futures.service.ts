import crypto from 'crypto';
import { db, IDatabaseConnection } from '../../config/database';
import {
  FuturesPositionEntity,
  FuturesOrderEntity,
  PositionSide,
  MarginMode,
} from '../../models/futures.model';
import { OrderEntity, TradeEntity, OrderSide, OrderType, OrderStatus } from '../../models/order.model';
import { LedgerService, ledgerService } from '../ledger/ledger.service';
import { futuresRiskService, FuturesRiskService } from './risk.service';
import { futuresPositionService, FuturesPositionService } from './position.service';
import { futuresFeeService, FuturesFeeService } from './fee.service';
import { INSURANCE_FUND_ACCOUNT_ID } from './insurance-fund.service';
import { developmentMarkPriceProvider, IMarkPriceProvider } from './mark-price.provider';
import {
  decimalNormalize,
  decimalMultiply,
  decimalSubtract,
  decimalAdd,
  decimalCompare,
  decimalZero,
  decimalMin,
  validateAmount,
} from '../ledger/decimal';
import { eventBus } from '../market/event-bus';

import {
  FuturesError,
  FuturesErrorCode,
  InvalidFuturesSymbolError,
  InvalidLeverageError,
  InsufficientCollateralError,
  PositionNotFoundError,
  NoPositionToCloseError,
} from './errors';
import {
  AccountNotFoundError,
  AccountOwnershipDeniedError,
} from '../wallet/errors';
import { ReferenceConflictError } from '../ledger/errors';
import { logger } from '../../config/logger';

export interface CreateFuturesOrderDto {
  userId: string;
  accountId: string;
  symbol: string;
  side: OrderSide;
  positionSide: PositionSide;
  type: OrderType;
  price?: string;
  stopPrice?: string;
  quantity: string;
  leverage: number;
  marginMode: MarginMode;
  reduceOnly?: boolean;
  closePosition?: boolean;
  clientOrderId?: string;
  timeInForce?: string;
}

export interface FuturesExecutionResult {
  order: OrderEntity;
  futuresOrder: FuturesOrderEntity;
  position?: FuturesPositionEntity;
  trade?: TradeEntity;
}

export interface GetFuturesOrdersOptions {
  accountId?: string;
  symbol?: string;
  status?: OrderStatus;
  side?: OrderSide;
  page?: number;
  pageSize?: number;
}

export interface GetFuturesTradesOptions {
  accountId?: string;
  symbol?: string;
  orderId?: string;
  page?: number;
  pageSize?: number;
}

export interface FuturesContractConfig {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  maximumLeverage: number;
  maintenanceMarginRate: string;
  minimumQuantity: string;
  tickSize: string;
}

export class FuturesService {
  private contractConfigs = new Map<string, FuturesContractConfig>([
    [
      'BTCUSDT',
      {
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        maximumLeverage: 125,
        maintenanceMarginRate: '0.005',
        minimumQuantity: '0.001',
        tickSize: '0.01',
      },
    ],
    [
      'ETHUSDT',
      {
        symbol: 'ETHUSDT',
        baseAsset: 'ETH',
        quoteAsset: 'USDT',
        maximumLeverage: 100,
        maintenanceMarginRate: '0.005',
        minimumQuantity: '0.01',
        tickSize: '0.01',
      },
    ],
    [
      'SOLUSDT',
      {
        symbol: 'SOLUSDT',
        baseAsset: 'SOL',
        quoteAsset: 'USDT',
        maximumLeverage: 50,
        maintenanceMarginRate: '0.01',
        minimumQuantity: '0.1',
        tickSize: '0.001',
      },
    ],
    [
      'BTCUSDC',
      {
        symbol: 'BTCUSDC',
        baseAsset: 'BTC',
        quoteAsset: 'USDC',
        maximumLeverage: 125,
        maintenanceMarginRate: '0.005',
        minimumQuantity: '0.001',
        tickSize: '0.01',
      },
    ],
  ]);

  constructor(
    private database: IDatabaseConnection = db,
    private ledger: LedgerService = ledgerService,
    private risk: FuturesRiskService = futuresRiskService,
    private positions: FuturesPositionService = futuresPositionService,
    private feeSvc: FuturesFeeService = futuresFeeService,
    private markPrices: IMarkPriceProvider = developmentMarkPriceProvider
  ) {}

  public getContractConfig(symbol: string): FuturesContractConfig {
    const cleanSymbol = symbol.trim().toUpperCase();
    const config = this.contractConfigs.get(cleanSymbol);
    if (!config) {
      // Default fallback contract configuration for test symbols
      return {
        symbol: cleanSymbol,
        baseAsset: cleanSymbol.replace(/USDT|USDC$/, '') || 'BTC',
        quoteAsset: 'USDT',
        maximumLeverage: 125,
        maintenanceMarginRate: '0.005',
        minimumQuantity: '0.001',
        tickSize: '0.01',
      };
    }
    return config;
  }

  /**
   * Place and execute/schedule a new Futures order.
   */
  public async placeOrder(dto: CreateFuturesOrderDto): Promise<FuturesExecutionResult> {
    // 1. Verify account ownership and account type
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
    if (acc.type !== 'FUTURES') {
      throw new FuturesError(`Account ${dto.accountId} is not a FUTURES account`, 400, FuturesErrorCode.INVALID_ACCOUNT_TYPE);
    }

    // 2. Validate contract & parameters
    const contract = this.getContractConfig(dto.symbol);
    if (!this.risk.isValidLeverage(dto.leverage, contract.maximumLeverage)) {
      throw new InvalidLeverageError(dto.leverage, contract.maximumLeverage);
    }

    if (dto.side !== 'BUY' && dto.side !== 'SELL') {
      throw new FuturesError(`Invalid side "${dto.side}": must be BUY or SELL`, 400, FuturesErrorCode.INVALID_ORDER_SIDE);
    }

    if (dto.positionSide !== 'LONG' && dto.positionSide !== 'SHORT') {
      throw new FuturesError(`Invalid positionSide "${dto.positionSide}": must be LONG or SHORT`, 400, FuturesErrorCode.INVALID_POSITION_SIDE);
    }

    if (
      dto.type !== 'LIMIT' &&
      dto.type !== 'MARKET' &&
      dto.type !== 'STOP_LIMIT' &&
      dto.type !== 'TAKE_PROFIT_LIMIT'
    ) {
      throw new FuturesError(
        `Invalid order type "${dto.type}": must be LIMIT, MARKET, STOP_LIMIT, or TAKE_PROFIT_LIMIT`,
        400,
        FuturesErrorCode.INVALID_ORDER_TYPE
      );
    }

    if (dto.marginMode !== 'ISOLATED' && dto.marginMode !== 'CROSS') {
      throw new FuturesError(`Invalid marginMode "${dto.marginMode}": must be ISOLATED or CROSS`, 400, FuturesErrorCode.INVALID_MARGIN_MODE);
    }

    validateAmount(dto.quantity);

    if (dto.type === 'LIMIT' || dto.type === 'STOP_LIMIT' || dto.type === 'TAKE_PROFIT_LIMIT') {
      if (!dto.price) {
        throw new FuturesError(`Limit price is required for ${dto.type} orders`, 400, FuturesErrorCode.INVALID_PRICE);
      }
      validateAmount(dto.price);
    }

    if (dto.type === 'STOP_LIMIT' || dto.type === 'TAKE_PROFIT_LIMIT') {
      if (!dto.stopPrice) {
        throw new FuturesError(`Stop price is required for ${dto.type} orders`, 400, FuturesErrorCode.INVALID_PRICE);
      }
      validateAmount(dto.stopPrice);
    }

    const cleanSymbol = contract.symbol;
    const cleanQty = decimalNormalize(dto.quantity);
    const cleanPrice = dto.price ? decimalNormalize(dto.price) : undefined;
    const cleanStopPrice = dto.stopPrice ? decimalNormalize(dto.stopPrice) : undefined;
    const cleanClientOrderId = dto.clientOrderId?.trim();

    // Check minimum quantity
    if (decimalCompare(cleanQty, contract.minimumQuantity) < 0) {
      throw new FuturesError(
        `Quantity (${cleanQty}) is below minimum required (${contract.minimumQuantity})`,
        400,
        FuturesErrorCode.MINIMUM_QUANTITY_NOT_MET
      );
    }

    // ─────────────────────────────────────────────────────────────────────
    // AUTHORITATIVE TRANSACTION (P1-1): every financially coupled write —
    // client-order idempotency, margin reservation, order insert, matching
    // and execution, position create/increase/reduce, PnL & fee ledger
    // settlement, trade insert, and order status — runs inside ONE database
    // transaction. Any failure ROLLS BACK all of it: no orphan margin, no
    // order without funds state, no funds lock without a corresponding order.
    // ─────────────────────────────────────────────────────────────────────
    let order!: OrderEntity;
    let futuresOrder!: FuturesOrderEntity;
    let resultingPosition: FuturesPositionEntity | undefined;
    let executedTrade: TradeEntity | undefined;
    let replayResult: FuturesExecutionResult | undefined;
    let shouldExecute = false;

    await this.database.transaction(async (tx) => {
      // 3. Check idempotency if clientOrderId is provided
      if (cleanClientOrderId) {
        const existingRes = await tx.query<any>(
          'SELECT * FROM orders WHERE account_id = $1 AND client_order_id = $2',
          [dto.accountId, cleanClientOrderId]
        );
        const existing = existingRes.rows[0];
        if (existing) {
          const match =
            existing.symbol === cleanSymbol &&
            existing.side === dto.side &&
            existing.type === dto.type &&
            decimalCompare(existing.quantity, cleanQty) === 0 &&
            (!cleanPrice || (existing.price && decimalCompare(existing.price, cleanPrice) === 0));

          if (match) {
            const foRes = await tx.query<any>('SELECT * FROM futures_orders WHERE order_id = $1', [existing.id]);
            const trRes = await tx.query<any>('SELECT * FROM trades WHERE order_id = $1', [existing.id]);
            const pos = await this.positions.getOpenPosition(dto.accountId, cleanSymbol, dto.positionSide, tx);
            replayResult = {
              order: existing,
              futuresOrder: foRes.rows[0],
              position: pos || undefined,
              trade: trRes.rows[0],
            };
            return; // idempotent replay: nothing new written; commit is a no-op
          } else {
            throw new ReferenceConflictError(cleanClientOrderId);
          }
        }
      }

    const isOpening =
      (dto.side === 'BUY' && dto.positionSide === 'LONG') ||
      (dto.side === 'SELL' && dto.positionSide === 'SHORT');
    const isClosing =
      (dto.side === 'SELL' && dto.positionSide === 'LONG') ||
      (dto.side === 'BUY' && dto.positionSide === 'SHORT');

    const existingPosition = await this.positions.getOpenPosition(dto.accountId, cleanSymbol, dto.positionSide, tx, true);

    if (isClosing && !existingPosition) {
      throw new NoPositionToCloseError(cleanSymbol, dto.positionSide);
    }

    if (isOpening && existingPosition) {
      if (existingPosition.leverage !== dto.leverage) {
        throw new FuturesError(
          `Leverage ${dto.leverage}x does not match existing position leverage ${existingPosition.leverage}x`,
          400,
          FuturesErrorCode.LEVERAGE_MISMATCH
        );
      }
      if (existingPosition.marginMode !== dto.marginMode) {
        throw new FuturesError(
          `Margin mode ${dto.marginMode} does not match existing position margin mode ${existingPosition.marginMode}`,
          400,
          FuturesErrorCode.MARGIN_MODE_MISMATCH
        );
      }
    }

    const orderId = crypto.randomUUID();
    const markPrice = await this.markPrices.getMarkPrice(cleanSymbol);
    const orderPrice = cleanPrice || markPrice;
    let requiredMargin = decimalZero();

    let collateralAsset = 'FUTURES_USDT';
    // 4. Reserve initial margin for opening orders
    if (isOpening) {
      requiredMargin = this.risk.calculateInitialMargin(cleanQty, orderPrice, dto.leverage);
      let balance = await this.ledger.getBalance(dto.accountId, 'FUTURES_USDT', tx);
      if (decimalCompare(balance.availableBalance, requiredMargin) < 0) {
        const usdtBal = await this.ledger.getBalance(dto.accountId, 'USDT', tx);
        if (decimalCompare(usdtBal.availableBalance, requiredMargin) >= 0) {
          balance = usdtBal;
          collateralAsset = 'USDT';
        }
      }

      if (!this.risk.hasSufficientMargin(balance.availableBalance, requiredMargin)) {
        throw new InsufficientCollateralError(requiredMargin, balance.availableBalance, collateralAsset);
      }

      await this.ledger.reserve(
        dto.accountId,
        collateralAsset,
        requiredMargin,
        'FUTURES_MARGIN_LOCK',
        `FUTURES-LOCK-${orderId}`,
        `Futures margin lock: ${cleanSymbol} ${dto.positionSide} ${cleanQty} @ ${orderPrice} (${dto.leverage}x)`,
        undefined,
        tx
      );
    }

    // 5. Create Order & FuturesOrder entities
    const initialStatus = (dto.type === 'STOP_LIMIT' || dto.type === 'TAKE_PROFIT_LIMIT') ? 'UNTRIGGERED' : 'NEW';

    order = {
      id: orderId,
      clientOrderId: cleanClientOrderId,
      accountId: dto.accountId,
      market: 'FUTURES',
      symbol: cleanSymbol,
      side: dto.side,
      type: dto.type,
      price: cleanPrice,
      stopPrice: cleanStopPrice,
      quantity: cleanQty,
      filledQuantity: '0',
      remainingQuantity: cleanQty,
      lockedAmount: requiredMargin,
      lockedAsset: collateralAsset,
      status: initialStatus,
      timeInForce: dto.timeInForce || 'GTC',
      createdAt: new Date(),
      updatedAt: new Date(),
    };


    futuresOrder = {
      id: crypto.randomUUID(),
      orderId,
      accountId: dto.accountId,
      symbol: cleanSymbol,
      positionSide: dto.positionSide,
      leverage: dto.leverage,
      marginMode: dto.marginMode,
      reduceOnly: Boolean(dto.reduceOnly || isClosing),
      closePosition: Boolean(dto.closePosition),
      createdAt: new Date(),
    };

    await tx.query(
      `INSERT INTO orders (
        id, client_order_id, account_id, market, symbol, side, type, price, stop_price, quantity,
        filled_quantity, remaining_quantity, locked_amount, locked_asset, status,
        time_in_force, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        order.id,
        order.clientOrderId,
        order.accountId,
        order.market,
        order.symbol,
        order.side,
        order.type,
        order.price,
        order.stopPrice,
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

    await tx.query(
      `INSERT INTO futures_orders (
        id, order_id, account_id, symbol, position_side, leverage, margin_mode,
        reduce_only, close_position, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        futuresOrder.id,
        futuresOrder.orderId,
        futuresOrder.accountId,
        futuresOrder.symbol,
        futuresOrder.positionSide,
        futuresOrder.leverage,
        futuresOrder.marginMode,
        futuresOrder.reduceOnly,
        futuresOrder.closePosition,
        futuresOrder.createdAt,
      ]
    );

    // 6. Execute Order (Market executes immediately; Limit executes if price crosses)
    let execPrice = markPrice;

    if (dto.type === 'MARKET') {
      shouldExecute = true;
      execPrice = markPrice;
    } else if (dto.type === 'LIMIT' && cleanPrice) {
      // For testing and simulation: BUY limit executes if mark <= limit; SELL limit executes if mark >= limit
      if (dto.side === 'BUY' && decimalCompare(markPrice, cleanPrice) <= 0) {
        shouldExecute = true;
        execPrice = cleanPrice;
      } else if (dto.side === 'SELL' && decimalCompare(markPrice, cleanPrice) >= 0) {
        shouldExecute = true;
        execPrice = cleanPrice;
      }
    }

    if (shouldExecute) {
      if (isOpening) {
        if (existingPosition) {
          resultingPosition = await this.positions.increasePosition(
            existingPosition,
            cleanQty,
            execPrice,
            contract.maintenanceMarginRate,
            undefined,
            tx
          );
        } else {
          resultingPosition = await this.positions.createPosition({
            accountId: dto.accountId,
            symbol: cleanSymbol,
            side: dto.positionSide,
            quantity: cleanQty,
            entryPrice: execPrice,
            leverage: dto.leverage,
            marginMode: dto.marginMode,
            maintenanceMarginRate: contract.maintenanceMarginRate,
            collateralAsset,
          }, tx);
        }
      } else if (isClosing && existingPosition) {
        const reduceRes = await this.positions.reducePosition(
          existingPosition,
          cleanQty,
          execPrice,
          contract.maintenanceMarginRate,
          undefined,
          tx
        );
        resultingPosition = reduceRes.updatedPosition;

          const pnlRef = `FUTURES-PNL-${orderId}`;
          const entries: any[] = [];
          
          if (decimalCompare(reduceRes.freedMargin, '0') > 0) {
            const collateralForReduce = existingPosition.collateralAsset || 'FUTURES_USDT';
            entries.push(
              { accountId: dto.accountId, asset: collateralForReduce, direction: 'DEBIT', amount: reduceRes.freedMargin, balancePool: 'locked' },
              { accountId: dto.accountId, asset: collateralForReduce, direction: 'CREDIT', amount: reduceRes.freedMargin, balancePool: 'available' }
            );
          }
          
          if (decimalCompare(reduceRes.realizedPnl, '0') > 0) {
            entries.push({ accountId: dto.accountId, asset: existingPosition.collateralAsset || 'FUTURES_USDT', direction: 'CREDIT', amount: reduceRes.realizedPnl, balancePool: 'available' });
            entries.push({ accountId: INSURANCE_FUND_ACCOUNT_ID, asset: existingPosition.collateralAsset || 'FUTURES_USDT', direction: 'DEBIT', amount: reduceRes.realizedPnl, balancePool: 'available' });
          } else if (decimalCompare(reduceRes.realizedPnl, '0') < 0) {
             const loss = decimalSubtract('0', reduceRes.realizedPnl);
             const bal = await this.ledger.getBalance(dto.accountId, existingPosition.collateralAsset || 'FUTURES_USDT', tx);
             const tempAvailable = decimalAdd(bal.availableBalance, reduceRes.freedMargin);
             const debitLoss = decimalCompare(tempAvailable, loss) >= 0 ? loss : tempAvailable;
             if (decimalCompare(debitLoss, '0') > 0) {
               entries.push({ accountId: dto.accountId, asset: existingPosition.collateralAsset || 'FUTURES_USDT', direction: 'DEBIT', amount: debitLoss, balancePool: 'available' });
               entries.push({ accountId: INSURANCE_FUND_ACCOUNT_ID, asset: existingPosition.collateralAsset || 'FUTURES_USDT', direction: 'CREDIT', amount: debitLoss, balancePool: 'available' });
             }
          }
          
          if (entries.length > 0) {
            await this.ledger.postTransaction({
              accountId: dto.accountId,
              transactionType: 'FUTURES_PNL_REALIZED',
              referenceId: pnlRef,
              description: `Futures Position Reduction: ${cleanSymbol} ${dto.positionSide} ${cleanQty} @ ${execPrice}`,
              entries
            }, tx);
          }
        }
      // Calculate and debit trading fee
      const isMaker = dto.type === 'LIMIT';
      const feeResult = this.feeSvc.calculateExecutionFee(cleanQty, execPrice, isMaker);
      const tradeId = crypto.randomUUID();

      if (decimalCompare(feeResult.feeAmount, '0') > 0) {
        const feeAssetForDebit = existingPosition?.collateralAsset || collateralAsset || 'FUTURES_USDT';
        const bal = await this.ledger.getBalance(dto.accountId, feeAssetForDebit, tx);
        const feeDebit = decimalCompare(bal.availableBalance, feeResult.feeAmount) >= 0 ? feeResult.feeAmount : bal.availableBalance;
        if (decimalCompare(feeDebit, '0') > 0) {
          await this.ledger.postTransaction({
            accountId: dto.accountId,
            transactionType: 'TRADING_FEE' as any,
            referenceId: `FUTURES-FEE-${tradeId}`,
            description: `Futures Trading Fee (${feeResult.feeType}): ${cleanSymbol} order ${orderId}`,
            entries: [
              { accountId: dto.accountId, asset: feeAssetForDebit, direction: 'DEBIT', amount: feeDebit, balancePool: 'available' },
              { accountId: '11111111-1111-1111-1111-111111111111', asset: feeAssetForDebit, direction: 'CREDIT', amount: feeDebit, balancePool: 'available' }
            ]
          }, tx);
        }
      }

      // Create trade execution record
      executedTrade = {
        id: tradeId,
        orderId: order.id,
        accountId: order.accountId,
        market: 'FUTURES',
        symbol: cleanSymbol,
        side: order.side,
        price: execPrice,
        quantity: cleanQty,
        quoteQuantity: decimalMultiply(cleanQty, execPrice),
        fee: feeResult.feeAmount,
        feeAsset: existingPosition?.collateralAsset || collateralAsset || 'FUTURES_USDT',
        isMaker,
        createdAt: new Date(),
      };

      await tx.query(
        `INSERT INTO trades (
          id, order_id, account_id, market, symbol, side, price, quantity, quote_quantity,
          fee, fee_asset, is_maker, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          executedTrade.id,
          executedTrade.orderId,
          executedTrade.accountId,
          executedTrade.market,
          executedTrade.symbol,
          executedTrade.side,
          executedTrade.price,
          executedTrade.quantity,
          executedTrade.quoteQuantity,
          executedTrade.fee,
          executedTrade.feeAsset,
          executedTrade.isMaker,
          executedTrade.createdAt,
        ]
      );

      // Update order to FILLED
      order.status = 'FILLED';
      order.filledQuantity = order.quantity;
      order.remainingQuantity = decimalZero();
      order.updatedAt = new Date();

      await tx.query(
        'UPDATE orders SET status = $1, filled_quantity = $2, remaining_quantity = $3, updated_at = NOW() WHERE id = $4',
        ['FILLED', order.filledQuantity, order.remainingQuantity, order.id]
      );
    }

    // ── End authoritative transaction ────────────────────────────────────
    });

    // Idempotent replay: return the pre-existing order without re-running
    // any financial writes or re-emitting domain events.
    if (replayResult) {
      return replayResult;
    }

    // ── Emit Domain Events strictly after successful commit ──────────────
    try {
      eventBus.publish({
        id: crypto.randomUUID(),
        type: order.status === 'NEW' ? 'futures.order.created' : 'futures.order.updated',
        channel: 'user:orders',
        userId: dto.userId,
        symbol: cleanSymbol,
        timestamp: Date.now(),
        version: '1.0.0',
        payload: {
          orderId: order.id,
          clientOrderId: order.clientOrderId,
          market: 'FUTURES',
          symbol: order.symbol,
          side: order.side,
          positionSide: dto.positionSide,
          type: order.type,
          price: order.price,
          quantity: order.quantity,
          filledQuantity: order.filledQuantity,
          remainingQuantity: order.remainingQuantity,
          status: order.status,
          timeInForce: order.timeInForce,
          createdAt: order.createdAt.getTime(),
          updatedAt: order.updatedAt.getTime(),
        },
      });

      if (executedTrade) {
        eventBus.publish({
          id: crypto.randomUUID(),
          type: 'futures.trade.executed',
          channel: 'user:trades',
          userId: dto.userId,
          symbol: executedTrade.symbol,
          timestamp: executedTrade.createdAt.getTime(),
          version: '1.0.0',
          payload: {
            tradeId: executedTrade.id,
            orderId: executedTrade.orderId,
            market: 'FUTURES',
            symbol: executedTrade.symbol,
            side: executedTrade.side,
            positionSide: dto.positionSide,
            price: executedTrade.price,
            quantity: executedTrade.quantity,
            quoteQuantity: executedTrade.quoteQuantity,
            fee: executedTrade.fee,
            feeAsset: executedTrade.feeAsset,
            isMaker: executedTrade.isMaker,
            timestamp: executedTrade.createdAt.getTime(),
          },
        });
      }

      if (resultingPosition) {
        eventBus.publish({
          id: crypto.randomUUID(),
          type: 'futures.position.updated',
          channel: 'user:positions',
          userId: dto.userId,
          symbol: resultingPosition.symbol,
          timestamp: Date.now(),
          version: '1.0.0',
          payload: {
            positionId: resultingPosition.id,
            symbol: resultingPosition.symbol,
            side: resultingPosition.side,
            quantity: resultingPosition.quantity,
            entryPrice: resultingPosition.entryPrice,
            markPrice: resultingPosition.markPrice,
            liquidationPrice: resultingPosition.liquidationPrice,
            leverage: resultingPosition.leverage,
            marginMode: resultingPosition.marginMode,
            initialMargin: resultingPosition.initialMargin,
            maintenanceMargin: resultingPosition.maintenanceMargin,
            realizedPnl: resultingPosition.realizedPnl,
            status: resultingPosition.status,
            timestamp: Date.now(),
          },
        });
      }
    } catch (evtErr: any) {
      logger.warn('Failed to emit futures events', { error: evtErr.message });
    }

    logger.info('Futures order processed', {
      orderId: order.id,
      symbol: cleanSymbol,
      side: order.side,
      positionSide: dto.positionSide,
      type: order.type,
      status: order.status,
      leverage: dto.leverage,
      isExecuted: shouldExecute,
    });

    return {
      order,
      futuresOrder,
      position: resultingPosition,
      trade: executedTrade,
    };
  }


  /**
   * Cancel an open Futures order and release remaining reserved margin.
   */
  /**
   * Activate an UNTRIGGERED conditional order.
   */
  public async triggerOrder(orderId: string): Promise<boolean> {
    const orderRes = await this.database.query<any>(
      "SELECT o.*, a.user_id FROM orders o JOIN accounts a ON o.account_id = a.id WHERE o.id = $1 AND o.status = 'UNTRIGGERED' FOR UPDATE",
      [orderId]
    );
    const row = orderRes.rows[0];
    if (!row) return false;

    await this.database.query(
      "UPDATE orders SET status = 'NEW', updated_at = NOW() WHERE id = $1",
      [orderId]
    );

    const order: OrderEntity = {
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
      status: 'NEW',
      timeInForce: row.time_in_force,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(),
    };

    eventBus.publish({
      id: crypto.randomUUID(),
      type: 'futures.order.updated',
      channel: 'user:orders',
      userId: row.user_id,
      symbol: order.symbol,
      timestamp: Date.now(),
      version: '1.0.0',
      payload: {
        orderId: order.id,
        clientOrderId: order.clientOrderId,
        accountId: order.accountId,
        symbol: order.symbol,
        side: order.side,
        positionSide: row.position_side,
        type: order.type,
        status: order.status,
        price: order.price,
        stopPrice: order.stopPrice,
        quantity: order.quantity,
        filledQuantity: order.filledQuantity,
        remainingQuantity: order.remainingQuantity,
        timestamp: Date.now(),
      },
    });

    return true;
  }


  public async cancelOrder(userId: string, orderId: string): Promise<OrderEntity> {
    let cancelledOrder!: OrderEntity;

    await this.database.transaction(async (tx) => {
      const orderRes = await tx.query<any>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
      const orderRow = orderRes.rows[0];
      if (!orderRow) {
        throw new FuturesError(`Futures order "${orderId}" was not found`, 404, FuturesErrorCode.ORDER_NOT_FOUND);
      }

      const accRes = await tx.query<any>('SELECT id, user_id AS "userId" FROM accounts WHERE id = $1', [
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
        market: 'FUTURES',
        symbol: orderRow.symbol,
        side: orderRow.side,
        type: orderRow.type,
        price: orderRow.price,
        stopPrice: orderRow.stopPrice || orderRow.stop_price,
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

      if (order.status === 'CANCELLED') {
        cancelledOrder = order;
        return;
      }

      if (order.status !== 'NEW' && order.status !== 'PARTIALLY_FILLED') {
        throw new FuturesError(
          `Futures order "${orderId}" cannot be cancelled in status "${order.status}"`,
          400,
          FuturesErrorCode.ORDER_NOT_CANCELLABLE
        );
      }

      // Release remaining locked margin if opening order had reserved margin
      if (decimalCompare(order.lockedAmount, '0') > 0) {
        await this.ledger.release(
          order.accountId,
          order.lockedAsset || 'FUTURES_USDT',
          order.lockedAmount,
          'FUTURES_MARGIN_RELEASE',
          `FUTURES-UNLOCK-${order.id}`,
          `Cancel Futures order: ${order.symbol} ${order.side} ${order.quantity}`,
          undefined,
          tx
        );
      }

      order.status = 'CANCELLED';
      order.updatedAt = new Date();

      await tx.query('UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2', [
        'CANCELLED',
        order.id,
      ]);

      cancelledOrder = order;
    });

    // ── Emit Domain Events strictly after successful commit ──────────────
    try {
      eventBus.publish({
        id: crypto.randomUUID(),
        type: 'futures.order.updated',
        channel: 'user:orders',
        userId,
        symbol: cancelledOrder.symbol,
        timestamp: Date.now(),
        version: '1.0.0',
        payload: {
          orderId: cancelledOrder.id,
          clientOrderId: cancelledOrder.clientOrderId,
          market: 'FUTURES',
          symbol: cancelledOrder.symbol,
          side: cancelledOrder.side,
          type: cancelledOrder.type,
          price: cancelledOrder.price,
          quantity: cancelledOrder.quantity,
          filledQuantity: cancelledOrder.filledQuantity,
          remainingQuantity: cancelledOrder.remainingQuantity,
          status: 'CANCELLED',
          timeInForce: cancelledOrder.timeInForce,
          createdAt: cancelledOrder.createdAt.getTime(),
          updatedAt: cancelledOrder.updatedAt.getTime(),
        },
      });
    } catch (evtErr: any) {
      logger.warn('Failed to emit futures cancel event', { error: evtErr.message });
    }

    return cancelledOrder;
  }

  /**
   * Authoritatively execute a resting FUTURES LIMIT order when market/mark price crosses.
   *
   * Invariant guarantees:
   * 1. Atomicity & Concurrency: Claims order with SELECT ... FOR UPDATE within a transaction.
   *    If order status is not 'NEW' / 'PARTIALLY_FILLED', immediately aborts with null.
   * 2. Authoritative Mark Price: Checks markPrice from markPrices provider (or override).
   *    Fail-closed if missing, non-positive, or does not cross.
   * 3. Price Crossing:
   *    BUY LIMIT: markPrice <= order.price
   *    SELL LIMIT: markPrice >= order.price
   * 4. State & Margin Race (Section 7):
   *    - For opening: Verifies reserved locked margin on account. If deficit, transitions order to REJECTED.
   *    - For closing: Verifies open position exists. If closed/liquidated while resting, transitions order to REJECTED.
   * 5. Canonical Execution Path: Reuses exact ledger, position, fee, and trade settlement.
   * 6. Events & Domain Notifications: Emits futures.trade.executed, futures.position.updated, futures.order.updated after commit.
   */
  public async executeRestingOrder(
    orderId: string,
    markPriceOverride?: string,
    fillQuantity?: string
  ): Promise<FuturesExecutionResult | null> {
    let resultingOrder: OrderEntity | undefined;
    let resultingFuturesOrder: FuturesOrderEntity | undefined;
    let resultingPosition: FuturesPositionEntity | undefined;
    let executedTrade: TradeEntity | undefined;
    let accountUserId: string | undefined;

    await this.database.transaction(async (tx) => {
      // 1. Atomic claim: Lock order with FOR UPDATE
      const orderRes = await tx.query<any>(
        `SELECT o.*, fo.id as fo_id, fo.position_side, fo.leverage, fo.margin_mode,
                fo.reduce_only, fo.close_position, a.user_id as user_id
         FROM orders o
         JOIN futures_orders fo ON o.id = fo.order_id
         JOIN accounts a ON o.account_id = a.id
         WHERE o.id = $1 AND o.market = 'FUTURES' AND o.status IN ('NEW', 'PARTIALLY_FILLED')
         FOR UPDATE OF o`,
        [orderId]
      );

      const row = orderRes.rows[0];
      if (!row) {
        // Order is not in NEW/PARTIALLY_FILLED status, does not exist, or was concurrently processed/cancelled
        return;
      }

      accountUserId = row.user_id || row.userId;
      const cleanSymbol = row.symbol.trim().toUpperCase();
      const contract = this.getContractConfig(cleanSymbol);
      const totalQty = decimalNormalize(row.quantity);
      const remainingQty = decimalNormalize(row.remaining_quantity || row.remainingQuantity || totalQty);
      const cleanPrice = decimalNormalize(row.price);
      const positionSide = (row.position_side || row.positionSide) as PositionSide;
      const leverage = Number(row.leverage);
      const marginMode = (row.margin_mode || row.marginMode) as MarginMode;
      const isReduceOnly = Boolean(row.reduce_only || row.reduceOnly);
      const collateralAsset = row.locked_asset || row.lockedAsset || 'FUTURES_USDT';
      const lockedAmount = row.locked_amount || row.lockedAmount || '0';

      // Determine fill quantity: defaults to full remaining quantity
      const execQty = fillQuantity ? decimalNormalize(fillQuantity) : remainingQty;
      if (decimalCompare(execQty, '0') <= 0 || decimalCompare(execQty, remainingQty) > 0) {
        return;
      }

      // 2. Authoritative mark price resolution
      let markPrice: string | undefined = markPriceOverride;
      if (!markPrice) {
        try {
          markPrice = await this.markPrices.getMarkPrice(cleanSymbol);
        } catch (err: any) {
          logger.warn('Failed to fetch mark price for resting limit order', { orderId, symbol: cleanSymbol, error: err.message });
          return; // fail-closed: do not execute at unknown price
        }
      }

      if (!markPrice || decimalCompare(markPrice, '0') <= 0) {
        return; // fail-closed: non-positive or invalid price
      }

      // 3. Price crossing condition:
      // BUY: markPrice <= order.price
      // SELL: markPrice >= order.price
      let crosses = false;
      if (row.side === 'BUY' && decimalCompare(markPrice, cleanPrice) <= 0) {
        crosses = true;
      } else if (row.side === 'SELL' && decimalCompare(markPrice, cleanPrice) >= 0) {
        crosses = true;
      }

      if (!crosses) {
        return; // price has not reached or crossed the limit order price
      }

      const isOpening =
        (row.side === 'BUY' && positionSide === 'LONG') ||
        (row.side === 'SELL' && positionSide === 'SHORT');
      const isClosing =
        (row.side === 'SELL' && positionSide === 'LONG') ||
        (row.side === 'BUY' && positionSide === 'SHORT');

      // 4. Position & Margin validation (Section 7 - Insufficient Margin / State Race)
      const existingPosition = await this.positions.getOpenPosition(row.account_id, cleanSymbol, positionSide, tx, true);

      if (isClosing && !existingPosition) {
        // The position to close is no longer open (e.g. liquidated or closed by TP/SL)
        // Transition order safely to REJECTED according to the existing business model
        if (decimalCompare(lockedAmount, '0') > 0) {
          await this.ledger.release(
            row.account_id,
            collateralAsset,
            lockedAmount,
            'FUTURES_MARGIN_RELEASE',
            `FUTURES-UNLOCK-${row.id}`,
            `Reject resting order: no position to close`,
            undefined,
            tx
          );
        }
        await tx.query("UPDATE orders SET status = 'REJECTED', updated_at = NOW() WHERE id = $1", [row.id]);
        return;
      }

      if (isOpening) {
        // Check account locked balance satisfies order.lockedAmount
        const bal = await this.ledger.getBalance(row.account_id, collateralAsset, tx);
        if (decimalCompare(bal.lockedBalance, lockedAmount) < 0) {
          // Insufficient margin race: locked balance was depleted/corrupted
          if (decimalCompare(bal.lockedBalance, '0') > 0 && decimalCompare(lockedAmount, '0') > 0) {
            const toRelease = decimalMin(bal.lockedBalance, lockedAmount);
            await this.ledger.release(
              row.account_id,
              collateralAsset,
              toRelease,
              'FUTURES_MARGIN_RELEASE',
              `FUTURES-UNLOCK-${row.id}`,
              `Reject resting order: margin deficit`,
              undefined,
              tx
            );
          }
          await tx.query("UPDATE orders SET status = 'REJECTED', updated_at = NOW() WHERE id = $1", [row.id]);
          return;
        }

        if (existingPosition) {
          if (existingPosition.leverage !== leverage || existingPosition.marginMode !== marginMode) {
            // Position mismatch: release locked margin and reject
            if (decimalCompare(lockedAmount, '0') > 0) {
              await this.ledger.release(
                row.account_id,
                collateralAsset,
                lockedAmount,
                'FUTURES_MARGIN_RELEASE',
                `FUTURES-UNLOCK-${row.id}`,
                `Reject resting order: leverage/marginMode mismatch`,
                undefined,
                tx
              );
            }
            await tx.query("UPDATE orders SET status = 'REJECTED', updated_at = NOW() WHERE id = $1", [row.id]);
            return;
          }
        }
      }

      // 5. Canonical Execution (LIMIT order fills at limit price)
      const execPrice = cleanPrice;

      if (isOpening) {
        if (existingPosition) {
          resultingPosition = await this.positions.increasePosition(
            existingPosition,
            execQty,
            execPrice,
            contract.maintenanceMarginRate,
            undefined,
            tx
          );
        } else {
          resultingPosition = await this.positions.createPosition({
            accountId: row.account_id,
            symbol: cleanSymbol,
            side: positionSide,
            quantity: execQty,
            entryPrice: execPrice,
            leverage,
            marginMode,
            maintenanceMarginRate: contract.maintenanceMarginRate,
            collateralAsset,
          }, tx);
        }
      } else if (isClosing && existingPosition) {
        const reduceRes = await this.positions.reducePosition(
          existingPosition,
          execQty,
          execPrice,
          contract.maintenanceMarginRate,
          undefined,
          tx
        );
        resultingPosition = reduceRes.updatedPosition;

        const pnlRef = `FUTURES-PNL-${row.id}`;
        const entries: any[] = [];

        if (decimalCompare(reduceRes.freedMargin, '0') > 0) {
          const collateralForReduce = existingPosition.collateralAsset || 'FUTURES_USDT';
          entries.push(
            { accountId: row.account_id, asset: collateralForReduce, direction: 'DEBIT', amount: reduceRes.freedMargin, balancePool: 'locked' },
            { accountId: row.account_id, asset: collateralForReduce, direction: 'CREDIT', amount: reduceRes.freedMargin, balancePool: 'available' }
          );
        }

        if (decimalCompare(reduceRes.realizedPnl, '0') > 0) {
          entries.push({ accountId: row.account_id, asset: existingPosition.collateralAsset || 'FUTURES_USDT', direction: 'CREDIT', amount: reduceRes.realizedPnl, balancePool: 'available' });
          entries.push({ accountId: INSURANCE_FUND_ACCOUNT_ID, asset: existingPosition.collateralAsset || 'FUTURES_USDT', direction: 'DEBIT', amount: reduceRes.realizedPnl, balancePool: 'available' });
        } else if (decimalCompare(reduceRes.realizedPnl, '0') < 0) {
          const loss = decimalSubtract('0', reduceRes.realizedPnl);
          const bal = await this.ledger.getBalance(row.account_id, existingPosition.collateralAsset || 'FUTURES_USDT', tx);
          const tempAvailable = decimalAdd(bal.availableBalance, reduceRes.freedMargin);
          const debitLoss = decimalCompare(tempAvailable, loss) >= 0 ? loss : tempAvailable;
          if (decimalCompare(debitLoss, '0') > 0) {
            entries.push({ accountId: row.account_id, asset: existingPosition.collateralAsset || 'FUTURES_USDT', direction: 'DEBIT', amount: debitLoss, balancePool: 'available' });
            entries.push({ accountId: INSURANCE_FUND_ACCOUNT_ID, asset: existingPosition.collateralAsset || 'FUTURES_USDT', direction: 'CREDIT', amount: debitLoss, balancePool: 'available' });
          }
        }

        if (entries.length > 0) {
          await this.ledger.postTransaction({
            accountId: row.account_id,
            transactionType: 'FUTURES_PNL_REALIZED',
            referenceId: pnlRef,
            description: `Futures Position Reduction: ${cleanSymbol} ${positionSide} ${execQty} @ ${execPrice}`,
            entries
          }, tx);
        }
      }

      // Calculate and debit maker trading fee for resting limit order
      const feeResult = this.feeSvc.calculateExecutionFee(execQty, execPrice, true);
      const tradeId = crypto.randomUUID();

      if (decimalCompare(feeResult.feeAmount, '0') > 0) {
        const feeAssetForDebit = existingPosition?.collateralAsset || collateralAsset || 'FUTURES_USDT';
        const bal = await this.ledger.getBalance(row.account_id, feeAssetForDebit, tx);
        const feeDebit = decimalCompare(bal.availableBalance, feeResult.feeAmount) >= 0 ? feeResult.feeAmount : bal.availableBalance;
        if (decimalCompare(feeDebit, '0') > 0) {
          await this.ledger.postTransaction({
            accountId: row.account_id,
            transactionType: 'TRADING_FEE' as any,
            referenceId: `FUTURES-FEE-${tradeId}`,
            description: `Futures Trading Fee (${feeResult.feeType}): ${cleanSymbol} order ${row.id}`,
            entries: [
              { accountId: row.account_id, asset: feeAssetForDebit, direction: 'DEBIT', amount: feeDebit, balancePool: 'available' },
              { accountId: '11111111-1111-1111-1111-111111111111', asset: feeAssetForDebit, direction: 'CREDIT', amount: feeDebit, balancePool: 'available' }
            ]
          }, tx);
        }
      }

      // Create trade execution record
      executedTrade = {
        id: tradeId,
        orderId: row.id,
        accountId: row.account_id,
        market: 'FUTURES',
        symbol: cleanSymbol,
        side: row.side,
        price: execPrice,
        quantity: execQty,
        quoteQuantity: decimalMultiply(execQty, execPrice),
        fee: feeResult.feeAmount,
        feeAsset: existingPosition?.collateralAsset || collateralAsset || 'FUTURES_USDT',
        isMaker: true,
        createdAt: new Date(),
      };

      await tx.query(
        `INSERT INTO trades (
          id, order_id, account_id, market, symbol, side, price, quantity, quote_quantity,
          fee, fee_asset, is_maker, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          executedTrade.id,
          executedTrade.orderId,
          executedTrade.accountId,
          executedTrade.market,
          executedTrade.symbol,
          executedTrade.side,
          executedTrade.price,
          executedTrade.quantity,
          executedTrade.quoteQuantity,
          executedTrade.fee,
          executedTrade.feeAsset,
          executedTrade.isMaker,
          executedTrade.createdAt,
        ]
      );

      // Compute new filled and remaining quantities
      const prevFilled = row.filled_quantity || row.filledQuantity || '0';
      const updatedFilled = decimalAdd(prevFilled, execQty);
      const updatedRemaining = decimalSubtract(totalQty, updatedFilled);
      const newStatus: OrderStatus = decimalCompare(updatedRemaining, '0') <= 0 ? 'FILLED' : 'PARTIALLY_FILLED';

      // Update order in database
      await tx.query(
        'UPDATE orders SET status = $1, filled_quantity = $2, remaining_quantity = $3, updated_at = NOW() WHERE id = $4',
        [newStatus, updatedFilled, decimalCompare(updatedRemaining, '0') <= 0 ? '0' : updatedRemaining, row.id]
      );

      resultingOrder = {
        id: row.id,
        clientOrderId: row.client_order_id,
        accountId: row.account_id,
        market: 'FUTURES',
        symbol: cleanSymbol,
        side: row.side,
        type: row.type,
        price: cleanPrice,
        stopPrice: row.stop_price,
        quantity: totalQty,
        filledQuantity: updatedFilled,
        remainingQuantity: decimalCompare(updatedRemaining, '0') <= 0 ? '0' : updatedRemaining,
        lockedAmount,
        lockedAsset: collateralAsset,
        status: newStatus,
        timeInForce: row.time_in_force || 'GTC',
        createdAt: new Date(row.created_at),
        updatedAt: new Date(),
      };

      resultingFuturesOrder = {
        id: row.fo_id,
        orderId: row.id,
        accountId: row.account_id,
        symbol: cleanSymbol,
        positionSide,
        leverage,
        marginMode,
        reduceOnly: isReduceOnly,
        closePosition: Boolean(row.close_position || row.closePosition),
        createdAt: new Date(row.created_at),
      };
    });

    if (!resultingOrder || !resultingFuturesOrder || !executedTrade) {
      return null;
    }

    // ── Emit Domain Events strictly after successful commit ──────────────
    try {
      if (accountUserId) {
        eventBus.publish({
          id: crypto.randomUUID(),
          type: 'futures.order.updated',
          channel: 'user:orders',
          userId: accountUserId,
          symbol: resultingOrder.symbol,
          timestamp: Date.now(),
          version: '1.0.0',
          payload: {
            orderId: resultingOrder.id,
            clientOrderId: resultingOrder.clientOrderId,
            accountId: resultingOrder.accountId,
            symbol: resultingOrder.symbol,
            side: resultingOrder.side,
            positionSide: resultingFuturesOrder.positionSide,
            type: resultingOrder.type,
            status: resultingOrder.status,
            price: resultingOrder.price,
            quantity: resultingOrder.quantity,
            filledQuantity: resultingOrder.filledQuantity,
            remainingQuantity: resultingOrder.remainingQuantity,
            timestamp: Date.now(),
          },
        });
      }

      eventBus.publish({
        id: crypto.randomUUID(),
        type: 'futures.trade.executed',
        channel: 'trades',
        symbol: executedTrade.symbol,
        timestamp: executedTrade.createdAt.getTime(),
        version: '1.0.0',
        payload: {
          tradeId: executedTrade.id,
          orderId: executedTrade.orderId,
          accountId: executedTrade.accountId,
          symbol: executedTrade.symbol,
          side: executedTrade.side,
          price: executedTrade.price,
          quantity: executedTrade.quantity,
          quoteQuantity: executedTrade.quoteQuantity,
          fee: executedTrade.fee,
          feeAsset: executedTrade.feeAsset,
          isMaker: executedTrade.isMaker,
          timestamp: executedTrade.createdAt.getTime(),
        },
      });

      if (resultingPosition && accountUserId) {
        eventBus.publish({
          id: crypto.randomUUID(),
          type: 'futures.position.updated',
          channel: 'user:positions',
          userId: accountUserId,
          symbol: resultingPosition.symbol,
          timestamp: Date.now(),
          version: '1.0.0',
          payload: {
            positionId: resultingPosition.id,
            accountId: resultingPosition.accountId,
            symbol: resultingPosition.symbol,
            side: resultingPosition.side,
            quantity: resultingPosition.quantity,
            entryPrice: resultingPosition.entryPrice,
            markPrice: resultingPosition.markPrice,
            liquidationPrice: resultingPosition.liquidationPrice,
            leverage: resultingPosition.leverage,
            marginMode: resultingPosition.marginMode,
            initialMargin: resultingPosition.initialMargin,
            maintenanceMargin: resultingPosition.maintenanceMargin,
            realizedPnl: resultingPosition.realizedPnl,
            status: resultingPosition.status,
            timestamp: Date.now(),
          },
        });
      }
    } catch (evtErr: any) {
      logger.warn('Failed to emit futures events for resting order', { error: evtErr.message });
    }

    return {
      order: resultingOrder,
      futuresOrder: resultingFuturesOrder,
      position: resultingPosition,
      trade: executedTrade,
    };
  }


  /**
   * Get single position for authenticated user.
   */
  public async getPosition(userId: string, positionId: string): Promise<FuturesPositionEntity> {
    const pos = await this.positions.getPositionById(positionId);
    if (!pos) {
      throw new PositionNotFoundError(positionId);
    }

    const accRes = await this.database.query<any>('SELECT id, user_id AS "userId" FROM accounts WHERE id = $1', [
      pos.accountId,
    ]);
    const acc = accRes.rows[0];
    if (!acc || (acc.userId || acc.user_id) !== userId) {
      throw new AccountOwnershipDeniedError(pos.accountId);
    }

    return pos;
  }

  /**
   * Get all positions for authenticated user's FUTURES account.
   */
  public async getPositions(userId: string): Promise<FuturesPositionEntity[]> {
    const accRes = await this.database.query<any>(
      "SELECT id FROM accounts WHERE user_id = $1 AND type = 'FUTURES'",
      [userId]
    );
    const futuresAcc = accRes.rows[0];
    if (!futuresAcc) return [];

    return this.positions.getOpenPositions(futuresAcc.id);
  }

  /**
   * Get open orders for authenticated user.
   */
  public async getOpenOrders(userId: string, symbol?: string): Promise<OrderEntity[]> {
    const accRes = await this.database.query<any>(
      "SELECT id FROM accounts WHERE user_id = $1 AND type = 'FUTURES'",
      [userId]
    );
    const futuresAcc = accRes.rows[0];
    if (!futuresAcc) return [];

    const ordersRes = await this.database.query<any>(
      "SELECT * FROM orders WHERE account_id = $1 AND market = 'FUTURES' AND status IN ('NEW', 'PARTIALLY_FILLED')",
      [futuresAcc.id]
    );

    let orders: OrderEntity[] = ordersRes.rows.map(r => ({
      id: r.id,
      clientOrderId: r.clientOrderId || r.client_order_id,
      accountId: r.accountId || r.account_id,
      market: 'FUTURES',
      symbol: r.symbol,
      side: r.side,
      type: r.type,
        price: r.price,
        stopPrice: r.stopPrice || r.stop_price,
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
   * Get single order by ID.
   */
  public async getOrder(userId: string, orderId: string): Promise<OrderEntity> {
    const orderRes = await this.database.query<any>('SELECT * FROM orders WHERE id = $1', [orderId]);
    const orderRow = orderRes.rows[0];
    if (!orderRow) {
      throw new FuturesError(`Order "${orderId}" not found`, 404, FuturesErrorCode.ORDER_NOT_FOUND);
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
      market: 'FUTURES',
      symbol: orderRow.symbol,
      side: orderRow.side,
      type: orderRow.type,
        price: orderRow.price,
        stopPrice: orderRow.stopPrice || orderRow.stop_price,
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
   * Get paginated futures order history for authenticated user.
   */
  public async getOrderHistory(userId: string, options: GetFuturesOrdersOptions = {}): Promise<OrderEntity[]> {
    const accRes = await this.database.query<any>(
      "SELECT id FROM accounts WHERE user_id = $1 AND type = 'FUTURES'",
      [userId]
    );
    const futuresAcc = accRes.rows[0];
    if (!futuresAcc) return [];

    const page = options.page || 1;
    const pageSize = options.pageSize || 50;
    const offset = (page - 1) * pageSize;

    let sql = "SELECT * FROM orders WHERE account_id = $1 AND market = 'FUTURES'";
    const params: any[] = [futuresAcc.id];
    let paramIndex = 2;

    if (options.symbol) {
      sql += ` AND symbol = $${paramIndex++}`;
      params.push(options.symbol.toUpperCase());
    }
    if (options.status) {
      sql += ` AND status = $${paramIndex++}`;
      params.push(options.status);
    }
    if (options.side) {
      sql += ` AND side = $${paramIndex++}`;
      params.push(options.side);
    }

    sql += ' ORDER BY created_at DESC';
    sql += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(pageSize, offset);

    const ordersRes = await this.database.query<any>(sql, params);

    return ordersRes.rows.map(r => ({
      id: r.id,
      clientOrderId: r.clientOrderId || r.client_order_id,
      accountId: r.accountId || r.account_id,
      market: 'FUTURES',
      symbol: r.symbol,
      side: r.side,
      type: r.type,
        price: r.price,
        stopPrice: r.stopPrice || r.stop_price,
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
   * Get paginated futures trade history for authenticated user.
   */
  public async getTradeHistory(userId: string, options: GetFuturesTradesOptions = {}): Promise<TradeEntity[]> {
    const accRes = await this.database.query<any>(
      "SELECT id FROM accounts WHERE user_id = $1 AND type = 'FUTURES'",
      [userId]
    );
    const futuresAcc = accRes.rows[0];
    if (!futuresAcc) return [];

    const page = options.page || 1;
    const pageSize = options.pageSize || 50;
    const offset = (page - 1) * pageSize;

    let tradeSql = "SELECT * FROM trades WHERE account_id = $1 AND market = 'FUTURES'";
    const tradeParams: any[] = [futuresAcc.id];
    let tradeParamIndex = 2;

    if (options.symbol) {
      tradeSql += ` AND symbol = $${tradeParamIndex++}`;
      tradeParams.push(options.symbol.toUpperCase());
    }

    tradeSql += ' ORDER BY created_at DESC';
    tradeSql += ` LIMIT $${tradeParamIndex++} OFFSET $${tradeParamIndex++}`;
    tradeParams.push(pageSize, offset);

    const tradesRes = await this.database.query<any>(tradeSql, tradeParams);

    return tradesRes.rows.map(r => ({
      id: r.id,
      orderId: r.orderId || r.order_id,
      accountId: r.accountId || r.account_id,
      market: 'FUTURES',
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
   * State recovery on server restart: loads all open futures positions.
   */
  public async recoverFuturesState(): Promise<{ openPositionsCount: number; openOrdersCount: number }> {
    const posRes = await this.database.query<any>("SELECT * FROM futures_positions WHERE status = 'OPEN'");
    const ordRes = await this.database.query<any>(
      "SELECT * FROM orders WHERE market = 'FUTURES' AND status IN ('NEW', 'PARTIALLY_FILLED')"
    );

    logger.info('Futures state recovered from database', {
      openPositionsCount: posRes.rowCount,
      openOrdersCount: ordRes.rowCount,
    });

    return {
      openPositionsCount: posRes.rowCount,
      openOrdersCount: ordRes.rowCount,
    };
  }
}

export const futuresService = new FuturesService();
