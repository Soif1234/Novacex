import { env } from '../config/env';
import { logger } from '../config/logger';
import { db } from '../config/database';
import { custodyService } from '../services/custody/custody.service';
import { circuitBreakerService } from '../services/system/circuit-breaker.service';

interface BroadcastSweepRow {
  tx_hash: string;
  network: string;
  status: string;
  network_nonce: number | null;
  updated_at: Date | string;
}

interface ConfirmedSweepRow {
  tx_hash: string;
  network: string;
  block_number: number | null;
  block_hash: string | null;
}

export class SweepStatusWorker {
  private intervalId: NodeJS.Timeout | null = null;
  public isRunning = false;

  constructor(private readonly pollIntervalMs: number = 10000) {}

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info(`SweepStatusWorker started (interval: ${this.pollIntervalMs}ms)`);
    this.intervalId = setInterval(() => this.execute().catch((err) => {
      logger.error(`SweepStatusWorker error: ${err.message}`);
    }), this.pollIntervalMs);
  }

  public stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.isRunning = false;
      logger.info('SweepStatusWorker stopped');
    }
  }

  private async execute(): Promise<void> {
    if (!env.CRYPTO_WITHDRAWALS_ENABLED) {
      return;
    }

    const breaker = await circuitBreakerService.isSubsystemOperational('WITHDRAWALS');
    if (!breaker.operational) {
      logger.warn('[SweepStatusWorker] Circuit breaker open, skipping status updates');
      return;
    }

    // 1. Process broadcasted sweeps awaiting confirmation
    await this.processBroadcastSweeps();

    // 2. Re-verify recently confirmed sweeps for blockchain reorgs
    await this.verifyConfirmedSweepsReorg();
  }

  private async processBroadcastSweeps(): Promise<void> {
    const res = await db.query(`
      SELECT tx_hash, network, status, network_nonce, updated_at
      FROM sweep_transactions
      WHERE status = 'BROADCAST'
      ORDER BY updated_at ASC
      LIMIT 50
    `);

    const rows = res.rows as BroadcastSweepRow[];

    for (const w of rows) {
      try {
        const sweepStatus = await custodyService.checkSweepStatus(w.tx_hash, w.network);
        if (sweepStatus.status === 'CONFIRMED') {
          await db.transaction(async (client) => {
            await client.query(`
              UPDATE sweep_transactions
              SET status = 'CONFIRMED',
                  block_number = $1,
                  block_hash = $2,
                  confirmed_at = NOW(),
                  updated_at = NOW()
              WHERE tx_hash = $3
            `, [sweepStatus.blockNumber ?? null, sweepStatus.blockHash ?? null, w.tx_hash]);

            await client.query(`
              UPDATE pending_sweeps
              SET status = 'CONFIRMED', updated_at = NOW()
              WHERE sweep_txid = $1
            `, [w.tx_hash]);

            await client.query(`
              UPDATE sweep_intents
              SET status = 'CONFIRMED', updated_at = NOW()
              WHERE sweep_txid = $1
            `, [w.tx_hash]);
          });
          logger.info(`[SweepStatusWorker] Sweep ${w.tx_hash} confirmed at block ${sweepStatus.blockNumber}.`);
        } else if (sweepStatus.status === 'FAILED') {
          await db.transaction(async (client) => {
            await client.query(`
              UPDATE sweep_transactions
              SET status = 'FAILED', updated_at = NOW()
              WHERE tx_hash = $1
            `, [w.tx_hash]);

            await client.query(`
              UPDATE pending_sweeps
              SET status = 'PENDING', sweep_txid = NULL, updated_at = NOW()
              WHERE sweep_txid = $1
            `, [w.tx_hash]);

            await client.query(`
              UPDATE sweep_intents
              SET status = 'FAILED', updated_at = NOW()
              WHERE sweep_txid = $1
            `, [w.tx_hash]);
          });
          logger.warn(`[SweepStatusWorker] Sweep ${w.tx_hash} failed on-chain. Pending sweeps reverted for retry.`);
        } else {
          // sweepStatus.status === 'BROADCAST'
          // 6E-4C-2 (P2): stuck-BROADCAST detection. A BROADCAST artifact older
          // than the configured threshold must be classified: still pending in
          // the mempool (keep waiting), or dropped/replaced (escalate to an
          // explicit unresolved state — never silently FAILED, never retried
          // with a new nonce over the occupied one).
          await this.detectStaleBroadcast(w);
        }
      } catch (err: any) {
        logger.error(`[SweepStatusWorker] Failed to check status for sweep ${w.tx_hash}: ${err.message}`);
      }
    }
  }

  private async detectStaleBroadcast(w: BroadcastSweepRow): Promise<void> {
    const staleMinutes = env.CUSTODY_SWEEP_STALE_BROADCAST_MINUTES;
    if (!staleMinutes || staleMinutes <= 0) return; // disabled

    const updatedAt = w.updated_at instanceof Date ? w.updated_at : new Date(w.updated_at);
    const ageMs = Date.now() - updatedAt.getTime();
    if (!(ageMs > staleMinutes * 60_000)) return; // still young — keep waiting

    let presence: { present: boolean; mined: boolean; nonceConsumed: boolean | null };
    const expectedNonce = w.network_nonce != null ? parseInt(String(w.network_nonce), 10) : undefined;
    try {
      presence = await custodyService.getSweepTxPresence(w.tx_hash, w.network, Number.isNaN(expectedNonce as number) ? undefined : expectedNonce);
    } catch (err: any) {
      logger.error(`[SweepStatusWorker] Stale-broadcast probe failed for ${w.tx_hash}: ${err.message}`);
      return;
    }

    if (presence.present || presence.mined) {
      // Visible on-chain (mempool or block). Either still waiting for
      // confirmations or the status worker raced a fresh receipt — keep BROADCAST.
      logger.info(`[SweepStatusWorker] Sweep ${w.tx_hash} broadcast ${Math.round(ageMs / 60_000)}m ago is still ${presence.mined ? 'mined (awaiting confirmations)' : 'pending in mempool'} — no escalation.`);
      return;
    }

    // Dropped: known to neither mempool nor chain. The funds state is
    // genuinely unresolved — the transaction may have been replaced by a
    // foreign transaction using the same nonce. Identify the replacement
    // itself is NOT reliably possible via standard RPC (documented
    // limitation); we only record whether the nonce has been consumed as
    // evidence, and escalate to a manual state WITHOUT overwriting the
    // original artifact or re-sweeping into a new nonce.
    logger.warn(`[SweepStatusWorker] Sweep ${w.tx_hash} dropped from network after ${Math.round(ageMs / 60_000)}m (nonceConsumed=${presence.nonceConsumed}) — escalating to STALE_BROADCAST`);
    try {
      await db.transaction(async (client) => {
        await client.query(`
          UPDATE sweep_transactions
          SET status = 'STALE_BROADCAST', updated_at = NOW()
          WHERE tx_hash = $1
        `, [w.tx_hash]);

        // Keep sweep_txid on the pending rows: the original artifact and its
        // reserved nonce must remain traceable for manual resolution.
        await client.query(`
          UPDATE pending_sweeps
          SET status = 'RECONCILIATION', updated_at = NOW()
          WHERE sweep_txid = $1
        `, [w.tx_hash]);

        await client.query(`
          UPDATE sweep_intents
          SET status = 'RECONCILIATION', updated_at = NOW()
          WHERE sweep_txid = $1
        `, [w.tx_hash]);

        await client.query(`
          INSERT INTO custody_reconciliation_events (network, asset, kind, details)
          SELECT $1, MAX(bd.asset), 'STALE_BROADCAST', $2::jsonb
          FROM pending_sweeps ps
          JOIN blockchain_deposits bd ON ps.deposit_id = bd.id
          WHERE ps.sweep_txid = $3
          GROUP BY ps.sweep_txid
        `, [w.network, JSON.stringify({
          txHash: w.tx_hash,
          networkNonce: w.network_nonce,
          nonceConsumed: presence.nonceConsumed,
          broadcastAgeMinutes: Math.round(ageMs / 60_000),
          note: 'Broadcast sweep disappeared from mempool and chain. Replacement identification not reliably detectable via standard RPC; requires manual resolution.',
        }), w.tx_hash]);
      });
    } catch (err: any) {
      logger.error(`[SweepStatusWorker] Failed to escalate stale broadcast ${w.tx_hash}: ${err.message}`);
    }
  }

  private async verifyConfirmedSweepsReorg(): Promise<void> {
    try {
      // Check sweeps confirmed in the last 1 hour to detect reorgs
      const res = await db.query(`
        SELECT tx_hash, network, block_number, block_hash
        FROM sweep_transactions
        WHERE status = 'CONFIRMED'
          AND confirmed_at >= NOW() - INTERVAL '1 hour'
        LIMIT 20
      `);

      const rows = res.rows as ConfirmedSweepRow[];

      for (const w of rows) {
        try {
          const sweepStatus = await custodyService.checkSweepStatus(w.tx_hash, w.network);
          if (sweepStatus.status === 'BROADCAST') {
            // Reorg occurred or confirmation depth dropped below required policy
            logger.warn(`[SweepStatusWorker] Reorg detected: Sweep ${w.tx_hash} returned to BROADCAST`);
            await db.transaction(async (client) => {
              await client.query(`
                UPDATE sweep_transactions
                SET status = 'BROADCAST', updated_at = NOW()
                WHERE tx_hash = $1
              `, [w.tx_hash]);

              await client.query(`
                UPDATE pending_sweeps
                SET status = 'BROADCAST', updated_at = NOW()
                WHERE sweep_txid = $1
              `, [w.tx_hash]);

              await client.query(`
                UPDATE sweep_intents
                SET status = 'BROADCAST', updated_at = NOW()
                WHERE sweep_txid = $1
              `, [w.tx_hash]);
            });
          } else if (sweepStatus.status === 'FAILED') {
            // Transaction was reorged into a reverted block or replaced/cancelled
            logger.warn(`[SweepStatusWorker] Reorg revert detected: Sweep ${w.tx_hash} marked FAILED, reverting deposits to PENDING`);
            await db.transaction(async (client) => {
              await client.query(`
                UPDATE sweep_transactions
                SET status = 'FAILED', updated_at = NOW()
                WHERE tx_hash = $1
              `, [w.tx_hash]);

              await client.query(`
                UPDATE pending_sweeps
                SET status = 'PENDING', sweep_txid = NULL, updated_at = NOW()
                WHERE sweep_txid = $1
              `, [w.tx_hash]);

              await client.query(`
                UPDATE sweep_intents
                SET status = 'FAILED', updated_at = NOW()
                WHERE sweep_txid = $1
              `, [w.tx_hash]);
            });
          } else if (sweepStatus.status === 'CONFIRMED' && sweepStatus.blockHash && sweepStatus.blockHash !== w.block_hash) {
            // Re-mined in a new canonical block
            logger.info(`[SweepStatusWorker] Sweep ${w.tx_hash} block hash updated from ${w.block_hash} to ${sweepStatus.blockHash}`);
            await db.query(`
              UPDATE sweep_transactions
              SET block_number = $1, block_hash = $2, updated_at = NOW()
              WHERE tx_hash = $3
            `, [sweepStatus.blockNumber ?? null, sweepStatus.blockHash, w.tx_hash]);
          }
        } catch (err: any) {
          logger.error(`[SweepStatusWorker] Reorg check error for sweep ${w.tx_hash}: ${err.message}`);
        }
      }
    } catch (err: any) {
      logger.error(`[SweepStatusWorker] Reorg verification query failed: ${err.message}`);
    }
  }
}

export const sweepStatusWorker = new SweepStatusWorker();
