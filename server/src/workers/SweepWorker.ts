import { env } from '../config/env';
import { logger } from '../config/logger';
import { db } from '../config/database';
import { custodyService } from '../services/custody/custody.service';
import {
  SweepDustError,
  SweepZeroBalanceError,
  SweepReconciliationRequiredError,
} from '../services/custody/custody.errors';
import { circuitBreakerService } from '../services/system/circuit-breaker.service';
import crypto from 'crypto';

export class SweepWorker {
  private intervalId: NodeJS.Timeout | null = null;
  public isRunning = false;

  constructor(private readonly pollIntervalMs: number = 10000) {}

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info(`SweepWorker started (interval: ${this.pollIntervalMs}ms)`);
    this.intervalId = setInterval(() => this.execute().catch((err) => {
      logger.error(`SweepWorker error: ${err.message}`);
    }), this.pollIntervalMs);
  }

  public stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.isRunning = false;
      logger.info('SweepWorker stopped');
    }
  }

  private async execute(): Promise<void> {
    if (!env.CRYPTO_WITHDRAWALS_ENABLED) { // Use same generic capability gate
      return;
    }

    // Phase 11K — manual Safe mode: automatic outbound sweeps are DISABLED.
    // The manual provider never signs/broadcasts; forwarder deposits simply
    // accumulate on-chain and an operator sweeps them manually. See the
    // manual sweep procedure in the Phase 11K report.
    if (custodyService.getProviderId() === 'manual_safe') {
      logger.warn('[SweepWorker] manual_safe mode: automatic sweeps disabled; forwarder deposits accumulate for manual sweep');
      return;
    }

    const breaker = await circuitBreakerService.isSubsystemOperational('WITHDRAWALS');
    if (!breaker.operational) {
      logger.warn('[SweepWorker] Circuit breaker open, skipping processing');
      return;
    }

    try {
      // 1. Recover any stuck sweeps from prior crashes (intent-aware — see below)
      await this.recoverStuckSweeps(env.CUSTODY_SWEEP_RECOVERY_TIMEOUT_MINUTES);

      // 2. Grab distinct grouped sweeping targets that have newly arrived PENDING sweeps
      const targets = await this.getGroupedTargets(10);
      for (const target of targets) {
        await this.processTarget(target);
      }

      // 3. Bounded physical-vs-DB reconciliation pass (operational only)
      await this.runBoundedReconciliation(3);
    } catch (err: any) {
      logger.error(`[SweepWorker] Loop failed: ${err.message}`);
    }
  }

  /**
   * Phase 10.4 Step 6E-4C-2 (P0): intent-aware stuck-sweep recovery.
   *
   * The previous implementation blindly reset PROCESSING/SIGNING rows to
   * PENDING. With durable sweep_intents that is re-architected:
   *
   *  A. PROCESSING without an intent and without an artifact: the claim
   *     transaction committed but the atomic (reservation + intent) transaction
   *     never ran — NO nonce can have been consumed. Safe queue reset.
   *  B. SIGNING with an open durable intent (no artifact): a nonce IS
   *     reserved. Rows are reset to PENDING as queue mechanics ONLY — the
   *     intent row and its linkage are deliberately preserved, and the
   *     provider's reuse path re-signs with the SAME nonce after chain
   *     verification (getTransactionCount latest/pending). hot_wallet_nonces
   *     is never incremented for a recovery, and an unusable intent is
   *     surfaced as RECONCILIATION instead of being overwritten.
   *  C. Any row with a persisted artifact (sweep_txid): reset to PENDING;
   *     provider artifact recovery rebroadcasts the EXACT persisted bytes.
   */
  private async recoverStuckSweeps(timeoutMinutes: number = 5): Promise<void> {
    try {
      // A. Crashed between claim and intent creation — provably no nonce consumed.
      const resA = await db.query(`
        UPDATE pending_sweeps ps
        SET status = 'PENDING', updated_at = NOW()
        WHERE ps.status = 'PROCESSING'
          AND ps.sweep_txid IS NULL
          AND ps.sweep_intent_id IS NULL
          AND ps.updated_at < NOW() - ($1 || ' minutes')::INTERVAL
        RETURNING ps.id
      `, [timeoutMinutes]);
      if (resA.rows.length > 0) {
        logger.warn(`[SweepWorker] Recovered ${resA.rows.length} stuck PROCESSING sweeps (no intent) back to PENDING`);
      }

      // B. Nonce reserved with a durable open intent: queue reset that PRESERVES
      //    the intent identity and the reserved nonce.
      const resB = await db.query(`
        UPDATE pending_sweeps ps
        SET status = 'PENDING', updated_at = NOW()
        FROM sweep_intents si
        WHERE ps.status = 'SIGNING'
          AND ps.sweep_intent_id = si.id
          AND si.status = 'SIGNING'
          AND si.sweep_txid IS NULL
          AND ps.updated_at < NOW() - ($1 || ' minutes')::INTERVAL
        RETURNING ps.id
      `, [timeoutMinutes]);
      if (resB.rows.length > 0) {
        logger.warn(`[SweepWorker] Recovered ${resB.rows.length} stuck SIGNING sweeps with RESERVED nonces — intents preserved, provider will reuse the stored nonce after chain verification`);
      }

      // C. Artifact exists — recovery rebroadcast path (exact bytes).
      const resC = await db.query(`
        UPDATE pending_sweeps ps
        SET status = 'PENDING', updated_at = NOW()
        WHERE ps.status IN ('PROCESSING', 'SIGNING')
          AND ps.sweep_txid IS NOT NULL
          AND ps.updated_at < NOW() - ($1 || ' minutes')::INTERVAL
        RETURNING ps.id
      `, [timeoutMinutes]);
      if (resC.rows.length > 0) {
        logger.warn(`[SweepWorker] Recovered ${resC.rows.length} stuck sweeps with persisted artifacts back to PENDING (exact-byte rebroadcast path)`);
      }
    } catch (err: any) {
      logger.error(`[SweepWorker] Error recovering stuck sweeps: ${err.message}`);
    }
  }

  private async getGroupedTargets(limit: number): Promise<Array<{ network: string; address: string; asset: string }>> {
    // Find unique (network, address, asset) combinations with active PENDING sweeps.
    // DEFERRED_DUST sweeps are reactivated only when a new PENDING deposit arrives for that group.
    // RECONCILIATION rows never block group selection: they are manual states, not in-flight work.
    const res = await db.query(`
      SELECT DISTINCT ps.network, bd.to_address AS address, bd.asset
      FROM pending_sweeps ps
      JOIN blockchain_deposits bd ON ps.deposit_id = bd.id
      WHERE ps.status = 'PENDING'
        AND NOT EXISTS (
          SELECT 1
          FROM pending_sweeps ps2
          JOIN blockchain_deposits bd2 ON ps2.deposit_id = bd2.id
          WHERE bd2.to_address = bd.to_address
            AND ps2.network = ps.network
            AND bd2.asset = bd.asset
            AND ps2.status IN ('PROCESSING', 'SIGNING', 'BROADCAST')
        )
      LIMIT $1
    `, [limit]);
    return res.rows as Array<{ network: string; address: string; asset: string }>;
  }

  private async processTarget(target: { network: string; address: string; asset: string }): Promise<void> {
    const { network, address, asset } = target;
    const lockKey = crypto.createHash('sha256').update(`sweep_${network}_${address}_${asset}`).digest().readInt32BE(0);

    let sweepIds: string[] = [];

    // DB Tx 1: Try to acquire advisory lock and claim all pending and deferred dust sweeps for this physical grouping
    await db.transaction(async (client) => {
      const lockRes = await client.query(`SELECT pg_try_advisory_xact_lock($1)`, [lockKey]);
      const lockRow = lockRes.rows[0] as any;
      if (!lockRow || !lockRow.pg_try_advisory_xact_lock) {
        // Another worker is sweeping this exact address/asset. Skip.
        return;
      }

      // Lock acquired. Claim all PENDING and DEFERRED_DUST sweeps for this target
      const res = await client.query(`
        UPDATE pending_sweeps ps
        SET status = 'PROCESSING', updated_at = NOW()
        FROM blockchain_deposits bd
        WHERE ps.deposit_id = bd.id
          AND bd.to_address = $1
          AND ps.network = $2
          AND bd.asset = $3
          AND ps.status IN ('PENDING', 'DEFERRED_DUST')
        RETURNING ps.id
      `, [address, network, asset]);

      sweepIds = (res.rows as any[]).map(r => r.id);
    });

    if (sweepIds.length === 0) return;

    logger.info(`[SweepWorker] Processing ${sweepIds.length} sweeps for ${network}:${address} (${asset})`);

    try {
      // Execute via custody service. This delegates to the adapter which handles the KMS/broadcast.
      const txHash = await custodyService.sweepDepositAddress(network, address, asset, sweepIds);
      logger.info(`[SweepWorker] Sweep broadcast successful: ${txHash}`);
    } catch (err: any) {
      // Typed routing (6E-4C-2): CustodyError subclasses survive the CAL's
      // normalizeError; legacy string fallbacks are kept for safety.
      if (err instanceof SweepZeroBalanceError) {
        if (err.settledTxHash) {
          // Zero balance fully explained: a previous CONFIRMED sweep moved this
          // forwarder's balance. Reconcile the rows as already physically
          // settled against that sweep — custody bookkeeping only.
          logger.info(`[SweepWorker] Zero balance explained: sweep ${err.settledTxHash} already settled ${sweepIds.length} rows for ${address} (${asset})`);
          await db.query(`
            UPDATE pending_sweeps
            SET status = 'CONFIRMED', sweep_txid = $1, updated_at = NOW()
            WHERE id = ANY($2)
          `, [err.settledTxHash, sweepIds]);
        } else {
          // Zero balance UNEXPLAINED: no sweep history matches. Never declare
          // settled — surface an explicit manual reconciliation state.
          logger.warn(`[SweepWorker] Zero balance UNEXPLAINED for ${address} (${asset}) — flagging ${sweepIds.length} rows for manual reconciliation`);
          await this.recordCustodyEvent(network, address, asset, 'ZERO_BALANCE_UNEXPLAINED', null, null, {
            sweepIds,
            note: 'Forwarder balance is zero with no matching confirmed sweep; funds moved externally, deposit detection stale, or data corruption.',
          });
          await this.markReconciled(sweepIds, 'RECONCILIATION');
        }
      } else if (err instanceof SweepReconciliationRequiredError) {
        logger.warn(`[SweepWorker] Sweep intent requires manual reconciliation for ${address} (${asset}): ${err.message}`);
        await this.markReconciled(sweepIds, 'RECONCILIATION');
      } else if (err instanceof SweepDustError || err.message?.includes('DUST')) {
        logger.warn(`[SweepWorker] Sweep deferred due to dust threshold for ${address}.`);
        await this.markReconciled(sweepIds, 'DEFERRED_DUST');
      } else if (err.message?.includes('ZERO_BALANCE')) {
        // Legacy string fallback (e.g. mock providers).
        logger.info(`[SweepWorker] Zero balance on-chain. Reconciling sweeps for ${address}.`);
        await this.markReconciled(sweepIds, 'ZERO_BALANCE');
      } else {
        logger.error(`[SweepWorker] Sweep failed for ${address}: ${err.message}`);
        await this.markReconciled(sweepIds, 'PENDING');
      }
    }
  }

  /**
   * P2 (6E-4C-2): bounded physical-vs-DB custody reconciliation. Purely
   * operational — discrepancies are recorded into custody_reconciliation_events
   * by the provider; user balances/ledgers are NEVER touched.
   */
  private async runBoundedReconciliation(limit: number = 3): Promise<void> {
    try {
      const res = await db.query(`
        SELECT DISTINCT ps.network, bd.to_address AS address, bd.asset
        FROM pending_sweeps ps
        JOIN blockchain_deposits bd ON ps.deposit_id = bd.id
        WHERE ps.status IN ('PENDING', 'DEFERRED_DUST', 'RECONCILIATION', 'ZERO_BALANCE')
        ORDER BY ps.network, bd.to_address, bd.asset
        LIMIT $1
      `, [limit]);

      for (const g of res.rows as Array<{ network: string; address: string; asset: string }>) {
        try {
          const result = await custodyService.reconcileDepositAddress(g.network, g.address, g.asset);
          if (result.status !== 'BALANCED') {
            logger.warn(`[SweepWorker] Custody reconciliation ${result.status} for ${g.network}:${g.address} (${g.asset}) — DB expected ${result.expectedRemaining}, physical ${result.physical}. Operational event recorded; user balances untouched.`);
          }
        } catch (e: any) {
          logger.error(`[SweepWorker] Reconciliation failed for ${g.network}:${g.address} (${g.asset}): ${e.message}`);
          break; // Reconciliation is best-effort; stop the pass on repeated trouble this tick.
        }
      }
    } catch (err: any) {
      logger.error(`[SweepWorker] Reconciliation pass failed: ${err.message}`);
    }
  }

  private async recordCustodyEvent(
    network: string,
    address: string,
    asset: string,
    kind: string,
    expectedAmount: string | null,
    physicalAmount: string | null,
    details: unknown
  ): Promise<void> {
    try {
      await db.query(`
        INSERT INTO custody_reconciliation_events (network, address, asset, kind, expected_amount, physical_amount, details)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [network, address, asset, kind, expectedAmount, physicalAmount, JSON.stringify(details ?? {})]);
    } catch (err: any) {
      logger.error(`[SweepWorker] Failed to record custody reconciliation event: ${err.message}`);
    }
  }

  private async markReconciled(sweepIds: string[], status: string): Promise<void> {
    await db.query(`
      UPDATE pending_sweeps
      SET status = $1, updated_at = NOW()
      WHERE id = ANY($2)
    `, [status, sweepIds]);
  }
}

export const sweepWorker = new SweepWorker();
