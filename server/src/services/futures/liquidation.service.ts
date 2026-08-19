import crypto from 'crypto';
import { db, IDatabaseConnection } from '../../config/database';
import { FuturesLiquidationEntity, PositionSide } from '../../models/futures.model';
import { futuresRiskService, FuturesRiskService } from './risk.service';
import { futuresPositionService, FuturesPositionService } from './position.service';
import { developmentMarkPriceProvider, IMarkPriceProvider } from './mark-price.provider';
import { LedgerService, ledgerService } from '../ledger/ledger.service';
import {
  PositionNotFoundError,
  PositionAlreadyLiquidatedError,
  LiquidationNotEligibleError,
} from './errors';
import { decimalCompare, decimalNormalize, decimalZero } from '../ledger/decimal';
import { eventBus } from '../market/event-bus';
import { logger } from '../../config/logger';


export class FuturesLiquidationService {
  constructor(
    private database: IDatabaseConnection = db,
    private risk: FuturesRiskService = futuresRiskService,
    private positions: FuturesPositionService = futuresPositionService,
    private ledger: LedgerService = ledgerService,
    private markPrices: IMarkPriceProvider = developmentMarkPriceProvider
  ) {}

  public async evaluateAndLiquidate(
    positionId: string,
    overrideMarkPrice?: string
  ): Promise<FuturesLiquidationEntity> {
    const position = await this.positions.getPositionById(positionId);
    if (!position) {
      throw new PositionNotFoundError(positionId);
    }
    if (position.status !== 'OPEN') {
      throw new PositionAlreadyLiquidatedError(positionId);
    }

    const markPrice = overrideMarkPrice
      ? decimalNormalize(overrideMarkPrice)
      : await this.markPrices.getMarkPrice(position.symbol);

    // Update position mark price in memory for risk calculation
    position.markPrice = markPrice;

    // Check liquidation condition
    const isEligible = this.risk.checkLiquidation(position);
    if (!isEligible) {
      const equity = this.risk.calculatePositionEquity(position);
      throw new LiquidationNotEligibleError(positionId, equity, position.maintenanceMargin);
    }

    // Execute liquidation on position
    const result = await this.positions.liquidatePosition(position, markPrice);

    const liquidationId = crypto.randomUUID();
    const liqRef = `FUTURES-LIQ-${liquidationId}`;

    // Prepare ledger entries for double-entry liquidation settlement
    const entries: Array<{
      accountId: string;
      asset: string;
      amount: string;
      direction: 'CREDIT' | 'DEBIT';
      balancePool?: 'available' | 'locked';
    }> = [];

    if (decimalCompare(result.totalReturn, '0') > 0) {
      entries.push({
        accountId: position.accountId,
        asset: 'FUTURES_USDT',
        amount: result.totalReturn,
        direction: 'CREDIT',
        balancePool: 'available',
      });
    }

    if (position.marginMode === 'CROSS' && decimalCompare(result.deficit, '0') > 0) {
      const bal = await this.ledger.getBalance(position.accountId, 'FUTURES_USDT');
      const deduct = decimalCompare(bal.availableBalance, result.deficit) >= 0 ? result.deficit : bal.availableBalance;
      if (decimalCompare(deduct, '0') > 0) {
        entries.push({
          accountId: position.accountId,
          asset: 'FUTURES_USDT',
          amount: deduct,
          direction: 'DEBIT',
          balancePool: 'available',
        });
      }
    }

    if (entries.length > 0) {
      await this.ledger.postTransaction({
        accountId: position.accountId,
        transactionType: 'FUTURES_LIQUIDATION',
        referenceId: liqRef,
        description: `Futures Liquidation Settlement: ${position.symbol} ${position.side} ${position.quantity} @ ${markPrice}`,
        entries,
        metadata: {
          positionId: position.id,
          symbol: position.symbol,
          side: position.side,
          markPrice,
          realizedPnl: result.realizedPnl,
          fee: result.fee,
          totalReturn: result.totalReturn,
          deficit: result.deficit,
        },
      });
    }

    const liquidation: FuturesLiquidationEntity = {
      id: liquidationId,
      positionId: position.id,
      accountId: position.accountId,
      symbol: position.symbol,
      side: position.side,
      quantity: position.quantity,
      bankruptcyPrice: position.entryPrice,
      liquidationPrice: position.liquidationPrice,
      lossAmount: result.realizedPnl,
      insuranceFundDelta: decimalZero(),
      createdAt: new Date(),
    };

    await this.database.query(
      `INSERT INTO futures_liquidations (
        id, position_id, account_id, symbol, side, quantity,
        bankruptcy_price, liquidation_price, loss_amount, insurance_fund_delta, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        liquidation.id,
        liquidation.positionId,
        liquidation.accountId,
        liquidation.symbol,
        liquidation.side,
        liquidation.quantity,
        liquidation.bankruptcyPrice,
        liquidation.liquidationPrice,
        liquidation.lossAmount,
        liquidation.insuranceFundDelta,
        liquidation.createdAt,
      ]
    );

    // ── Emit Domain Events strictly after successful commit ──────────────
    try {
      const accRes = await this.database.query<any>('SELECT user_id AS "userId" FROM accounts WHERE id = $1', [position.accountId]);
      const acc = accRes.rows[0];
      const userId = acc ? (acc.userId || acc.user_id) : undefined;

      eventBus.publish({
        id: crypto.randomUUID(),
        type: 'futures.liquidated',
        channel: 'user:positions',
        userId,
        symbol: position.symbol,
        timestamp: Date.now(),
        version: '1.0.0',
        payload: {
          liquidationId: liquidation.id,
          positionId: position.id,
          symbol: position.symbol,
          side: position.side,
          quantity: position.quantity,
          markPrice,
          lossAmount: result.realizedPnl,
          fee: result.fee,
          totalReturn: result.totalReturn,
          timestamp: Date.now(),
        },
      });

      eventBus.publish({
        id: crypto.randomUUID(),
        type: 'futures.position.updated',
        channel: 'user:positions',
        userId,
        symbol: position.symbol,
        timestamp: Date.now(),
        version: '1.0.0',
        payload: {
          positionId: position.id,
          symbol: position.symbol,
          side: position.side,
          quantity: position.quantity,
          entryPrice: position.entryPrice,
          markPrice,
          liquidationPrice: position.liquidationPrice,
          leverage: position.leverage,
          marginMode: position.marginMode,
          initialMargin: '0',
          maintenanceMargin: '0',
          realizedPnl: result.realizedPnl,
          status: 'LIQUIDATED',
          timestamp: Date.now(),
        },
      });
    } catch (evtErr: any) {
      logger.warn('Failed to emit liquidation events', { error: evtErr.message });
    }

    logger.warn('Futures position liquidated', {
      positionId: position.id,
      accountId: position.accountId,
      symbol: position.symbol,
      side: position.side,
      markPrice,
      lossAmount: result.realizedPnl,
    });

    return liquidation;
  }


  public async getLiquidations(accountId: string): Promise<FuturesLiquidationEntity[]> {
    const res = await this.database.query<any>(
      'SELECT * FROM futures_liquidations WHERE account_id = $1 ORDER BY created_at DESC',
      [accountId]
    );
    return res.rows.map(r => ({
      id: r.id,
      positionId: r.positionId || r.position_id,
      accountId: r.accountId || r.account_id,
      symbol: r.symbol,
      side: (r.side || r.position_side) as PositionSide,
      quantity: r.quantity,
      bankruptcyPrice: r.bankruptcyPrice || r.bankruptcy_price,
      liquidationPrice: r.liquidationPrice || r.liquidation_price,
      lossAmount: r.lossAmount || r.loss_amount,
      insuranceFundDelta: r.insuranceFundDelta || r.insurance_fund_delta || decimalZero(),
      createdAt: new Date(r.createdAt || r.created_at),
    }));
  }
}

export const futuresLiquidationService = new FuturesLiquidationService();
