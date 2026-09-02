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
import { db } from '../../config/database';
import { isSupportedNetwork } from '../../models/asset-network.model';
import { ICustodyAdapter, ICustodyReadAdapter } from './custody-adapter';
import { LocalKmsMock } from './local-kms-mock';
import { KmsCustodyProvider } from './kms-custody-provider';
import { ManualSafeCustodyProvider } from './manual-safe-custody-provider';
import { MockCustodyProvider } from './mock-custody-provider';
import { KMSClient } from '@aws-sdk/client-kms';
import {
  CustodyError,
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
  GetOrCreateDepositAddressRequest,
  HOUSE_TREASURY_ACCOUNT_ID,
  TreasuryTransferRequest,
  WithdrawalRequest,
  ReplacementGasPolicy,
  SweepStatusResult,
} from './custody.types';

/** Physical Ethereum address shape — enforced on treasury destinations. */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

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
    if (err instanceof CustodyError) {
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

  public async getOrCreateDepositAddress(
    request: GetOrCreateDepositAddressRequest,
  ): Promise<DepositAddress> {
    const adapter = this.assertRead();
    this.validateAssetNetwork(request.asset, request.network);
    if (!adapter.hasCapability(CustodyProviderCapability.DEPOSIT_ADDRESS)) {
      throw new CustodyCapabilityUnavailableError(
        CustodyProviderCapability.DEPOSIT_ADDRESS,
        adapter.providerId,
      );
    }
    try {
      // Defense in depth: reject pairs the provider does not advertise as active.
      const supported = await adapter.getSupportedAssetNetworks();
      const pair = supported.find(
        (n) => n.asset === request.asset && n.network === request.network,
      );
      if (!pair || !pair.isActive) {
        throw new UnsupportedAssetNetworkError(request.asset, request.network, adapter.providerId);
      }
      return await adapter.getOrCreateDepositAddress(request);
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
    // Phase 10.4 (unfreeze): the CUSTOMER withdrawal operation must never carry
    // the HOUSE TREASURY principal. Treasury movements have a dedicated
    // operation (submitTreasuryTransfer) with separate artifacts and no
    // customer-table reach. This makes CUSTOMER ≠ TREASURY structurally
    // enforceable instead of a string convention.
    if (request.accountId === HOUSE_TREASURY_ACCOUNT_ID) {
      throw new InvalidCustodyRequestError(
        'Customer withdrawal operation rejects the HOUSE_TREASURY principal; use submitTreasuryTransfer',
      );
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

  // -------------------------------------------------------------------------
  // Phase 10.4 (unfreeze) — HOUSE TREASURY custody boundary
  // -------------------------------------------------------------------------

  /**
   * Dedicated treasury consolidation custody operation.
   *
   * - Requires the provider to advertise TREASURY_TRANSFER (fail closed).
   * - Rejects customer account principals outright (defense in depth: even a
   *   buggy caller cannot route a customer account through the treasury op).
   * - Destination MUST be an EVM address; the treasury layer owns the trust
   *   decision (trusted Safe anchor + on-chain verification) — the custody
   *   layer enforces execution safety (nonce, artifact, signature validation).
   * - providerReference in the result is the PHYSICAL blockchain tx hash.
   */
  public async submitTreasuryTransfer(request: TreasuryTransferRequest): Promise<WithdrawalRequest> {
    const adapter = this.assertWrite();
    if (!adapter.hasCapability(CustodyProviderCapability.TREASURY_TRANSFER)) {
      throw new CustodyCapabilityUnavailableError(
        CustodyProviderCapability.TREASURY_TRANSFER,
        adapter.providerId,
      );
    }
    if (!request.treasuryIntentId || request.treasuryIntentId.trim().length === 0) {
      throw new InvalidCustodyRequestError('treasuryIntentId is required for a treasury transfer');
    }
    this.validateAssetNetwork(request.asset, request.network);
    if (!request.amount || isNaN(Number(request.amount)) || Number(request.amount) <= 0) {
      throw new InvalidCustodyRequestError('treasury transfer amount must be a positive number');
    }
    if (!request.destinationAddress || !EVM_ADDRESS_RE.test(request.destinationAddress)) {
      throw new InvalidCustodyRequestError('treasury transfer destination must be a valid EVM address');
    }
    try {
      const result = await adapter.submitTreasuryTransfer!(request);
      logger.info('Treasury custody transfer submitted', {
        providerId: adapter.providerId,
        treasuryIntentId: request.treasuryIntentId,
        status: result.status,
      });
      return result;
    } catch (err) {
      this.normalizeError(err);
    }
  }

  /**
   * Status lookup for a treasury transfer by its immutable treasuryIntentId.
   * Mirrors getWithdrawalStatus but for the treasury artifact domain.
   */
  public async getTreasuryTransferStatus(treasuryIntentId: string): Promise<WithdrawalRequest> {
    const adapter = this.assertRead();
    if (
      !adapter.hasCapability(CustodyProviderCapability.TREASURY_TRANSFER) ||
      !adapter.getTreasuryTransferStatus
    ) {
      throw new CustodyCapabilityUnavailableError(
        CustodyProviderCapability.TREASURY_TRANSFER,
        adapter.providerId,
      );
    }
    try {
      return await adapter.getTreasuryTransferStatus(treasuryIntentId);
    } catch (err) {
      this.normalizeError(err);
    }
  }


  public async checkSweepStatus(txHash: string, network: string): Promise<SweepStatusResult> {
    const adapter = this.assertRead();
    if (!adapter.checkSweepStatus) {
      throw new Error("Provider does not support checkSweepStatus");
    }
    return adapter.checkSweepStatus(txHash, network);
  }

  public async sweepDepositAddress(network: string, depositAddress: string, asset: string, pendingSweepIds: string[]): Promise<string> {
    const adapter = this.assertWrite();
    if (!adapter.sweepDepositAddress) {
      throw new Error(`Provider ${adapter.providerId} does not support sweeping deposits`);
    }
    try {
      return await adapter.sweepDepositAddress(network, depositAddress, asset, pendingSweepIds);
    } catch (err) {
      this.normalizeError(err);
    }
  }

  /**
   * P2 (6E-4C-2): presence probe for a broadcast sweep transaction.
   * Preserves the typed provider result; normalizeError keeps CustodyError
   * semantics for callers.
   */
  public async getSweepTxPresence(
    txHash: string,
    network: string,
    expectedNonce?: number
  ): Promise<{ present: boolean; mined: boolean; nonceConsumed: boolean | null }> {
    const adapter = this.assertRead();
    if (!adapter.getSweepTxPresence) {
      throw new Error(`Provider ${adapter.providerId} does not support getSweepTxPresence`);
    }
    try {
      return await adapter.getSweepTxPresence(txHash, network, expectedNonce);
    } catch (err) {
      this.normalizeError(err);
    }
  }

  /**
   * P2 (6E-4C-2): physical-vs-database custody reconciliation for one
   * forwarder group. Operational only — records custody_reconciliation_events
   * through the provider; never mutates user-facing balances.
   */
  public async reconcileDepositAddress(
    network: string,
    address: string,
    asset: string
  ): Promise<{ expectedRemaining: string; physical: string; status: 'BALANCED' | 'EXTRA_FUNDS' | 'SHORTFALL' }> {
    const adapter = this.assertRead();
    if (!adapter.reconcileDepositAddress) {
      throw new Error(`Provider ${adapter.providerId} does not support reconcileDepositAddress`);
    }
    try {
      return await adapter.reconcileDepositAddress(network, address, asset);
    } catch (err) {
      this.normalizeError(err);
    }
  }

  public async replaceWithdrawal(clientWithdrawalId: string, gasPolicy: ReplacementGasPolicy): Promise<WithdrawalRequest> {
    const adapter = this.assertWrite();
    if (!adapter.replaceWithdrawal) {
      throw new Error(`Provider ${adapter.providerId} does not support speed-up replacements`);
    }
    try {
      return await adapter.replaceWithdrawal(clientWithdrawalId, gasPolicy);
    } catch (err) {
      this.normalizeError(err);
    }
  }

  public async cancelWithdrawal(clientWithdrawalId: string, gasPolicy: ReplacementGasPolicy): Promise<WithdrawalRequest> {
    const adapter = this.assertWrite();
    if (!adapter.cancelWithdrawal) {
      throw new Error(`Provider ${adapter.providerId} does not support cancellation`);
    }
    try {
      return await adapter.cancelWithdrawal(clientWithdrawalId, gasPolicy);
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

  let adapter: ICustodyAdapter | null = null;

  if (env.CUSTODY_ENABLED) {
    const providerStr = env.CUSTODY_PROVIDER || (env.NODE_ENV !== 'production' ? 'mock' : undefined);
    const isProduction = env.NODE_ENV === 'production';

    if (!providerStr) {
      throw new Error("CUSTODY_PROVIDER must be explicitly configured in production (e.g., 'manual_safe')");
    }

    if (providerStr === 'mock') {
      if (isProduction) {
        throw new Error("CUSTODY_PROVIDER='mock' is forbidden in production environment");
      }
      adapter = new MockCustodyProvider();
    } else if (providerStr === 'local_kms') {
      if (isProduction) {
        throw new Error("CUSTODY_PROVIDER='local_kms' is forbidden in production environment");
      }
      const rpcUrl = env.CUSTODY_EVM_RPC_URL || 'http://127.0.0.1:8545';
      const keyId = env.CUSTODY_KMS_KEY_ID || 'mock-key-id';
      const config = {
          'ETHEREUM': { rpcUrl, keyId, chainId: 31337n }
      };
      const mockKms = new LocalKmsMock();
      adapter = new KmsCustodyProvider(mockKms as any, config, db);
    } else if (providerStr === 'kms') {
      // Phase 11K — KMS is explicitly FORBIDDEN in production. The manual
      // deployment MUST NOT silently fall back to automatic server-side
      // signing. KMS remains available only for explicit development/test use.
      if (isProduction) {
        throw new Error("CUSTODY_PROVIDER='kms' is forbidden in production environment (use 'manual_safe')");
      }

      const rpcUrl = env.CUSTODY_EVM_RPC_URL;
      if (!rpcUrl) {
        throw new Error("CUSTODY_EVM_RPC_URL is required when using kms provider");
      }

      // Prohibit localhost RPC in production
      if (isProduction) {
        try {
            const parsedUrl = new URL(rpcUrl);
            const host = parsedUrl.hostname.toLowerCase();
            if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]') {
              throw new Error("Localhost RPC is forbidden in production environment");
            }
        } catch (e: any) {
            if (e.message.includes('forbidden in production environment')) throw e;
            throw new Error(`Invalid CUSTODY_EVM_RPC_URL: ${e.message}`);
        }
      }

      const keyId = env.CUSTODY_KMS_KEY_ID;
      if (!keyId) {
        throw new Error("CUSTODY_KMS_KEY_ID is required when using kms provider");
      }

      // Chain ID is hardcoded here per network. In real life we'd load this from network registry.
      const config = {
          'ETHEREUM': {
              rpcUrl,
              keyId,
              chainId: isProduction ? 1n : 11155111n
          }
      };

      const region = env.CUSTODY_KMS_REGION || 'us-east-1';
      // AWS SDK will automatically resolve credentials from environment at runtime.
      const kmsClient = new KMSClient({ region });
      adapter = new KmsCustodyProvider(kmsClient, config, db);
    } else if (providerStr === 'manual_safe') {
      // Phase 11K — the production manual Safe mode. No KMS, no signing, no
      // broadcast, no outbound nonce allocation. Execution is performed by a
      // human (Safe 1-of-1 / MetaMask / cold EOA) and verified read-only.
      adapter = new ManualSafeCustodyProvider(db);
    } else {
      throw new Error(`Unknown CUSTODY_PROVIDER: ${providerStr}`);
    }
  }

  return new CustodyService({
    enabled: env.CUSTODY_ENABLED,
    adapter,
  });
}

export const custodyService = createCustodyService();
