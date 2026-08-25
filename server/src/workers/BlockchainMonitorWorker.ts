/**
 * Phase 9.4 — Blockchain Monitor Worker
 *
 * Polls the configured blockchain source(s) for new blocks and persists
 * normalized deposit observations to blockchain_deposits.
 *
 * IMPORTANT:
 * - Inert (no network) unless a blockchain source is explicitly configured.
 * - Follows the existing WorkerSupervisor pattern: start() → setInterval,
 *   stop() → clearInterval, isRunning guard.
 */

import { logger } from '../config/logger';
import { IBlockchainSource } from '../services/blockchain/types';
import { BlockchainMonitorService } from '../services/blockchain/blockchain-monitor.service';
import { circuitBreakerService } from '../services/system/circuit-breaker.service';
import { threatAlertService } from '../services/compliance/threat-alert.service';
import { db } from '../config/database';

export class BlockchainMonitorWorker {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly source: IBlockchainSource | null,
    private readonly pollIntervalMs: number = 1000 * 30, // 30 seconds
  ) {}

  public start(): void {
    if (this.isRunning) return;

    if (!this.source) {
      logger.info('BlockchainMonitorWorker: no blockchain source configured — staying inert (no network)');
      return;
    }

    this.isRunning = true;
    logger.info('BlockchainMonitorWorker: starting', {
      source: this.source.displayName,
      intervalMs: this.pollIntervalMs,
    });

    // Run initial sweep immediately
    this.sweep().catch(err => {
      logger.error('BlockchainMonitorWorker: startup sweep error', { error: err });
    });

    this.intervalId = setInterval(() => {
      this.sweep().catch(err => {
        logger.error('BlockchainMonitorWorker: loop error', { error: err });
      });
    }, this.pollIntervalMs);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('BlockchainMonitorWorker: stopped');
    }
  }

  private async sweep(): Promise<void> {
    if (!this.isRunning || !this.source) return;

    const monitor = new BlockchainMonitorService(
      db,
      this.source,
      circuitBreakerService,
      threatAlertService,
    );

    try {
      await monitor.runOnce();
    } catch (err: any) {
      logger.error('BlockchainMonitorWorker: sweep failed', {
        source: this.source.displayName,
        error: err.message,
      });
    }
  }
}

/**
 * Singleton instance. No blockchain source is configured at boot — the worker
 * remains inert (no network) until an explicit source is provided (Phase 9.12+).
 */
export const blockchainMonitorWorker = new BlockchainMonitorWorker(null);