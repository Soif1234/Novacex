import { env } from '../config/env';
import { logger } from '../config/logger';
import { withdrawalService } from '../services/wallet/withdrawal.service';
import { custodyService } from '../services/custody/custody.service';
import { circuitBreakerService } from '../services/system/circuit-breaker.service';

export class WithdrawalStatusWorker {
  private intervalId: NodeJS.Timeout | null = null;
  public isRunning = false;

  constructor(private readonly pollIntervalMs: number = 10000) {}

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info(`WithdrawalStatusWorker started (interval: ${this.pollIntervalMs}ms)`);
    this.intervalId = setInterval(() => this.execute().catch((err) => {
      logger.error(`WithdrawalStatusWorker error: ${err.message}`);
    }), this.pollIntervalMs);
  }

  public stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    logger.info('WithdrawalStatusWorker stopped');
  }

  private async execute(): Promise<void> {
    if (!env.CRYPTO_WITHDRAWALS_ENABLED) {
      return;
    }

    const withdrawBreaker = await circuitBreakerService.isSubsystemOperational('WITHDRAWALS');

    if (!withdrawBreaker.operational) {
      logger.warn('[WithdrawalStatusWorker] Circuit breaker open, skipping status updates');
      return;
    }

    const batch = await withdrawalService.getActiveCustodyWithdrawals(50);

    for (const w of batch) {
      const b1 = await circuitBreakerService.isSubsystemOperational('WITHDRAWALS');
      if (!b1.operational) {
        break; // Stop processing mid-batch if breaker opens
      }

      try {
        const custodyResult = await custodyService.getWithdrawalStatus(w.id);
        
        switch (custodyResult.status) {
          case 'CONFIRMED':
            await withdrawalService.completeWithdrawal(w.id, custodyResult.providerReference || '');
            break;
          case 'FAILED':
          case 'REJECTED':
          case 'REVERSED':
            await withdrawalService.failWithdrawal(w.id, 'Custody provider rejection');
            break;
          case 'BROADCAST':
          case 'SIGNING':
          case 'PENDING':
            // If the state advanced (e.g. SUBMITTED -> BROADCAST), update our local tracker
            if (custodyResult.status !== w.cryptoStatus && custodyResult.status !== 'PENDING') {
              await withdrawalService.updateCryptoStatus(w.id, custodyResult.status);
            }
            break;
        }
      } catch (err: any) {
        logger.error(`[WithdrawalStatusWorker] Failed to check status for ${w.id}: ${err.message}`);
      }
    }
  }
}

export const withdrawalStatusWorker = new WithdrawalStatusWorker();
