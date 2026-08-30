import { env } from '../config/env';
import { logger } from '../config/logger';
import { DepositCreditingService } from '../services/blockchain/deposit-crediting.service';
import { pendingSweepProducer } from '../services/custody/pending-sweep-producer.service';

export class DepositCreditingWorker {
  private intervalId: NodeJS.Timeout | null = null;
  public isRunning = false;

  constructor(
    private readonly pollIntervalMs: number = 60000,
  ) {}

  public start(): void {
    if (this.isRunning) return;

    if (!env.DEPOSIT_CREDITING_ENABLED) {
      logger.info('DepositCreditingWorker: DEPOSIT_CREDITING_ENABLED is false, staying inert');
      return;
    }

    this.isRunning = true;
    logger.info('DepositCreditingWorker: starting', { intervalMs: this.pollIntervalMs });

    this.sweep().catch(err => {
      logger.error('DepositCreditingWorker: startup sweep error', { error: err });
    });

    this.intervalId = setInterval(() => {
      this.sweep().catch(err => {
        logger.error('DepositCreditingWorker: loop error', { error: err });
      });
    }, this.pollIntervalMs);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('DepositCreditingWorker: stopped');
    }
  }

  private async sweep(): Promise<void> {
    if (!this.isRunning || !env.DEPOSIT_CREDITING_ENABLED) return;

    // Phase 10.4 Step 6E-4C-2 (P1): produce pending_sweeps for confirmed
    // deposits. STRICTLY independent of crediting — a producer failure must
    // never block or corrupt financial crediting, and crediting is never
    // gated on sweep production. The producer is idempotent
    // (UNIQUE(deposit_id) + ON CONFLICT DO NOTHING).
    if (env.CUSTODY_SWEEPABLE_NETWORKS && env.CUSTODY_SWEEPABLE_NETWORKS.trim().length > 0) {
      try {
        await pendingSweepProducer.producePendingSweeps(500);
      } catch (err: any) {
        logger.error('DepositCreditingWorker: pending-sweep production failed (crediting unaffected)', { error: err.message });
      }
    }

    const service = new DepositCreditingService();

    try {
      await service.processBacklog(50);
    } catch (err: any) {
      logger.error('DepositCreditingWorker: sweep failed', { error: err.message });
    }
  }
}

export const depositCreditingWorker = new DepositCreditingWorker();
