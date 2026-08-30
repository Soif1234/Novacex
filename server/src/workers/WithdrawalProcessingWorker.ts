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
    const stuckBatch = await withdrawalService.claimStuckWithdrawals(5, 5); // 5 records, older than 5 minutes

    const allWithdrawals = [...batch, ...stuckBatch];

    for (const w of allWithdrawals) {
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
          // No provider reference returned. Reverting blindly to APPROVED is
          // only safe when no nonce was durably reserved during the attempt.
          await this.handleProcessingFailure(w.id, null);
        }
      } catch (err: any) {
        logger.error(`[WithdrawalProcessingWorker] Failed to process withdrawal ${w.id}: ${err.message}`);
        await this.handleProcessingFailure(w.id, err);
      }
    }
  }

  /**
   * Phase 10.4 Step 6E-4C-2 (P1 regression fix): state-aware failure handling.
   *
   * The previous implementation reverted EVERY failure to APPROVED. That is
   * safe only BEFORE a nonce reservation. Once the provider has reserved a
   * nonce (persisted atomically as withdrawals.network_nonce), reverting to
   * APPROVED causes the next attempt to allocate a FRESH nonce, burning the
   * reserved one — a permanent gap in the shared hot-wallet nonce sequence
   * that blocks ALL later hot-wallet transactions.
   *
   * State model (re-read at failure time — claim snapshots are stale):
   *  - network_nonce != null (reserved): NEVER revert to APPROVED. Normalize
   *    to SIGNING (recoverable: the provider reuses the reserved nonce with
   *    on-chain latest/pending guards, and any persisted artifact is
   *    recovered and rebroadcast exactly). If the row is already in a
   *    custody-owned state (BROADCAST/CONFIRMED), leave it untouched.
   *  - network_nonce == null (nothing reserved): timeout-style errors are
   *    AMBIGUOUS (the request may have reached the provider) → UNKNOWN
   *    (funds locked, manual/stuck-claim recovery path). Other errors are
   *    provably local → APPROVED (safe retry).
   */
  private async handleProcessingFailure(id: string, err: any): Promise<void> {
    const msg = String(err?.message || err || '');
    const ambiguous = /timeout|timed out|ETIMEDOUT|ECONNRESET|socket hang up/i.test(msg);

    let state: { crypto_status: string | null; network_nonce: number | null } | null = null;
    try {
      state = await withdrawalService.getCryptoState(id);
    } catch (readErr: any) {
      logger.error(`[WithdrawalProcessingWorker] Failed to read custody state for withdrawal ${id}: ${readErr.message}`);
    }

    if (state) {
      // Custody-owned terminal/in-flight states must never be overwritten.
      if (state.crypto_status === 'BROADCAST' || state.crypto_status === 'CONFIRMED' || state.crypto_status === 'SUBMITTED') {
        return;
      }

      if (state.network_nonce != null) {
        // Nonce durably reserved: never APPROVED, never a fresh allocation.
        if (state.crypto_status !== 'SIGNING') {
          await withdrawalService.updateCryptoStatus(id, 'SIGNING');
        }
        return;
      }

      if (state.crypto_status === 'SIGNING' && state.network_nonce == null) {
        // Inconsistent row (SIGNING without nonce): surface for stuck-claim
        // recovery rather than auto-retrying into an unknown nonce.
        await withdrawalService.updateCryptoStatus(id, 'UNKNOWN');
        return;
      }

      if (ambiguous) {
        // Ambiguous pre-reservation failure: the request may have partially
        // succeeded — funds stay locked under UNKNOWN.
        await withdrawalService.updateCryptoStatus(id, 'UNKNOWN');
        return;
      }

      // Provably-local, pre-reservation failure: safe retry via APPROVED.
      await withdrawalService.updateCryptoStatus(id, 'APPROVED');
      return;
    }

    // State read unavailable (DB trouble). Conservative fallback: never
    // APPROVED into a possible reserved-nonce burn. UNKNOWN is safe in both
    // worlds — the stuck-claim path re-claims it after 5 minutes and the
    // provider now reuses any reserved nonce in UNKNOWN state (guarded by
    // on-chain latest/pending nonce checks).
    await withdrawalService.updateCryptoStatus(id, 'UNKNOWN');
  }
}

export const withdrawalProcessingWorker = new WithdrawalProcessingWorker();
