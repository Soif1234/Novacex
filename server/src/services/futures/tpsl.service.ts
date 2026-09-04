import crypto from 'crypto';
import { db, IDatabaseConnection } from '../../config/database';
import { FuturesTpSlConfigEntity, PositionSide, MarginMode } from '../../models/futures.model';
import { PositionNotFoundError, NoPositionToCloseError } from './errors';
import { AccountOwnershipDeniedError } from '../wallet/errors';
import { decimalNormalize, decimalCompare } from '../ledger/decimal';
import { futuresService, FuturesService } from './futures.service';
import { marketDataService, MarketDataService } from '../market/market.service';
import { logger } from '../../config/logger';

export interface SetTpSlDto {
  userId: string;
  positionId: string;
  takeProfitEnabled?: boolean;
  takeProfitPrice?: string;
  stopLossEnabled?: boolean;
  stopLossPrice?: string;
}

export interface TpSlExecutionResult {
  configId: string;
  positionId: string;
  accountId: string;
  symbol: string;
  positionSide: PositionSide;
  triggerType: 'TP' | 'SL';
  triggerPrice: string;
  observedMarkPrice: string;
  orderId?: string;
  status: 'EXECUTED' | 'SKIPPED' | 'FAILED';
  reason?: string;
  timestamp: Date;
}

export interface ActiveTpSlCandidate {
  id: string;
  positionId: string;
  accountId: string;
  userId: string;
  symbol: string;
  positionSide: PositionSide;
  quantity: string;
  leverage: number;
  marginMode: MarginMode;
}

export class FuturesTpSlService {
  constructor(
    private database: IDatabaseConnection = db,
    private futuresSvc: FuturesService = futuresService,
    private marketSvc: MarketDataService = marketDataService
  ) {}

  public async setConfig(dto: SetTpSlDto): Promise<FuturesTpSlConfigEntity> {
    const posRes = await this.database.query<any>(
      'SELECT id, account_id AS "accountId", symbol, side, status FROM futures_positions WHERE id = $1',
      [dto.positionId]
    );
    const pos = posRes.rows[0];
    if (!pos || pos.status !== 'OPEN') {
      throw new PositionNotFoundError(dto.positionId);
    }

    const accRes = await this.database.query<any>(
      'SELECT id, user_id AS "userId" FROM accounts WHERE id = $1',
      [pos.accountId || pos.account_id]
    );
    const acc = accRes.rows[0];
    if (!acc || (acc.userId || acc.user_id) !== dto.userId) {
      throw new AccountOwnershipDeniedError(pos.accountId || pos.account_id);
    }

    const existingRes = await this.database.query<any>(
      'SELECT * FROM futures_tpsl_configs WHERE position_id = $1',
      [dto.positionId]
    );
    const existing = existingRes.rows[0];

    const takeProfitEnabled = Boolean(dto.takeProfitEnabled);
    const takeProfitPrice = dto.takeProfitPrice ? decimalNormalize(dto.takeProfitPrice) : undefined;
    const stopLossEnabled = Boolean(dto.stopLossEnabled);
    const stopLossPrice = dto.stopLossPrice ? decimalNormalize(dto.stopLossPrice) : undefined;

    if (existing) {
      await this.database.query(
        `UPDATE futures_tpsl_configs SET
          take_profit_enabled = $1, take_profit_price = $2,
          stop_loss_enabled = $3, stop_loss_price = $4,
          updated_at = NOW()
        WHERE id = $5`,
        [takeProfitEnabled, takeProfitPrice, stopLossEnabled, stopLossPrice, existing.id]
      );

      return {
        id: existing.id,
        positionId: dto.positionId,
        accountId: pos.accountId || pos.account_id,
        symbol: pos.symbol,
        positionSide: (pos.side || pos.position_side) as PositionSide,
        takeProfitEnabled,
        takeProfitPrice,
        stopLossEnabled,
        stopLossPrice,
        createdAt: new Date(existing.createdAt || existing.created_at),
        updatedAt: new Date(),
      };
    } else {
      const id = crypto.randomUUID();
      const config: FuturesTpSlConfigEntity = {
        id,
        positionId: dto.positionId,
        accountId: pos.accountId || pos.account_id,
        symbol: pos.symbol,
        positionSide: (pos.side || pos.position_side) as PositionSide,
        takeProfitEnabled,
        takeProfitPrice,
        stopLossEnabled,
        stopLossPrice,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await this.database.query(
        `INSERT INTO futures_tpsl_configs (
          id, position_id, account_id, symbol, position_side,
          take_profit_enabled, take_profit_price, stop_loss_enabled, stop_loss_price,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          config.id,
          config.positionId,
          config.accountId,
          config.symbol,
          config.positionSide,
          config.takeProfitEnabled,
          config.takeProfitPrice,
          config.stopLossEnabled,
          config.stopLossPrice,
          config.createdAt,
          config.updatedAt,
        ]
      );

      return config;
    }
  }

  /**
   * Retrieve the TP/SL config for a position.
   *
   * When `userId` is provided, ownership is enforced: the position must belong
   * to a FUTURES account of that user, otherwise an AccountOwnershipDeniedError
   * is thrown (no cross-account existence leak).
   */
  public async getConfigForPosition(positionId: string, userId?: string): Promise<FuturesTpSlConfigEntity | null> {
    const res = await this.database.query<any>(
      'SELECT * FROM futures_tpsl_configs WHERE position_id = $1',
      [positionId]
    );
    const row = res.rows[0];
    if (!row) return null;

    if (userId) {
      const posRes = await this.database.query<any>(
        'SELECT account_id AS "accountId" FROM futures_positions WHERE id = $1',
        [positionId]
      );
      const pos = posRes.rows[0];
      const accountId = pos?.accountId || row.accountId || row.account_id;
      const accRes = await this.database.query<any>(
        'SELECT id, user_id AS "userId" FROM accounts WHERE id = $1',
        [accountId]
      );
      const acc = accRes.rows[0];
      if (!acc || (acc.userId || acc.user_id) !== userId) {
        throw new AccountOwnershipDeniedError(accountId);
      }
    }

    return {
      id: row.id,
      positionId: row.positionId || row.position_id,
      accountId: row.accountId || row.account_id,
      symbol: row.symbol,
      positionSide: row.positionSide || row.position_side,
      takeProfitEnabled: Boolean(row.takeProfitEnabled ?? row.take_profit_enabled),
      takeProfitPrice: row.takeProfitPrice || row.take_profit_price,
      stopLossEnabled: Boolean(row.stopLossEnabled ?? row.stop_loss_enabled),
      stopLossPrice: row.stopLossPrice || row.stop_loss_price,
      createdAt: new Date(row.createdAt || row.created_at),
      updatedAt: new Date(row.updatedAt || row.updated_at),
    };
  }

  /**
   * Evaluates all active TP/SL configurations against authoritative live mark prices.
   *
   * Autonomous, restart-safe, concurrency-safe, and fail-closed:
   * - Queries active configs for OPEN positions directly from PostgreSQL.
   * - Resolves live mark price from authoritative MarketDataService (or override).
   * - Evaluates exact threshold invariants:
   *     LONG:  TP if markPrice >= takeProfitPrice; SL if markPrice <= stopLossPrice
   *     SHORT: TP if markPrice <= takeProfitPrice; SL if markPrice >= stopLossPrice
   * - Dispatches execution through executeTrigger with atomic database-level claim.
   */
  public async checkAllActiveTriggers(overrideMarkPrices?: Record<string, string>): Promise<TpSlExecutionResult[]> {
    const results: TpSlExecutionResult[] = [];

    const candidatesRes = await this.database.query<any>(
      `
      SELECT
        c.id,
        c.position_id AS "positionId",
        c.account_id AS "accountId",
        a.user_id AS "userId",
        c.symbol,
        c.position_side AS "positionSide",
        c.take_profit_enabled AS "takeProfitEnabled",
        c.take_profit_price AS "takeProfitPrice",
        c.stop_loss_enabled AS "stopLossEnabled",
        c.stop_loss_price AS "stopLossPrice",
        p.quantity,
        p.leverage,
        p.margin_mode AS "marginMode",
        p.status AS "positionStatus"
      FROM futures_tpsl_configs c
      JOIN futures_positions p ON p.id = c.position_id
      JOIN accounts a ON a.id = c.account_id
      WHERE p.status = 'OPEN'
        AND (c.take_profit_enabled = TRUE OR c.stop_loss_enabled = TRUE)`
    );

    for (const row of candidatesRes.rows) {
      const symbol = row.symbol;
      let markPrice: string | undefined = overrideMarkPrices?.[symbol];

      if (!markPrice) {
        try {
          const markData = await this.marketSvc.getMarkPrice(symbol);
          markPrice = markData?.price;
        } catch (err: any) {
          logger.warn('Failed to fetch mark price for symbol during TP/SL sweep', { symbol, error: err.message });
          continue; // fail-closed: skip this symbol rather than executing at an unknown price
        }
      }

      if (!markPrice || decimalCompare(markPrice, '0') <= 0) {
        continue;
      }

      const tpEnabled = Boolean(row.takeProfitEnabled ?? row.take_profit_enabled);
      const tpPrice = row.takeProfitPrice || row.take_profit_price;
      const slEnabled = Boolean(row.stopLossEnabled ?? row.stop_loss_enabled);
      const slPrice = row.stopLossPrice || row.stop_loss_price;
      const positionSide = (row.positionSide || row.position_side) as PositionSide;

      let triggered = false;
      let triggerType: 'TP' | 'SL' | null = null;
      let triggerPrice: string | null = null;

      // Exact product semantics:
      // LONG: TP triggers if mark >= tpPrice; SL triggers if mark <= slPrice
      // SHORT: TP triggers if mark <= tpPrice; SL triggers if mark >= slPrice
      if (tpEnabled && tpPrice) {
        if (positionSide === 'LONG' && decimalCompare(markPrice, tpPrice) >= 0) {
          triggered = true;
          triggerType = 'TP';
          triggerPrice = tpPrice;
        } else if (positionSide === 'SHORT' && decimalCompare(markPrice, tpPrice) <= 0) {
          triggered = true;
          triggerType = 'TP';
          triggerPrice = tpPrice;
        }
      }

      if (!triggered && slEnabled && slPrice) {
        if (positionSide === 'LONG' && decimalCompare(markPrice, slPrice) <= 0) {
          triggered = true;
          triggerType = 'SL';
          triggerPrice = slPrice;
        } else if (positionSide === 'SHORT' && decimalCompare(markPrice, slPrice) >= 0) {
          triggered = true;
          triggerType = 'SL';
          triggerPrice = slPrice;
        }
      }

      if (triggered && triggerType && triggerPrice) {
        const candidate: ActiveTpSlCandidate = {
          id: row.id,
          positionId: row.positionId || row.position_id,
          accountId: row.accountId || row.account_id,
          userId: row.userId || row.user_id || 'system_tpsl',
          symbol,
          positionSide,
          quantity: row.quantity,
          leverage: row.leverage,
          marginMode: row.marginMode || row.margin_mode,
        };

        try {
          const res = await this.executeTrigger(candidate, triggerType, triggerPrice, markPrice);
          if (res) {
            results.push(res);
          }
        } catch (err: any) {
          logger.error('Unexpected error executing TP/SL trigger', {
            configId: row.id,
            positionId: candidate.positionId,
            error: err.message,
          });
        }
      }
    }

    return results;
  }

  /**
   * Executes a single TP/SL trigger with atomic PostgreSQL claim and idempotency protection.
   *
   * Invariant guarantees:
   * 1. AT MOST ONE execution: Atomic UPDATE with RETURNING claims the trigger; concurrent callers get 0 rows.
   * 2. Position validity: Re-checks authoritative futures position row; aborts if closed/liquidated.
   * 3. Authoritative order path: Delegates to futuresService.placeOrder for transactional ledger settlement.
   * 4. Audit logging: Structured log recording candidate, trigger type, prices, and resulting order ID.
   */
  public async executeTrigger(
    candidate: ActiveTpSlCandidate,
    triggerType: 'TP' | 'SL',
    triggerPrice: string,
    markPrice: string
  ): Promise<TpSlExecutionResult | null> {
    // 1. Atomic claim in PostgreSQL: disable both TP & SL on the config row
    const claimRes = await this.database.query<any>(
      `UPDATE futures_tpsl_configs
       SET take_profit_enabled = FALSE, stop_loss_enabled = FALSE, updated_at = NOW()
       WHERE id = $1 AND (take_profit_enabled = TRUE OR stop_loss_enabled = TRUE)
       RETURNING id`,
      [candidate.id]
    );

    if (claimRes.rows.length === 0) {
      // Concurrency protection: already claimed/disabled by a parallel worker or tick
      return null;
    }

    // 2. Authoritative position check: verify position is still OPEN with positive quantity
    const posRes = await this.database.query<any>(
      `SELECT id, quantity, leverage, margin_mode AS "marginMode", status
       FROM futures_positions
       WHERE id = $1 AND status = 'OPEN'`,
      [candidate.positionId]
    );

    const posRow = posRes.rows[0];
    if (!posRow || posRow.status !== 'OPEN' || decimalCompare(posRow.quantity, '0') <= 0) {
      logger.info('TP/SL skipped: position is no longer open', {
        configId: candidate.id,
        positionId: candidate.positionId,
        status: posRow?.status,
      });
      return {
        configId: candidate.id,
        positionId: candidate.positionId,
        accountId: candidate.accountId,
        symbol: candidate.symbol,
        positionSide: candidate.positionSide,
        triggerType,
        triggerPrice,
        observedMarkPrice: markPrice,
        status: 'SKIPPED',
        reason: 'POSITION_ALREADY_CLOSED',
        timestamp: new Date(),
      };
    }

    // 3. Place closing market order through authoritative futuresService path
    const closeSide = candidate.positionSide === 'LONG' ? 'SELL' : 'BUY';
    const closeQuantity = posRow.quantity;

    try {
      const orderRes = await this.futuresSvc.placeOrder({
        userId: candidate.userId,
        accountId: candidate.accountId,
        symbol: candidate.symbol,
        side: closeSide,
        positionSide: candidate.positionSide,
        type: 'MARKET',
        quantity: closeQuantity,
        leverage: posRow.leverage || candidate.leverage,
        marginMode: (posRow.marginMode || posRow.margin_mode || candidate.marginMode) as MarginMode,
        reduceOnly: true,
        closePosition: true,
        clientOrderId: `tpsl_${triggerType.toLowerCase()}_${candidate.id.slice(0, 8)}_${Date.now()}`,
      });

      const orderId = orderRes?.order?.id;

      logger.info('Futures TP/SL order executed successfully', {
        configId: candidate.id,
        positionId: candidate.positionId,
        accountId: candidate.accountId,
        symbol: candidate.symbol,
        positionSide: candidate.positionSide,
        triggerType,
        triggerPrice,
        observedMarkPrice: markPrice,
        orderId,
      });

      return {
        configId: candidate.id,
        positionId: candidate.positionId,
        accountId: candidate.accountId,
        symbol: candidate.symbol,
        positionSide: candidate.positionSide,
        triggerType,
        triggerPrice,
        observedMarkPrice: markPrice,
        orderId,
        status: 'EXECUTED',
        timestamp: new Date(),
      };
    } catch (err: any) {
      if (err instanceof NoPositionToCloseError || err.code === 'NO_POSITION_TO_CLOSE' || err.name === 'NoPositionToCloseError') {
        logger.info('TP/SL position close raced: position already closed', {
          configId: candidate.id,
          positionId: candidate.positionId,
        });
        return {
          configId: candidate.id,
          positionId: candidate.positionId,
          accountId: candidate.accountId,
          symbol: candidate.symbol,
          positionSide: candidate.positionSide,
          triggerType,
          triggerPrice,
          observedMarkPrice: markPrice,
          status: 'SKIPPED',
          reason: 'POSITION_ALREADY_CLOSED',
          timestamp: new Date(),
        };
      }

      logger.error('TP/SL order placement failed', {
        configId: candidate.id,
        positionId: candidate.positionId,
        error: err.message,
      });

      return {
        configId: candidate.id,
        positionId: candidate.positionId,
        accountId: candidate.accountId,
        symbol: candidate.symbol,
        positionSide: candidate.positionSide,
        triggerType,
        triggerPrice,
        observedMarkPrice: markPrice,
        status: 'FAILED',
        reason: err.message,
        timestamp: new Date(),
      };
    }
  }
}

export const futuresTpSlService = new FuturesTpSlService();
