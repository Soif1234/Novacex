/**
 * Phase 9.2 — Custody Abstraction Layer (CAL)
 *
 * NovaCEX's provider-neutral custody service. It depends ONLY on the
 * ICustodyAdapter interface — never on provider-specific classes — so a real
 * custody provider can be swapped in later without modifying the CAL, ledger,
 * wallet, or trading engine.
 *
 * Fail-closed semantics:
 * - When CUSTODY_ENABLED=false, EVERY CAL operation throws CustodyDisabledError.
 * - Write operations additionally require the provider to advertise the
 *   WITHDRAWAL_REQUEST capability (capability-gated writes).
 *
 * Phase 9.2 rules honored here:
 * - No blockchain calls, no network calls, no private keys, no credentials.
 * - Mock custody activity NEVER touches wallet_balances, ledger_entries,
 *   ledger_transactions, orders, trades, or futures_positions.
 * - No automatic crediting/debiting of users from the mock provider.
 */

import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { isSupportedNetwork } from '../../models/asset-network.model';
import { ICustodyAdapter, ICustodyReadAdapter } from './custody-adapter';
import {
  CustodyDisabledError,
  CustodyOperationRejectedError,
  CustodyCapabilityUnavailableError,
  InvalidCustodyRequestError,
  ProviderUnavailableError,
  UnsupportedAssetNetworkError,
} from './custody.errors';
import {
  CustodyAccount,
  CustodyAssetNetwork,
  CustodyBalance,
  CustodyProviderCapability,
  CustodyProviderHealth,
  CustodyTransaction,
  CustodyTransactionStatus,
  DepositAddress,
  WithdrawalRequest,
} from './custody.types';

/** Internal wiring — which capabilities are available when enabled. */
export interface CustodyServiceOptions {
  enabled: boolean;
  adapter: ICustodyAdapter | null;
}

export class CustodyService {
  private readonly enabled: boolean;
  private readonly adapter: ICustodyAdapter | null;

  constructor(options: CustodyServiceOptions) {
    this.enabled = options.enabled;
    this.adapter = options.adapter;
  }

  // -------------------------------------------------------------------------
  // Public status
  // -------------------------------------------------------------------------

  public isEnabled(): boolean {
    return this.enabled && this.adapter !== null;
  }

  public getProviderId(): string | null {
    return this.adapter ? this.adapter.providerId : null;
  }

  // -------------------------------------------------------------------------
  // Guards
  // -------------------------------------------------------------------------

  private assertEnabled(): ICustodyAdapter {
    if (!this.enabled || this.adapter === null) {
      throw new CustodyDisabledError();
    }
    return this.adapter;
  }

  private assertRead(): ICustodyReadAdapter {
    return this.assertEnabled();
  }

  private assertWrite(): ICustodyAdapter {
    const adapter = this.assertEnabled();
    if (!adapter.hasCapability(CustodyProviderCapability.WITHDRAWAL_REQUEST)) {
      throw new CustodyCapabilityUnavailableError(
        CustodyProviderCapability.WITHDRAWAL_REQUEST,
        adapter.providerId,
      );
    }
    return adapter;
  }

  /** Validate asset/network identifiers against the Phase 9.1 registry. */
  private validateAssetNetwork(asset: string, network: string): void {
    if (!asset || typeof asset !== 'string' || asset.trim().length === 0) {
      throw new InvalidCustodyRequestError('asset must be a non-empty string');
    }
    if (!network || typeof network !== 'string' || network.trim().length === 0) {
      throw new InvalidCustodyRequestError('network must be a non-empty string');
    }
    if (!isSupportedNetwork(network)) {
      throw new UnsupportedAssetNetworkError(asset, network);
    }
  }

  /** Normalize any thrown error into a provider-neutral CustodyError. */
  private normalizeError(err: unknown): never {
    if (err instanceof Error && err.name.startsWith('Custody')) {
      throw err;
    }
    logger.error('Custody provider operation failed', {
      providerId: this.adapter?.providerId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new ProviderUnavailableError(this.adapter?.providerId ?? 'unknown');
  }

  // -------------------------------------------------------------------------
  // Read operations (provider-neutral)
  // -------------------------------------------------------------------------

  public async getHealth(): Promise<CustodyProviderHealth> {
    const adapter = this.assertRead();
    try {
      return await adapter.healthCheck();
    } catch (err) {
      this.normalizeError(err);
    }
  }

  public async getSupportedAssetNetworks(): Promise<CustodyAssetNetwork[]> {
    const adapter = this.assertRead();
    if (!adapter.hasCapability(CustodyProviderCapability.ASSET_NETWORK_LOOKUP)) {
      throw new CustodyCapabilityUnavailableError(
        CustodyProviderCapability.ASSET_NETWORK_LOOKUP,
        adapter.providerId,
      );
    }
    try {
      return await adapter.getSupportedAssetNetworks();
    } catch (err) {
      this.normalizeError(err);
    }
  }

  public async getAccounts(): Promise<CustodyAccount[]> {
    const adapter = this.assertRead();
    try {
      return await adapter.getAccounts();
    } catch (err) {
      this.normalizeError(err);
    }
  }

  public async getBalances(accountId?: string): Promise<CustodyBalance[]> {
    const adapter = this.assertRead();
    if (!adapter.hasCapability(CustodyProviderCapability.BALANCE_QUERY)) {
      throw new CustodyCapabilityUnavailableError(
        CustodyProviderCapability.BALANCE_QUERY,
        adapter.providerId,
      );
    }
    try {
      return await adapter.getBalances(accountId);
    } catch (err) {
      this.normalizeError(err);
    }
  }

  public async getDepositAddress(asset: string, network: string, accountId: string): Promise<DepositAddress> {
    const adapter = this.assertRead();
    this.validateAssetNetwork(asset, network);
    if (!adapter.hasCapability(CustodyProviderCapability.DEPOSIT_ADDRESS)) {
      throw new CustodyCapabilityUnavailableError(
        CustodyProviderCapability.DEPOSIT_ADDRESS,
        adapter.providerId,
      );
    }
    try {
      return await adapter.getDepositAddress(asset, network, accountId);
    } catch (err) {
      this.normalizeError(err);
    }
  }

  public async getWithdrawalStatus(clientWithdrawalId: string): Promise<WithdrawalRequest> {
    const adapter = this.assertRead();
    if (!adapter.hasCapability(CustodyProviderCapability.WITHDRAWAL_STATUS)) {
      throw new CustodyCapabilityUnavailableError(
        CustodyProviderCapability.WITHDRAWAL_STATUS,
        adapter.providerId,
      );
    }
    try {
      return await adapter.getWithdrawalStatus(clientWithdrawalId);
    } catch (err) {
      this.normalizeError(err);
    }
  }

  public async getTransaction(providerTransactionId: string): Promise<CustodyTransaction> {
    const adapter = this.assertRead();
    if (!adapter.hasCapability(CustodyProviderCapability.TRANSACTION_LOOKUP)) {
      throw new CustodyCapabilityUnavailableError(
        CustodyProviderCapability.TRANSACTION_LOOKUP,
        adapter.providerId,
      );
    }
    try {
      return await adapter.getTransaction(providerTransactionId);
    } catch (err) {
      this.normalizeError(err);
    }
  }

  // -------------------------------------------------------------------------
  // Write operations (SIMULATED ONLY in Phase 9.2)
  // -------------------------------------------------------------------------

  /**
   * Request a simulated custody withdrawal.
   * NEVER debits a user, NEVER touches the ledger, NEVER broadcasts on-chain.
   * The mock records the request in its isolated state only.
   */
  public async requestWithdrawal(request: WithdrawalRequest): Promise<WithdrawalRequest> {
    const adapter = this.assertWrite();
    this.validateAssetNetwork(request.asset, request.network);
    if (!request.clientWithdrawalId || request.clientWithdrawalId.trim().length === 0) {
      throw new InvalidCustodyRequestError('clientWithdrawalId is required for a withdrawal request');
    }
    if (!request.destinationAddress || request.destinationAddress.trim().length === 0) {
      throw new InvalidCustodyRequestError('destinationAddress is required for a withdrawal request');
    }
    try {
      const result = await adapter.requestWithdrawal(request);
      logger.info('Mock custody withdrawal requested (simulated, no funds moved)', {
        providerId: adapter.providerId,
        clientWithdrawalId: result.clientWithdrawalId,
        asset: result.asset,
        network: result.network,
      });
      return result;
    } catch (err) {
      this.normalizeError(err);
    }
  }

  /**
   * Advance the status of a mock custody transaction (test/simulation helper).
   * Phase 9.2 only — real providers report status via lookups, not via CAL.
   */
  public async updateTransactionStatus(
    providerTransactionId: string,
    status: CustodyTransactionStatus,
  ): Promise<CustodyTransaction> {
    const adapter = this.assertWrite();
    try {
      return await adapter.updateTransactionStatus(providerTransactionId, status);
    } catch (err) {
      this.normalizeError(err);
    }
  }
}

// ---------------------------------------------------------------------------
// Lazy singleton — constructed from the environment. When CUSTODY_ENABLED is
// false (the default and production-required state) no adapter is constructed
// and every CAL operation fails closed with CustodyDisabledError.
// ---------------------------------------------------------------------------

export function createCustodyService(options?: Partial<CustodyServiceOptions>): CustodyService {
  if (options) {
    return new CustodyService({
      enabled: options.enabled ?? false,
      adapter: options.adapter ?? null,
    });
  }
  return new CustodyService({
    enabled: env.CUSTODY_ENABLED,
    adapter: null, // Phase 9.2: never auto-construct a provider at boot
  });
}

export const custodyService = createCustodyService();
