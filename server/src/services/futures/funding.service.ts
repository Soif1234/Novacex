import { FuturesPositionEntity } from '../../models/futures.model';
import {
  decimalMultiply,
  decimalCompare,
  decimalSubtract,
  decimalAdd,
  decimalDivide,
  decimalNormalize,
} from '../ledger/decimal';
import { db } from '../../config/database';
import { ledgerService } from '../ledger/ledger.service';
import { logger } from '../../config/logger';
import { marketDataService } from '../market/market.service';
import crypto from 'crypto';

export interface AdaptiveFundingResult {
  fundingRate: string;
  markPrice: string;
  indexPrice: string;
  premium: string;
  premiumIndex: string;
  interestComponent: string;
  rawFundingRate: string;
  timestamp: number;
}

export class FuturesFundingService {
  // Phase 6.3 Configurable Boundaries
  public readonly INTEREST_RATE = '0.0001'; // 0.01% per funding period
  public readonly FUNDING_CAP = '0.0050';   // +0.50% max cap
  public readonly FUNDING_FLOOR = '-0.0050';// -0.50% min floor

  // Backwards compatibility for tests that set static rates
  private staticFundingRate: string | null = null;

  public getFundingRate(): string {
    return this.staticFundingRate || '0.0000';
  }

  public setFundingRate(rate: string): void {
    this.staticFundingRate = decimalNormalize(rate);
  }

  /**
   * Calculates the adaptive funding rate for a specific symbol based on current authoritative prices.
   */
  public async calculateAdaptiveFundingRate(symbol: string): Promise<AdaptiveFundingResult> {
    const markPriceData = await marketDataService.getMarkPrice(symbol);
    const indexPriceValue = await marketDataService.getIndexPrice(symbol);
    const markPriceValue = markPriceData.price;

    // Safety checks against invalid/abnormal prices
    if (!markPriceValue || !indexPriceValue || 
        decimalCompare(markPriceValue, '0') <= 0 || 
        decimalCompare(indexPriceValue, '0') <= 0 ||
        !isFinite(Number(markPriceValue)) || !isFinite(Number(indexPriceValue))) {
      throw new Error(`Invalid prices for funding calculation on ${symbol}: Mark=${markPriceValue}, Index=${indexPriceValue}`);
    }

    // 1. Premium = Mark Price - Index Price
    const premium = decimalSubtract(markPriceValue, indexPriceValue);
    
    // 2. Premium Index = Premium / Index Price
    const premiumIndex = decimalDivide(premium, indexPriceValue);
    
    // 3. Raw Funding Rate = Premium Index + Interest Rate
    const rawFundingRate = decimalAdd(premiumIndex, this.INTEREST_RATE);
    
    // 4. Final Funding Rate = Clamp(Raw Funding Rate, FUNDING_FLOOR, FUNDING_CAP)
    let finalFundingRate = rawFundingRate;
    if (decimalCompare(finalFundingRate, this.FUNDING_CAP) > 0) {
      finalFundingRate = this.FUNDING_CAP;
    } else if (decimalCompare(finalFundingRate, this.FUNDING_FLOOR) < 0) {
      finalFundingRate = this.FUNDING_FLOOR;
    }

    return {
      fundingRate: decimalNormalize(finalFundingRate),
      markPrice: markPriceValue,
      indexPrice: indexPriceValue,
      premium: decimalNormalize(premium),
      premiumIndex: decimalNormalize(premiumIndex),
      interestComponent: this.INTEREST_RATE,
      rawFundingRate: decimalNormalize(rawFundingRate),
      timestamp: Date.now()
    };
  }

  /**
   * Calculate estimated funding payment for an open position:
   * LONG pays if fundingRate > 0, receives if fundingRate < 0.
   * SHORT receives if fundingRate > 0, pays if fundingRate < 0.
   */
  public calculateEstimatedFunding(position: FuturesPositionEntity, markPrice: string, rate: string): string {
    const notional = decimalMultiply(position.quantity, markPrice);
    const amount = decimalMultiply(notional, rate);

    if (position.side === 'LONG') {
      // Long pays positive rate -> represents negative cash flow
      return decimalCompare(rate, '0') > 0 ? decimalSubtract('0', amount) : decimalSubtract('0', amount);
      // Wait: 
      // If amount is positive (rate > 0), Long pays -> return -amount
      // If amount is negative (rate < 0), Long receives -> -amount becomes positive
      // So simply returning decimalSubtract('0', amount) covers both!
    } else {
      // Short receives positive rate -> represents positive cash flow
      return amount; 
      // If amount is positive (rate > 0), short receives -> positive
      // If amount is negative (rate < 0), short pays -> negative
    }
  }

  /**
   * Settles funding across all open futures positions for a symbol using adaptive calculation.
   */
  public async settleFundingInterval(symbol: string, epochTimestamp?: number): Promise<{ settledPositions: number, rateData: AdaptiveFundingResult | null }> {
    // Allows injecting exact epoch for testing deterministic boundaries
    const now = epochTimestamp || Date.now();
    const epoch = Math.floor(now / (1000 * 60 * 60 * 8)); // 8-hour epoch for uniqueness

    let rateData: AdaptiveFundingResult;
    try {
      rateData = await this.calculateAdaptiveFundingRate(symbol);
    } catch (err: any) {
      logger.error('Failed to calculate adaptive funding rate', { symbol, error: err.message });
      return { settledPositions: 0, rateData: null };
    }

    // Override with static test rate if provided
    const appliedRate = this.staticFundingRate !== null ? this.staticFundingRate : rateData.fundingRate;

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

      const payment = this.calculateEstimatedFunding(position, rateData.markPrice, appliedRate);
      
      if (decimalCompare(payment, '0') === 0) continue;

      const isCredit = decimalCompare(payment, '0') > 0;
      const absoluteAmount = isCredit ? payment : decimalSubtract('0', payment);

      const referenceId = `FUNDING-${symbol}-${epoch}-${position.id}`;
      
      try {
        await ledgerService.postTransaction({
          accountId: position.accountId,
          transactionType: 'FUTURES_FUNDING_PAYMENT',
          referenceId,
          description: `Funding payment for ${position.side} ${symbol} at rate ${appliedRate}`,
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
         [crypto.randomUUID(), symbol, appliedRate, rateData.markPrice, rateData.indexPrice]
      );
    } catch (err) {
      logger.error('Failed to record funding history', { symbol, error: err });
    }

    return { settledPositions: settledCount, rateData };
  }
}

export const futuresFundingService = new FuturesFundingService();
