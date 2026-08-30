import { env } from '../config/env';
import { logger } from '../config/logger';
import { withdrawalService } from '../services/wallet/withdrawal.service';
import { custodyService } from '../services/custody/custody.service';
import { WithdrawalRequest } from '../services/custody/custody.types';
import { circuitBreakerService } from '../services/system/circuit-breaker.service';

export class WithdrawalProcessingWorker {
  private intervalId: NodeJS.Timeout | null = null;
  public isRunning = false;

  constructor(private readonly pollIntervalMs: number = 5000) {}

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info(`WithdrawalProcessingWorker started (interval: ${this.pollIntervalMs}ms)`);
    this.intervalId = setInterval(() => this.execute().catch((err) => {
      logger.error(`WithdrawalProcessingWorker error: ${err.message}`);
    }), this.pollIntervalMs);
  }

  public stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    logger.info('WithdrawalProcessingWorker stopped');
  }

  private async execute(): Promise<void> {
    if (!env.CRYPTO_WITHDRAWALS_ENABLED) {
      return;
    }

    const withdrawBreaker = await circuitBreakerService.isSubsystemOperational('WITHDRAWALS');

    if (!withdrawBreaker.operational) {
      logger.warn('[WithdrawalProcessingWorker] Circuit breaker open, skipping processing');
      return;
    }

    const batch = await withdrawalService.claimApprovedWithdrawals(20);

    for (const w of batch) {
      const b1 = await circuitBreakerService.isSubsystemOperational('WITHDRAWALS');
      if (!b1.operational) {
        break; // Stop processing mid-batch if breaker opens
      }

      try {
        const custodyRequest: WithdrawalRequest = {
          clientWithdrawalId: w.id,
          accountId: w.accountId,
          asset: w.asset,
          network: w.network!,
          amount: w.amount,
          destinationAddress: w.destinationAddress,
          destinationMemo: w.destinationMemo,
          status: 'PENDING',
          createdAt: w.createdAt,
          updatedAt: w.updatedAt
        };

        const result = await custodyService.requestWithdrawal(custodyRequest);
        const providerId = custodyService.getProviderId();
        if (providerId && result.providerWithdrawalId) {
          await withdrawalService.markAsSubmitted(w.id, providerId, result.providerWithdrawalId);
        } else {
          await withdrawalService.updateCryptoStatus(w.id, 'UNKNOWN');
        }
      } catch (err: any) {
        logger.error(`[WithdrawalProcessingWorker] Failed to process withdrawal ${w.id}: ${err.message}`);
        await withdrawalService.updateCryptoStatus(w.id, 'UNKNOWN');
      }
    }
  }
}

export const withdrawalProcessingWorker = new WithdrawalProcessingWorker();
