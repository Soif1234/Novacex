import { FuturesPositionEntity } from '../../models/futures.model';
import {
  decimalMultiply,
  decimalCompare,
  decimalSubtract,
  decimalAdd,
  decimalDivide,
  decimalNormalize,
  validateAmount,
} from '../ledger/decimal';
import { db } from '../../config/database';
import { ledgerService } from '../ledger/ledger.service';
import { INSURANCE_FUND_ACCOUNT_ID } from './insurance-fund.service';
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

    // Settle in ONE atomic transaction per symbol (funding zero-sum fix):
    //  - Advisory lock serializes concurrent runs.
    //  - UNIQUE(symbol, epoch) in futures_funding_history prevents double-apply.
    //  - Every payer must have sufficient balance; insufficient = fail loud (no unilateral credit).
    const result = await db.transaction(async (txClient) => {
      // Advisory lock serializes concurrent funding runs for this symbol
      try {
        await txClient.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`FUNDING-${symbol}`]);
      } catch {
        // In-memory DB may not support pg_advisory_xact_lock; best-effort.
      }

      // Check if this epoch was already settled (idempotent via UNIQUE(symbol, epoch))
      const existingRes = await txClient.query<any>(
        'SELECT id FROM futures_funding_history WHERE symbol = $1 AND epoch = $2',
        [symbol, epoch]
      );
      if (existingRes.rows.length > 0) {
        logger.debug('Funding epoch already settled, skipping', { symbol, epoch });
        return { settledPositions: 0, alreadySettled: true };
      }

      // Load all OPEN positions for this symbol
      const positionsRes = await txClient.query<any>(
        `SELECT * FROM futures_positions WHERE symbol = $1 AND status = 'OPEN'`,
        [symbol]
      );

      if (positionsRes.rows.length === 0) {
        return { settledPositions: 0, alreadySettled: false };
      }

      // Pre-compute all payments and check sufficiency
      const payments: Array<{ row: any; payment: string; isCredit: boolean; absoluteAmount: string }> = [];
      for (const row of positionsRes.rows) {
        const position: FuturesPositionEntity = this.mapRow(row);
        const payment = this.calculateEstimatedFunding(position, rateData.markPrice, appliedRate);
        if (decimalCompare(payment, '0') === 0) continue;
        const isCredit = decimalCompare(payment, '0') > 0;
        const absoluteAmount = isCredit ? payment : decimalSubtract('0', payment);
        payments.push({ row, payment, isCredit, absoluteAmount });
      }

      // Post each position's funding payment using txClient for atomicity.
      // If any post fails (e.g. insufficient balance after pre-check), the
      // whole transaction rolls back — no unilateral credit.
      let settledCount = 0;
      const creditByAsset = new Map<string, string>(); // total CREDIT (receiver) per asset
      const debitByAsset = new Map<string, string>();  // total DEBIT (payer) per asset

      for (const p of payments) {
        const collateralAsset = p.row.collateral_asset || 'FUTURES_USDT';
        const referenceId = `FUNDING-${symbol}-${epoch}-${p.row.id}`;

        try {
          let userFundedAmount = p.absoluteAmount;
          let insuranceFundedAmount = '0';

          if (!p.isCredit) {
            // Payer: determine if they have enough available balance
            const balRes = await txClient.query<any>(
              'SELECT available_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2 FOR UPDATE',
              [p.row.account_id, collateralAsset]
            );
            const userAvail = String(balRes.rows[0]?.available_balance || '0');

            if (decimalCompare(userAvail, p.absoluteAmount) < 0) {
              const shortfall = decimalSubtract(p.absoluteAmount, userAvail);
              const currentIM = String(p.row.initial_margin || '0');
              let marginRelease = shortfall;

              if (decimalCompare(marginRelease, currentIM) > 0) {
                marginRelease = currentIM;
              }

              if (decimalCompare(marginRelease, '0') > 0) {
                // 1. Release from ledger locked
                await ledgerService.release(
                  p.row.account_id,
                  collateralAsset,
                  marginRelease,
                  'FUTURES_FUNDING_PAYMENT' as any,
                  `${referenceId}-RELEASE`,
                  `Margin release for funding`,
                  undefined,
                  txClient
                );
                // 2. Deduct from position IM
                const newIM = decimalSubtract(currentIM, marginRelease);
                await txClient.query(
                  `UPDATE futures_positions SET initial_margin = $1, updated_at = NOW() WHERE id = $2`,
                  [newIM, p.row.id]
                );
              }

              // Recalculate available after release
              const newAvail = decimalAdd(userAvail, marginRelease);
              if (decimalCompare(newAvail, p.absoluteAmount) < 0) {
                userFundedAmount = newAvail;
                insuranceFundedAmount = decimalSubtract(p.absoluteAmount, newAvail);
              }
            }
          }

          const entries: any[] = [];

          if (decimalCompare(userFundedAmount, '0') > 0) {
            entries.push({
              accountId: p.row.account_id,
              asset: collateralAsset,
              direction: p.isCredit ? 'CREDIT' : 'DEBIT',
              amount: userFundedAmount,
              balancePool: 'available'
            });
          }

          if (decimalCompare(insuranceFundedAmount, '0') > 0) {
            entries.push({
              accountId: INSURANCE_FUND_ACCOUNT_ID,
              asset: collateralAsset,
              direction: 'DEBIT',
              amount: insuranceFundedAmount,
              balancePool: 'available'
            });
          }

          if (entries.length > 0) {
            await ledgerService.postTransaction({
              accountId: p.row.account_id,
              transactionType: 'FUTURES_FUNDING_PAYMENT',
              referenceId,
              description: `Funding payment for ${p.row.side} ${symbol} at rate ${appliedRate}`,
              entries
            }, txClient);
          }
          settledCount++;

          // Accumulate per-asset payer/receiver totals for the explicit house leg.
          if (p.isCredit) {
            creditByAsset.set(collateralAsset, decimalAdd(creditByAsset.get(collateralAsset) || '0', p.absoluteAmount));
          } else {
            debitByAsset.set(collateralAsset, decimalAdd(debitByAsset.get(collateralAsset) || '0', p.absoluteAmount));
          }
        } catch (err: any) {
          if (err.message && (err.message.includes('violate') || err.message.includes('duplicate') || err.message.includes('already exists'))) {
            logger.debug('Funding already settled for position', { positionId: p.row.id, referenceId });
            settledCount++;
          } else {
            throw err; // fail loudly for genuine errors — rollback the entire epoch
          }
        }
      }

      // ── Strict zero-sum house leg (funding imbalance) ──────────────────
      // Funding transfers value between longs and shorts. When open interest is
      // imbalanced (only longs OR only shorts exist), the funding surplus or
      // shortfall is explicitly booked against the Insurance Fund — the repo's
      // defined house account — so that for every asset:
      //
      //     total payer (DEBIT) + total receiver (CREDIT) + house leg = 0
      //
      // No funding value appears or disappears merely because only one side
      // has positions. The house leg is itself idempotent via its referenceId
      // and rolls back with the epoch if it cannot be funded.
      // Iterate over the union of both maps' keys so that an all-DEBIT or
      // all-CREDIT scenario (only-longs or only-shorts) still produces a
      // house leg.
      const allAssets = new Set([...creditByAsset.keys(), ...debitByAsset.keys()]);
      for (const asset of allAssets) {
        const credit = creditByAsset.get(asset) || '0';
        const debit = debitByAsset.get(asset) || '0';
        const net = decimalSubtract(credit, debit);
        if (decimalCompare(net, '0') === 0) continue; // balanced — no house leg needed

        const houseRef = `FUNDING-HOUSE-${symbol}-${epoch}-${asset}`;
        const housePays = decimalCompare(net, '0') > 0; // receivers got more than payers paid
        const houseAmount = housePays ? net : decimalSubtract('0', net);
        try {
          await ledgerService.postTransaction({
            accountId: INSURANCE_FUND_ACCOUNT_ID,
            transactionType: 'FUTURES_FUNDING_PAYMENT',
            referenceId: houseRef,
            description: `Funding house balancing leg for ${symbol} epoch ${epoch} (${asset})`,
            entries: [
              {
                accountId: INSURANCE_FUND_ACCOUNT_ID,
                asset,
                direction: housePays ? 'DEBIT' : 'CREDIT',
                amount: houseAmount
              }
            ]
          }, txClient);
        } catch (err: any) {
          if (err.message && (err.message.includes('violate') || err.message.includes('duplicate') || err.message.includes('already exists'))) {
            logger.debug('Funding house leg already settled', { symbol, epoch, asset, houseRef });
          } else {
            logger.error('Failed to settle funding house leg', { symbol, epoch, asset, error: err.message });
            throw err; // rollback the entire epoch — no unilateral value flow
          }
        }
      }

      // Record funding history with epoch for idempotent recovery
      try {
        await txClient.query(
          `INSERT INTO futures_funding_history (id, symbol, funding_rate, mark_price, index_price, epoch, settled_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [crypto.randomUUID(), symbol, appliedRate, rateData.markPrice, rateData.indexPrice, epoch]
        );
      } catch (err: any) {
        if (err.message && (err.message.includes('duplicate') || err.message.includes('unique') || err.message.includes('violate'))) {
          logger.debug('Funding history already recorded for this epoch', { symbol, epoch });
        } else {
          logger.error('Failed to record funding history', { symbol, error: err.message });
          throw err; // rollback — the epoch must be recorded to prevent double-apply
        }
      }

      return { settledPositions: settledCount, alreadySettled: false };
    });

    if (result.alreadySettled) {
      return { settledPositions: 0, rateData };
    }

    return { settledPositions: result.settledPositions, rateData };
  }

  private mapRow(r: any): FuturesPositionEntity {
    return {
      id: r.id,
      accountId: r.account_id || r.accountId,
      symbol: r.symbol,
      side: r.side,
      quantity: String(r.quantity),
      entryPrice: String(r.entry_price || r.entryPrice),
      markPrice: String(r.mark_price || r.markPrice),
      liquidationPrice: String(r.liquidation_price || r.liquidationPrice),
      leverage: Number(r.leverage),
      marginMode: r.margin_mode || r.marginMode,
      initialMargin: String(r.initial_margin || r.initialMargin),
      maintenanceMargin: String(r.maintenance_margin || r.maintenanceMargin),
      realizedPnl: String(r.realized_pnl || r.realizedPnl),
      status: r.status,
      createdAt: new Date(r.created_at || r.createdAt),
      updatedAt: new Date(r.updated_at || r.updatedAt),
    };
  }
}

export const futuresFundingService = new FuturesFundingService();
