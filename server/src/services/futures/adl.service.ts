import { IDatabaseConnection, db } from '../../config/database';
import { LedgerService, ledgerService } from '../ledger/ledger.service';
import { logger } from '../../config/logger';
import { futuresRiskService, FuturesRiskService } from './risk.service';
import { developmentMarkPriceProvider, IMarkPriceProvider } from './mark-price.provider';
import {
  decimalAdd,
  decimalSubtract,
  decimalMultiply,
  decimalDivide,
  decimalCompare,
  decimalNormalize,
} from '../ledger/decimal';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * ADL Suspense Account (SYSTEM_ADL_SUSPENSE):
 * Dedicated system account permitted to hold a negative balance for tracking
 * unresolved systemic liquidation deficits.
 * When the Insurance Fund cannot cover a liquidation deficit, the deficit is
 * debited to this account. During ADL, profitable counterparties are closed
 * at the bankrupt position's bankruptcy price, and the recovered profit is
 * credited back to this account to restore it to zero.
 */
export const ADL_SUSPENSE_ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FuturesAdlEventEntity {
  id: string;
  liquidationId: string;
  counterpartyAccountId: string | null;
  counterpartyPositionId: string | null;
  symbol: string;
  side: 'LONG' | 'SHORT';
  reducedQuantity: string | null;
  executionPrice: string | null;
  status: 'PENDING' | 'PARTIALLY_SETTLED' | 'SETTLED' | 'UNRESOLVED';
  targetDeficit: string;
  resolvedDeficit: string;
  createdAt: Date;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class FuturesAdlService {
  constructor(
    private database: IDatabaseConnection = db,
    private ledger: LedgerService = ledgerService,
    private risk: FuturesRiskService = futuresRiskService,
    private markPrices: IMarkPriceProvider = developmentMarkPriceProvider
  ) {}

  /**
   * Process an ADL event within one atomic PostgreSQL transaction.
   *
   * Bybit / Industry Standard Perpetual Futures ADL Model:
   *  1. Lock the ADL event row FOR UPDATE. Skip if already SETTLED or UNRESOLVED.
   *  2. Retrieve bankruptcy_price from the associated futures_liquidations record.
   *  3. Find all OPEN positions on the opposite side of the same symbol, locking them FOR UPDATE.
   *  4. Filter to only profitable positions (Unrealized PnL > 0 at mark price).
   *  5. Rank candidates by leveraged Return on Equity (ROE = Unrealized PnL / Initial Margin) descending.
   *  6. If no profitable counterparties exist, transition event to UNRESOLVED.
   *  7. For each ranked counterparty in order:
   *     a. Calculate profit potential at the Bankruptcy Price: calculateRealizedPnl(targetSide, qty, entryPrice, bankruptcyPrice).
   *     b. If profit > remaining deficit, partially reduce only the exact quantity needed to cover remaining deficit.
   *     c. If profit <= remaining deficit, close the entire position.
   *     d. Update counterparty position (quantity, IM, MM, realized_pnl, status).
   *     e. Post double-entry ledger transaction:
   *        - DEBIT counterparty locked balance (released IM)
   *        - CREDIT counterparty available balance (released IM + realized profit at bankruptcy price)
   *        - CREDIT ADL_SUSPENSE available balance (recovered profit to offset negative suspense balance)
   *     f. Deduct recovered profit from remaining deficit.
   *     g. Stop if deficit is fully covered (remainingDeficit <= 0).
   *  8. Update ADL event with resolved deficit, counterparty details, execution price, and final status (SETTLED or PARTIALLY_SETTLED).
   */
  public async processAdlEvent(eventId: string, overrideMarkPrice?: string): Promise<void> {
    try {
      await this.database.transaction(async (txClient) => {
        // ── 1. Lock and validate ADL event ──────────────────────────────
        const eventRes = await txClient.query<any>(
          'SELECT * FROM futures_adl_events WHERE id = $1 FOR UPDATE',
          [eventId]
        );
        const eventRow = eventRes.rows[0];
        if (!eventRow) return;
        if (eventRow.status === 'SETTLED' || eventRow.status === 'UNRESOLVED') return;

        const event = this.mapAdlEvent(eventRow);

        let remainingDeficit = decimalSubtract(event.targetDeficit, event.resolvedDeficit);
        if (decimalCompare(remainingDeficit, '0') <= 0) {
          await txClient.query(
            `UPDATE futures_adl_events SET status = 'SETTLED' WHERE id = $1`,
            [eventId]
          );
          return;
        }

        // ── 2. Fetch bankruptcy price from the liquidation ──────────────
        const liqRes = await txClient.query<any>(
          'SELECT bankruptcy_price, liquidation_price FROM futures_liquidations WHERE id = $1',
          [event.liquidationId]
        );
        const liqRow = liqRes.rows[0];
        if (!liqRow) {
          await txClient.query(
            `UPDATE futures_adl_events SET status = 'UNRESOLVED' WHERE id = $1`,
            [eventId]
          );
          return;
        }
        const bankruptcyPrice = String(liqRow.bankruptcy_price);

        // ── 3. Determine current mark price for ROE ranking ────────────
        let currentMarkPrice = overrideMarkPrice
          ? decimalNormalize(overrideMarkPrice)
          : await this.markPrices.getMarkPrice(event.symbol);

        // Check if k_lines has a more recent price if not overridden
        if (!overrideMarkPrice) {
          try {
            const klineRes = await txClient.query<any>(
              'SELECT close_price FROM k_lines WHERE symbol = $1 ORDER BY open_time DESC LIMIT 1',
              [event.symbol]
            );
            if (klineRes.rows[0]?.close_price) {
              currentMarkPrice = String(klineRes.rows[0].close_price);
            }
          } catch {
            // fallback to markPrices provider
          }
        }

        // ── 4. Find counterparty candidates (opposite side, OPEN) ──────
        const targetSide = event.side === 'LONG' ? 'SHORT' : 'LONG';

        const candidatesRes = await txClient.query<any>(
          `SELECT * FROM futures_positions
           WHERE symbol = $1 AND side = $2 AND status = 'OPEN'
           FOR UPDATE`,
          [event.symbol, targetSide]
        );

        // ── 5. Filter profitable + Rank by ROE ──────────────────────────
        const rankedCandidates = candidatesRes.rows
          .map((row: any) => {
            const qty = String(row.quantity);
            const entryPrice = String(row.entry_price);
            const im = String(row.initial_margin);
            const upnl = this.risk.calculateUnrealizedPnl(
              row.side as any, qty, entryPrice, currentMarkPrice
            );
            // ROE = unrealizedPnl / initialMargin
            const roe = decimalCompare(im, '0') > 0
              ? decimalDivide(upnl, im)
              : '0';
            return {
              id: row.id as string,
              accountId: row.account_id as string,
              qty,
              entryPrice,
              im,
              mm: String(row.maintenance_margin),
              realizedPnl: String(row.realized_pnl || '0'),
              upnl,
              roe,
              updatedAt: row.updated_at,
            };
          })
          .filter((c) => decimalCompare(c.upnl, '0') > 0) // only profitable positions
          .sort((a, b) => {
            // Rank by highest ROE first, tie-break by ID for determinism
            const roeCmp = decimalCompare(b.roe, a.roe);
            return roeCmp !== 0 ? roeCmp : a.id.localeCompare(b.id);
          });

        if (rankedCandidates.length === 0) {
          await txClient.query(
            `UPDATE futures_adl_events SET status = 'UNRESOLVED' WHERE id = $1`,
            [eventId]
          );
          return;
        }

        // ── 6. Process Counterparties ──────────────────────────────────
        let totalExtracted = '0';
        let lastCpAccountId: string | null = null;
        let lastCpPositionId: string | null = null;
        let lastReduceQty = '0';

        // Fetch trading pair lot size / min notional for dust protection
        let lotSize = '0.0001';
        let minNotional = '5.0';
        try {
          const pairRes = await txClient.query<any>(
            'SELECT lot_size, min_notional FROM trading_pairs WHERE symbol = $1',
            [event.symbol]
          );
          if (pairRes.rows[0]) {
            lotSize = String(pairRes.rows[0].lot_size || lotSize);
            minNotional = String(pairRes.rows[0].min_notional || minNotional);
          }
        } catch {
          // use defaults
        }

        for (const cp of rankedCandidates) {
          if (decimalCompare(remainingDeficit, '0') <= 0) break;

          // Full profit possible at bankruptcy price
          const fullProfitAtBankruptcy = this.risk.calculateRealizedPnl(
            targetSide as any, cp.qty, cp.entryPrice, bankruptcyPrice
          );

          // Skip if candidate does not produce positive profit at bankruptcy price
          if (decimalCompare(fullProfitAtBankruptcy, '0') <= 0) continue;

          let reduceQty = cp.qty;
          let actualExtractedProfit = fullProfitAtBankruptcy;
          let finalStatus = 'CLOSED';

          if (decimalCompare(fullProfitAtBankruptcy, remainingDeficit) > 0) {
            // Partial reduction: reduce only what is needed to cover remaining deficit
            const ratio = decimalDivide(remainingDeficit, fullProfitAtBankruptcy);
            reduceQty = decimalMultiply(cp.qty, ratio);

            // Precision alignment to lot size
            const lots = decimalDivide(reduceQty, lotSize).split('.')[0] || '0';
            reduceQty = decimalMultiply(lots, lotSize);

            if (decimalCompare(reduceQty, '0') <= 0) {
              reduceQty = lotSize;
            }

            // Check if remaining quantity would be below min notional
            const remainingQty = decimalSubtract(cp.qty, reduceQty);
            if (decimalCompare(remainingQty, '0') > 0) {
              const remainingNotional = this.risk.calculateNotional(remainingQty, bankruptcyPrice);
              if (decimalCompare(remainingNotional, minNotional) < 0) {
                reduceQty = cp.qty;
              }
            }

            actualExtractedProfit = this.risk.calculateRealizedPnl(
              targetSide as any, reduceQty, cp.entryPrice, bankruptcyPrice
            );

            if (decimalCompare(reduceQty, cp.qty) >= 0) {
              reduceQty = cp.qty;
              actualExtractedProfit = fullProfitAtBankruptcy;
              finalStatus = 'CLOSED';
            } else {
              finalStatus = 'OPEN';
            }
          }

          // Compute margin release and position updates
          const releasedIM = decimalMultiply(cp.im, decimalDivide(reduceQty, cp.qty));
          const finalRemainingQty = decimalSubtract(cp.qty, reduceQty);
          const finalRemainingIM = decimalSubtract(cp.im, releasedIM);
          const finalMM = this.risk.calculateMaintenanceMargin(
            finalRemainingQty, cp.entryPrice, '0.005'
          );
          const totalAccumulatedRealizedPnl = decimalAdd(cp.realizedPnl, actualExtractedProfit);

          // Update counterparty position
          await txClient.query(
            `UPDATE futures_positions SET
              quantity = $1, initial_margin = $2, maintenance_margin = $3,
              realized_pnl = $4, status = $5, updated_at = NOW()
            WHERE id = $6`,
            [finalRemainingQty, finalRemainingIM, finalMM, totalAccumulatedRealizedPnl, finalStatus, cp.id]
          );

          // Post ledger transaction:
          // Counterparty receives their released initial margin + profit at bankruptcy price
          const userTotalCredit = decimalAdd(releasedIM, actualExtractedProfit);
          const adlRef = `FUTURES-ADL-${event.id}-${cp.id}-${new Date(cp.updatedAt).getTime()}`;

          await this.ledger.postTransaction({
            accountId: cp.accountId,
            transactionType: 'FUTURES_LIQUIDATION' as any,
            referenceId: adlRef,
            description: `ADL Counterparty Close: ${event.symbol} ${targetSide} ${reduceQty} @ ${bankruptcyPrice}`,
            entries: [
              { accountId: cp.accountId, asset: 'FUTURES_USDT', direction: 'DEBIT', amount: releasedIM, balancePool: 'locked' },
              { accountId: cp.accountId, asset: 'FUTURES_USDT', direction: 'CREDIT', amount: userTotalCredit, balancePool: 'available' },
              { accountId: ADL_SUSPENSE_ACCOUNT_ID, asset: 'FUTURES_USDT', direction: 'CREDIT', amount: actualExtractedProfit, balancePool: 'available' },
            ],
          }, txClient);

          remainingDeficit = decimalSubtract(remainingDeficit, actualExtractedProfit);
          totalExtracted = decimalAdd(totalExtracted, actualExtractedProfit);

          lastCpAccountId = cp.accountId;
          lastCpPositionId = cp.id;
          lastReduceQty = reduceQty;
        }

        // ── 7. Update ADL Event ─────────────────────────────────────────
        const newResolvedDeficit = decimalAdd(event.resolvedDeficit, totalExtracted);
        const newStatus = decimalCompare(newResolvedDeficit, event.targetDeficit) >= 0
          ? 'SETTLED'
          : (decimalCompare(totalExtracted, '0') > 0 ? 'PARTIALLY_SETTLED' : 'UNRESOLVED');

        await txClient.query(
          `UPDATE futures_adl_events SET
            counterparty_account_id = $1,
            counterparty_position_id = $2,
            reduced_quantity = $3,
            execution_price = $4,
            resolved_deficit = $5,
            status = $6
          WHERE id = $7`,
          [
            lastCpAccountId,
            lastCpPositionId,
            lastReduceQty,
            bankruptcyPrice,
            newResolvedDeficit,
            newStatus,
            event.id,
          ]
        );

        logger.info('ADL execution completed', {
          eventId: event.id,
          status: newStatus,
          totalExtracted,
          targetDeficit: event.targetDeficit,
          resolvedDeficit: newResolvedDeficit,
        });
      });
    } catch (err: any) {
      logger.error('Failed to process ADL event', { eventId, error: err.message, stack: err.stack });
      throw err;
    }
  }

  public async getPendingEvents(): Promise<FuturesAdlEventEntity[]> {
    const res = await this.database.query<any>(
      `SELECT * FROM futures_adl_events WHERE status IN ('PENDING', 'PARTIALLY_SETTLED') ORDER BY created_at ASC`,
      []
    );
    return res.rows.map((r) => this.mapAdlEvent(r));
  }

  private mapAdlEvent(r: any): FuturesAdlEventEntity {
    return {
      id: r.id,
      liquidationId: r.liquidation_id,
      counterpartyAccountId: r.counterparty_account_id,
      counterpartyPositionId: r.counterparty_position_id,
      symbol: r.symbol,
      side: r.side,
      reducedQuantity: r.reduced_quantity ? String(r.reduced_quantity) : null,
      executionPrice: r.execution_price ? String(r.execution_price) : null,
      status: r.status,
      targetDeficit: String(r.target_deficit),
      resolvedDeficit: String(r.resolved_deficit || '0'),
      createdAt: new Date(r.created_at),
    };
  }
}

export const futuresAdlService = new FuturesAdlService();
