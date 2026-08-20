import { FuturesPositionEntity } from '../../models/futures.model';
import {
  decimalMultiply,
  decimalCompare,
  decimalSubtract,
  decimalNormalize,
} from '../ledger/decimal';
import { db } from '../../config/database';
import { ledgerService } from '../ledger/ledger.service';
import { logger } from '../../config/logger';
import crypto from 'crypto';

export class FuturesFundingService {
  private fundingRate = '0.0001'; // 0.0100% per funding period

  public getFundingRate(): string {
    return this.fundingRate;
  }

  public setFundingRate(rate: string): void {
    this.fundingRate = decimalNormalize(rate);
  }

  /**
   * Calculate estimated funding payment for an open position:
   * LONG pays if fundingRate > 0, receives if fundingRate < 0.
   * SHORT receives if fundingRate > 0, pays if fundingRate < 0.
   */
  public calculateEstimatedFunding(position: FuturesPositionEntity, markPrice: string): string {
    const notional = decimalMultiply(position.quantity, markPrice);
    const amount = decimalMultiply(notional, this.fundingRate);

    if (position.side === 'LONG') {
      // Long pays positive rate
      return decimalCompare(this.fundingRate, '0') > 0 ? decimalSubtract('0', amount) : amount;
    } else {
      // Short receives positive rate
      return amount;
    }
  }

  /**
   * Settles funding across all open futures positions for a symbol.
   */
  public async settleFundingInterval(symbol: string, markPrice: string, indexPrice?: string): Promise<{ settledPositions: number }> {
    const epoch = Math.floor(Date.now() / (1000 * 60 * 60 * 8)); // 8-hour epoch for uniqueness

    const positionsRes = await db.query<any>(
      `SELECT * FROM futures_positions WHERE symbol = $1 AND status = 'OPEN'`,
      [symbol]
    );

    let settledCount = 0;

    for (const row of positionsRes.rows) {
      const position: FuturesPositionEntity = {
        id: row.id,
        accountId: row.account_id || row.accountId,
        symbol: row.symbol,
        side: row.side,
        quantity: row.quantity,
        entryPrice: row.entry_price || row.entryPrice,
        markPrice: row.mark_price || row.markPrice,
        liquidationPrice: row.liquidation_price || row.liquidationPrice,
        leverage: row.leverage,
        marginMode: row.margin_mode || row.marginMode,
        initialMargin: row.initial_margin || row.initialMargin,
        maintenanceMargin: row.maintenance_margin || row.maintenanceMargin,
        realizedPnl: row.realized_pnl || row.realizedPnl,
        status: row.status,
        createdAt: new Date(row.created_at || row.createdAt),
        updatedAt: new Date(row.updated_at || row.updatedAt)
      };

      const payment = this.calculateEstimatedFunding(position, markPrice);
      
      if (decimalCompare(payment, '0') === 0) continue;

      const isCredit = decimalCompare(payment, '0') > 0;
      const absoluteAmount = isCredit ? payment : decimalSubtract('0', payment);

      const referenceId = `FUNDING-${symbol}-${epoch}-${position.id}`;
      
      try {
        await ledgerService.postTransaction({
          accountId: position.accountId,
          transactionType: 'FUTURES_FUNDING_PAYMENT',
          referenceId,
          description: `Funding payment for ${position.side} ${symbol}`,
          entries: [
            {
              accountId: position.accountId,
              asset: 'FUTURES_USDT',
              direction: isCredit ? 'CREDIT' : 'DEBIT',
              amount: absoluteAmount
            }
          ]
        });
        settledCount++;
      } catch (err: any) {
        if (err.message && (err.message.includes('violate') || err.message.includes('duplicate') || err.message.includes('already exists'))) {
          logger.debug('Funding already settled for position', { positionId: position.id, referenceId });
        } else {
          logger.error('Failed to settle funding for position', { positionId: position.id, error: err });
          // Note: we continue to attempt to settle others instead of throwing entirely
        }
      }
    }

    try {
      await db.query(
        `INSERT INTO futures_funding_history (id, symbol, funding_rate, mark_price, index_price, settled_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
         [crypto.randomUUID(), symbol, this.fundingRate, markPrice, indexPrice || markPrice]
      );
    } catch (err) {
      logger.error('Failed to record funding history', { symbol, error: err });
    }

    return { settledPositions: settledCount };
  }
}

export const futuresFundingService = new FuturesFundingService();
