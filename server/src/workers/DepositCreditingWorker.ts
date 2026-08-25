import { env } from '../config/env';
import { logger } from '../config/logger';
import { DepositCreditingService } from '../services/blockchain/deposit-crediting.service';

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

    const service = new DepositCreditingService();

    try {
      await service.processBacklog(50);
    } catch (err: any) {
      logger.error('DepositCreditingWorker: sweep failed', { error: err.message });
    }
  }
}

export const depositCreditingWorker = new DepositCreditingWorker();
