import crypto from 'crypto';
import { db, IDatabaseConnection } from '../../config/database';
import {
  FuturesPositionEntity,
  PositionSide,
  PositionStatus,
  MarginMode,
} from '../../models/futures.model';
import { futuresRiskService, FuturesRiskService } from './risk.service';
import {
  decimalAdd,
  decimalSubtract,
  decimalMultiply,
  decimalDivide,
  decimalCompare,
  decimalNormalize,
  decimalZero,
  decimalMin,
} from '../ledger/decimal';
import { PositionNotFoundError, NoPositionToCloseError } from './errors';

export interface CreatePositionParams {
  accountId: string;
  symbol: string;
  side: PositionSide;
  quantity: string;
  entryPrice: string;
  leverage: number;
  marginMode: MarginMode;
  maintenanceMarginRate: string;
  availableMargin?: string;
}

export interface ReducePositionResult {
  updatedPosition: FuturesPositionEntity;
  realizedPnl: string;
  freedMargin: string;
}

export interface LiquidationResult {
  liquidatedPosition: FuturesPositionEntity;
  realizedPnl: string;
  fee: string;
  totalReturn: string;
  deficit: string;
}

export class FuturesPositionService {
  constructor(
    private database: IDatabaseConnection = db,
    private risk: FuturesRiskService = futuresRiskService
  ) {}

  /**
   * Get an active OPEN position for an account, symbol, and side.
   */
  public async getOpenPosition(
    accountId: string,
    symbol: string,
    side: PositionSide
  ): Promise<FuturesPositionEntity | null> {
    const cleanSymbol = symbol.trim().toUpperCase();
    const res = await this.database.query<any>(
      "SELECT * FROM futures_positions WHERE account_id = $1 AND symbol = $2 AND side = $3 AND status = 'OPEN'",
      [accountId, cleanSymbol, side]
    );

    const row = res.rows[0];
    if (!row) return null;
    return this.mapPosition(row);
  }

  /**
   * Get all active OPEN positions for an account.
   */
  public async getOpenPositions(accountId: string): Promise<FuturesPositionEntity[]> {
    const res = await this.database.query<any>(
      "SELECT * FROM futures_positions WHERE account_id = $1 AND status = 'OPEN'",
      [accountId]
    );
    return res.rows.map(r => this.mapPosition(r));
  }

  /**
   * Get position by ID.
   */
  public async getPositionById(positionId: string): Promise<FuturesPositionEntity | null> {
    const res = await this.database.query<any>(
      'SELECT * FROM futures_positions WHERE id = $1',
      [positionId]
    );
    const row = res.rows[0];
    if (!row) return null;
    return this.mapPosition(row);
  }

  /**
   * Create a new OPEN position in the database.
   */
  public async createPosition(params: CreatePositionParams): Promise<FuturesPositionEntity> {
    const {
      accountId,
      symbol,
      side,
      quantity,
      entryPrice,
      leverage,
      marginMode,
      maintenanceMarginRate,
      availableMargin = '0',
    } = params;

    const cleanSymbol = symbol.trim().toUpperCase();
    const cleanQty = decimalNormalize(quantity);
    const cleanEntryPrice = decimalNormalize(entryPrice);

    const initialMargin = this.risk.calculateInitialMargin(cleanQty, cleanEntryPrice, leverage);
    const maintenanceMargin = this.risk.calculateMaintenanceMargin(cleanQty, cleanEntryPrice, maintenanceMarginRate);

    const mockPos: Pick<FuturesPositionEntity, 'marginMode' | 'side' | 'entryPrice' | 'quantity' | 'initialMargin' | 'maintenanceMargin'> = {
      marginMode,
      side,
      entryPrice: cleanEntryPrice,
      quantity: cleanQty,
      initialMargin,
      maintenanceMargin,
    };

    const liquidationPrice = this.risk.calculateLiquidationPrice(mockPos, maintenanceMarginRate, availableMargin);

    const positionId = crypto.randomUUID();
    const position: FuturesPositionEntity = {
      id: positionId,
      accountId,
      symbol: cleanSymbol,
      side,
      quantity: cleanQty,
      entryPrice: cleanEntryPrice,
      markPrice: cleanEntryPrice,
      liquidationPrice,
      leverage,
      marginMode,
      initialMargin,
      maintenanceMargin,
      realizedPnl: decimalZero(),
      status: 'OPEN',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.database.query(
      `INSERT INTO futures_positions (
        id, account_id, symbol, side, quantity, entry_price, mark_price, liquidation_price,
        leverage, margin_mode, initial_margin, maintenance_margin, realized_pnl, status,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        position.id,
        position.accountId,
        position.symbol,
        position.side,
        position.quantity,
        position.entryPrice,
        position.markPrice,
        position.liquidationPrice,
        position.leverage,
        position.marginMode,
        position.initialMargin,
        position.maintenanceMargin,
        position.realizedPnl,
        position.status,
        position.createdAt,
        position.updatedAt,
      ]
    );

    return position;
  }

  /**
   * Increase an existing OPEN position with weighted average entry price.
   */
  public async increasePosition(
    position: FuturesPositionEntity,
    addQuantity: string,
    addPrice: string,
    maintenanceMarginRate: string,
    availableMargin = '0'
  ): Promise<FuturesPositionEntity> {
    const qAdd = decimalNormalize(addQuantity);
    const pAdd = decimalNormalize(addPrice);

    if (decimalCompare(qAdd, '0') <= 0) {
      return position;
    }

    const currentQty = position.quantity;
    const currentPrice = position.entryPrice;

    // 1. Calculate new total quantity
    const newQty = decimalAdd(currentQty, qAdd);

    // 2. Calculate weighted average entry price: ((currentQty * currentPrice) + (addQty * addPrice)) / newQty
    const currentNotional = decimalMultiply(currentQty, currentPrice);
    const addNotional = decimalMultiply(qAdd, pAdd);
    const totalNotional = decimalAdd(currentNotional, addNotional);
    const newEntryPrice = decimalDivide(totalNotional, newQty);

    // 3. Calculate new margins
    const addedRequiredMargin = this.risk.calculateInitialMargin(qAdd, pAdd, position.leverage);
    const newInitialMargin = decimalAdd(position.initialMargin, addedRequiredMargin);
    const newMaintenanceMargin = this.risk.calculateMaintenanceMargin(newQty, newEntryPrice, maintenanceMarginRate);

    // 4. Calculate new liquidation price
    const mockPos: Pick<FuturesPositionEntity, 'marginMode' | 'side' | 'entryPrice' | 'quantity' | 'initialMargin' | 'maintenanceMargin'> = {
      marginMode: position.marginMode,
      side: position.side,
      entryPrice: newEntryPrice,
      quantity: newQty,
      initialMargin: newInitialMargin,
      maintenanceMargin: newMaintenanceMargin,
    };
    const newLiquidationPrice = this.risk.calculateLiquidationPrice(mockPos, maintenanceMarginRate, availableMargin);

    // 5. Update position entity
    position.quantity = newQty;
    position.entryPrice = newEntryPrice;
    position.markPrice = pAdd;
    position.initialMargin = newInitialMargin;
    position.maintenanceMargin = newMaintenanceMargin;
    position.liquidationPrice = newLiquidationPrice;
    position.updatedAt = new Date();

    await this.database.query(
      `UPDATE futures_positions SET
        quantity = $1, entry_price = $2, mark_price = $3, liquidation_price = $4,
        initial_margin = $5, maintenance_margin = $6, updated_at = NOW()
      WHERE id = $7`,
      [
        position.quantity,
        position.entryPrice,
        position.markPrice,
        position.liquidationPrice,
        position.initialMargin,
        position.maintenanceMargin,
        position.id,
      ]
    );

    return position;
  }

  /**
   * Reduce an existing OPEN position and compute realized PnL.
   */
  public async reducePosition(
    position: FuturesPositionEntity,
    reduceQuantity: string,
    reducePrice: string,
    maintenanceMarginRate: string,
    availableMargin = '0'
  ): Promise<ReducePositionResult> {
    const qReduce = decimalNormalize(reduceQuantity);
    const pReduce = decimalNormalize(reducePrice);
    const currentQty = position.quantity;

    if (decimalCompare(qReduce, '0') <= 0 || decimalCompare(currentQty, '0') <= 0) {
      return { updatedPosition: position, realizedPnl: decimalZero(), freedMargin: decimalZero() };
    }

    const actualReduceQty = decimalCompare(qReduce, currentQty) >= 0 ? currentQty : qReduce;

    // 1. Calculate realized PnL for the reduced portion
    const realizedPnlDelta = this.risk.calculateRealizedPnl(
      position.side,
      actualReduceQty,
      position.entryPrice,
      pReduce
    );

    // 2. Calculate remaining quantity
    const newQty = decimalSubtract(currentQty, actualReduceQty);
    let status: PositionStatus = 'OPEN';
    let newInitialMargin = decimalZero();
    let newMaintenanceMargin = decimalZero();
    let newLiquidationPrice = decimalZero();

    if (decimalCompare(newQty, '0') > 0) {
      // Proportionally reduce initial margin
      const ratio = decimalDivide(newQty, currentQty);
      newInitialMargin = decimalMultiply(position.initialMargin, ratio);
      newMaintenanceMargin = this.risk.calculateMaintenanceMargin(newQty, position.entryPrice, maintenanceMarginRate);

      const mockPos: Pick<FuturesPositionEntity, 'marginMode' | 'side' | 'entryPrice' | 'quantity' | 'initialMargin' | 'maintenanceMargin'> = {
        marginMode: position.marginMode,
        side: position.side,
        entryPrice: position.entryPrice,
        quantity: newQty,
        initialMargin: newInitialMargin,
        maintenanceMargin: newMaintenanceMargin,
      };
      newLiquidationPrice = this.risk.calculateLiquidationPrice(mockPos, maintenanceMarginRate, availableMargin);
    } else {
      status = 'CLOSED';
    }

    // 3. Calculate freed margin
    const freedMargin = decimalSubtract(position.initialMargin, newInitialMargin);

    // 4. Update cumulative realized PnL on position
    const currentRealized = position.realizedPnl || decimalZero();
    const newRealizedPnlTotal = decimalAdd(currentRealized, realizedPnlDelta);

    position.quantity = newQty;
    position.markPrice = pReduce;
    position.initialMargin = newInitialMargin;
    position.maintenanceMargin = newMaintenanceMargin;
    position.liquidationPrice = newLiquidationPrice;
    position.realizedPnl = newRealizedPnlTotal;
    position.status = status;
    position.updatedAt = new Date();

    await this.database.query(
      `UPDATE futures_positions SET
        quantity = $1, mark_price = $2, initial_margin = $3, maintenance_margin = $4,
        liquidation_price = $5, realized_pnl = $6, status = $7, updated_at = NOW()
      WHERE id = $8`,
      [
        position.quantity,
        position.markPrice,
        position.initialMargin,
        position.maintenanceMargin,
        position.liquidationPrice,
        position.realizedPnl,
        position.status,
        position.id,
      ]
    );

    return {
      updatedPosition: position,
      realizedPnl: realizedPnlDelta,
      freedMargin,
    };
  }

  /**
   * Liquidate an OPEN position.
   */
  public async liquidatePosition(
    position: FuturesPositionEntity,
    markPrice: string
  ): Promise<LiquidationResult> {
    const cleanMarkPrice = decimalNormalize(markPrice);
    const realizedPnl = this.risk.calculateUnrealizedPnl(
      position.side,
      position.quantity,
      position.entryPrice,
      cleanMarkPrice
    );

    // Liquidation fee = Notional * 0.05%
    const notional = this.risk.calculateNotional(position.quantity, cleanMarkPrice);
    const fee = decimalMultiply(notional, '0.0005');

    // Total return = max(0, Initial Margin + Realized PnL - Fee)
    const equityRaw = decimalSubtract(decimalAdd(position.initialMargin, realizedPnl), fee);
    const totalReturn = decimalCompare(equityRaw, '0') < 0 ? decimalZero() : equityRaw;
    const deficit = decimalCompare(equityRaw, '0') < 0 ? decimalSubtract('0', equityRaw) : decimalZero();

    position.status = 'LIQUIDATED';
    position.markPrice = cleanMarkPrice;
    position.realizedPnl = decimalAdd(position.realizedPnl || decimalZero(), realizedPnl);
    position.initialMargin = decimalZero();
    position.maintenanceMargin = decimalZero();
    position.updatedAt = new Date();

    await this.database.query(
      `UPDATE futures_positions SET
        status = 'LIQUIDATED', mark_price = $1, realized_pnl = $2,
        initial_margin = '0', maintenance_margin = '0', updated_at = NOW()
      WHERE id = $3`,
      [position.markPrice, position.realizedPnl, position.id]
    );

    return {
      liquidatedPosition: position,
      realizedPnl,
      fee,
      totalReturn,
      deficit,
    };
  }

  private mapPosition(r: any): FuturesPositionEntity {
    return {
      id: r.id,
      accountId: r.accountId || r.account_id,
      symbol: r.symbol,
      side: r.side,
      quantity: r.quantity,
      entryPrice: r.entryPrice || r.entry_price,
      markPrice: r.markPrice || r.mark_price,
      liquidationPrice: r.liquidationPrice || r.liquidation_price,
      leverage: Number(r.leverage),
      marginMode: r.marginMode || r.margin_mode,
      initialMargin: r.initialMargin || r.initial_margin,
      maintenanceMargin: r.maintenanceMargin || r.maintenance_margin,
      realizedPnl: r.realizedPnl || r.realized_pnl || decimalZero(),
      status: r.status,
      createdAt: new Date(r.createdAt || r.created_at),
      updatedAt: new Date(r.updatedAt || r.updated_at),
    };
  }
}

export const futuresPositionService = new FuturesPositionService();
