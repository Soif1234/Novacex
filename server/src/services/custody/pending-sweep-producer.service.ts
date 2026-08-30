/**
 * Phase 10.4 Step 6E-4C-2 (P1): pending_sweeps producer.
 *
 * Prior to this correction NOTHING in the codebase inserted into
 * pending_sweeps — confirmed deposits never became sweep targets, so the
 * SweepWorker had no work to do.
 *
 * Idempotency & concurrency:
 *  - UNIQUE(deposit_id) on pending_sweeps (migration 022) is the arbiter.
 *  - `ON CONFLICT (deposit_id) DO NOTHING` makes repeated ticks and concurrent
 *    workers safe: at most one pending_sweep row can ever exist per deposit.
 *
 * Crediting independence:
 *  - This producer MUST stay financially inert. User crediting happens in
 *    DepositCreditingService keyed on blockchain_deposits.status='CONFIRMED'
 *    AND is_credited=FALSE. Creating a pending_sweep row neither gates nor
 *    triggers crediting, and a failure here must never fail crediting (the
 *    worker wraps the call in its own try/catch).
 */
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { db } from '../../config/database';

export class PendingSweepProducer {
  /**
   * Create PENDING sweep rows for confirmed deposits on sweepable networks.
   * @returns number of rows actually created (idempotent).
   */
  public async producePendingSweeps(limit: number = 500): Promise<number> {
    const networks = (env.CUSTODY_SWEEPABLE_NETWORKS || '')
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);

    if (networks.length === 0) {
      return 0;
    }

    const res = await db.query(
      `INSERT INTO pending_sweeps (deposit_id, network, status)
       SELECT bd.id, bd.network, 'PENDING'
       FROM blockchain_deposits bd
       WHERE bd.status = 'CONFIRMED'
         AND bd.to_address IS NOT NULL
         AND UPPER(bd.network) = ANY($1::text[])
       ORDER BY bd.confirmed_at NULLS LAST, bd.created_at
       LIMIT $2
       ON CONFLICT (deposit_id) DO NOTHING`,
      [networks, limit]
    );

    const inserted = res.rowCount ?? 0;
    if (inserted > 0) {
      logger.info(`[PendingSweepProducer] Created ${inserted} pending_sweeps rows for confirmed deposits`);
    }
    return inserted;
  }
}

export const pendingSweepProducer = new PendingSweepProducer();
