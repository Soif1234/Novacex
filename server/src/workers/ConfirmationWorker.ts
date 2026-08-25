/**
 * Phase 9.4 — Confirmation Worker
 *
 * Periodically updates confirmation_count for CONFIRMING deposits and
 * transitions CONFIRMING → CONFIRMED when the threshold is reached.
 *
 * IMPORTANT:
 * - Inert (no network) unless a blockchain source is explicitly configured.
 * - Follows the existing WorkerSupervisor pattern: start() → setInterval,
 *   stop() → clearInterval, isRunning guard.
 */

import { logger } from '../config/logger';
import { IBlockchainSource } from '../services/blockchain/types';
import { ConfirmationWorkerService } from '../services/blockchain/confirmation-worker.service';
import { db } from '../config/database';

export class ConfirmationWorker {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly source: IBlockchainSource | null,
    private readonly pollIntervalMs: number = 1000 * 60, // 60 seconds
  ) {}

  public start(): void {
    if (this.isRunning) return;

    if (!this.source) {
      logger.info('ConfirmationWorker: no blockchain source configured — staying inert (no network)');
      return;
    }

    this.isRunning = true;
    logger.info('ConfirmationWorker: starting', {
      source: this.source?.displayName ?? 'unknown',
      intervalMs: this.pollIntervalMs,
    });

    // Run initial sweep immediately
    this.sweep().catch(err => {
      logger.error('ConfirmationWorker: startup sweep error', { error: err });
    });

    this.intervalId = setInterval(() => {
      this.sweep().catch(err => {
        logger.error('ConfirmationWorker: loop error', { error: err });
      });
    }, this.pollIntervalMs);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('ConfirmationWorker: stopped');
    }
  }

  private async sweep(): Promise<void> {
    if (!this.isRunning || !this.source) return;

    const service = new ConfirmationWorkerService(db, this.source);

    try {
      await service.runOnce();
    } catch (err: any) {
      logger.error('ConfirmationWorker: sweep failed', {
        source: this.source?.displayName ?? 'unknown',
        error: err.message,
      });
    }
  }
}

/**
 * Singleton instance. No blockchain source is configured at boot — the worker
 * remains inert (no network) until an explicit source is provided (Phase 9.12+).
 */
export const confirmationWorker = new ConfirmationWorker(null);