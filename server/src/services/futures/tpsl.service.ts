import crypto from 'crypto';
import { db, IDatabaseConnection } from '../../config/database';
import { FuturesTpSlConfigEntity, PositionSide } from '../../models/futures.model';
import { PositionNotFoundError } from './errors';
import { AccountOwnershipDeniedError } from '../wallet/errors';
import { decimalNormalize } from '../ledger/decimal';

export interface SetTpSlDto {
  userId: string;
  positionId: string;
  takeProfitEnabled?: boolean;
  takeProfitPrice?: string;
  stopLossEnabled?: boolean;
  stopLossPrice?: string;
}

export class FuturesTpSlService {
  constructor(private database: IDatabaseConnection = db) {}

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
}

export const futuresTpSlService = new FuturesTpSlService();
