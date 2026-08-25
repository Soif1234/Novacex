/**
 * Phase 9.2 — MockCustodyProvider
 *
 * A deterministic, fully in-memory, network-free custody provider for
 * development and tests. It implements ICustodyAdapter and represents the
 * FUTURE lifecycle of real custody operations WITHOUT any real blockchain
 * activity, private keys, secrets, or NovaCEX financial state mutation.
 *
 * Safety properties:
 * - No network calls, no blockchain calls, no signing, no secrets.
 * - Explicit fake provider identity (providerId = 'MOCK_CUSTODY').
 * - State is isolated inside this instance only.
 * - Test data is injectable/configurable via constructor options.
 * - Mock balances/withdrawals are MOCK PROVIDER OBJECTS ONLY; they are never
 *   converted into NovaCEX wallet_balances or ledger entries.
 */

import crypto from 'crypto';
import {
  ICustodyAdapter,
} from './custody-adapter';
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
import {
  CustodyTransactionNotFoundError,
  CustodyOperationRejectedError,
  InvalidCustodyRequestError,
} from './custody.errors';

export interface MockCustodyProviderOptions {
  /** Default asset/network support. Defaults to the Phase 9.1 approved pairs. */
  supportedAssetNetworks?: CustodyAssetNetwork[];
  /** Initial custody-side balances keyed by `accountId|asset|network`. */
  initialBalances?: CustodyBalance[];
  /** Mock is healthy unless set to false (for failure-path tests). */
  healthy?: boolean;
  /** Simulated latency in ms, returned in health checks. Default 0. */
  latencyMs?: number;
}

/**
 * Deterministic address generator for the mock. Produces a stable, fake
 * address per (asset, network, accountId) so repeat lookups are idempotent
 * without any real key material.
 */
function mockAddress(asset: string, network: string, accountId: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(`mock-custody:${asset}:${network}:${accountId}`)
    .digest('hex')
    .slice(0, 24)
    .toUpperCase();
  return `MOCK_${network}_${hash}`;
}

export class MockCustodyProvider implements ICustodyAdapter {
  public readonly providerId = 'MOCK_CUSTODY';
  public readonly isMock = true as const;

  private readonly supported: CustodyAssetNetwork[];
  private readonly balances = new Map<string, CustodyBalance>();
  private readonly accounts = new Map<string, CustodyAccount>();
  private readonly addresses = new Map<string, DepositAddress>();
  private readonly withdrawals = new Map<string, WithdrawalRequest>();
  private readonly transactions = new Map<string, CustodyTransaction>();

  private healthy: boolean;
  private latencyMs: number;

  constructor(options: MockCustodyProviderOptions = {}) {
    this.healthy = options.healthy ?? true;
    this.latencyMs = options.latencyMs ?? 0;
    this.supported = options.supportedAssetNetworks?.length
      ? options.supportedAssetNetworks
      : defaultMockAssetNetworks();

    for (const b of options.initialBalances ?? []) {
      this.balances.set(balanceKey(b.accountId, b.asset, b.network), { ...b });
    }
  }

  // -------------------------------------------------------------------------
  // Capabilities
  // -------------------------------------------------------------------------

  public getCapabilities(): CustodyProviderCapability[] {
    return [
      CustodyProviderCapability.HEALTH,
      CustodyProviderCapability.BALANCE_QUERY,
      CustodyProviderCapability.ASSET_NETWORK_LOOKUP,
      CustodyProviderCapability.DEPOSIT_ADDRESS,
      CustodyProviderCapability.WITHDRAWAL_REQUEST,
      CustodyProviderCapability.WITHDRAWAL_STATUS,
      CustodyProviderCapability.TRANSACTION_LOOKUP,
    ];
  }

  public hasCapability(capability: CustodyProviderCapability): boolean {
    return this.getCapabilities().includes(capability);
  }

  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  public async healthCheck(): Promise<CustodyProviderHealth> {
    return {
      providerId: this.providerId,
      healthy: this.healthy,
      latencyMs: this.latencyMs,
      detail: this.healthy ? 'mock custody provider healthy' : 'mock custody provider unhealthy (injected)',
      checkedAt: new Date(),
    };
  }

  public async getSupportedAssetNetworks(): Promise<CustodyAssetNetwork[]> {
    return this.supported.map((n) => ({ ...n }));
  }

  public async getAccounts(): Promise<CustodyAccount[]> {
    return Array.from(this.accounts.values()).map((a) => ({ ...a }));
  }

  public async getBalances(accountId?: string): Promise<CustodyBalance[]> {
    const all = Array.from(this.balances.values());
    const filtered = accountId ? all.filter((b) => b.accountId === accountId) : all;
    return filtered.map((b) => ({ ...b }));
  }

  public async getDepositAddress(asset: string, network: string, accountId: string): Promise<DepositAddress> {
    const key = `${accountId}|${asset}|${network}`;
    const existing = this.addresses.get(key);
    if (existing) return { ...existing };

    const supported = this.supported.find(
      (n) => n.asset === asset && n.network === network && n.isActive,
    );
    if (!supported) {
      throw new InvalidCustodyRequestError(
        `Cannot create deposit address: asset/network "${asset}/${network}" is not supported by mock custody`,
        { asset, network, accountId },
      );
    }

    const address: DepositAddress = {
      address: mockAddress(asset, network, accountId),
      asset,
      network,
      accountId,
      requiresMemo: supported.requiresMemo,
      memo: supported.requiresMemo ? `NOVA-${accountId.slice(0, 8)}` : undefined,
      createdAt: new Date(),
    };
    this.addresses.set(key, address);
    return { ...address };
  }

  public async getWithdrawalStatus(clientWithdrawalId: string): Promise<WithdrawalRequest> {
    const w = this.withdrawals.get(clientWithdrawalId);
    if (!w) {
      throw new CustodyTransactionNotFoundError(clientWithdrawalId);
    }
    return { ...w };
  }

  public async getTransaction(providerTransactionId: string): Promise<CustodyTransaction> {
    const t = this.transactions.get(providerTransactionId);
    if (!t) {
      throw new CustodyTransactionNotFoundError(providerTransactionId);
    }
    return { ...t };
  }

  // -------------------------------------------------------------------------
  // Write operations (SIMULATED — never broadcast, never touch the ledger)
  // -------------------------------------------------------------------------

  public async requestWithdrawal(request: WithdrawalRequest): Promise<WithdrawalRequest> {
    if (request.amount === '0' || Number(request.amount) <= 0) {
      throw new InvalidCustodyRequestError('Withdrawal amount must be positive', {
        amount: request.amount,
      });
    }

    const supported = this.supported.find(
      (n) => n.asset === request.asset && n.network === request.network && n.isActive,
    );
    if (!supported) {
      throw new InvalidCustodyRequestError(
        `Mock withdrawal rejected: asset/network "${request.asset}/${request.network}" is not supported`,
        { asset: request.asset, network: request.network },
      );
    }

    if (this.withdrawals.has(request.clientWithdrawalId)) {
      // Idempotent: a duplicate request with the same client id returns the
      // existing simulated withdrawal instead of creating a second one.
      return { ...this.withdrawals.get(request.clientWithdrawalId)! };
    }

    const providerWithdrawalId = crypto.randomUUID();
    const now = new Date();
    const withdrawal: WithdrawalRequest = {
      ...request,
      providerWithdrawalId,
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
      providerReference: `mock-wd-${providerWithdrawalId}`,
    };
    this.withdrawals.set(request.clientWithdrawalId, withdrawal);

    const tx: CustodyTransaction = {
      providerTransactionId: providerWithdrawalId,
      direction: 'WITHDRAWAL',
      asset: request.asset,
      network: request.network,
      amount: request.amount,
      status: 'PENDING',
      address: request.destinationAddress,
      createdAt: now,
      updatedAt: now,
      providerReference: withdrawal.providerReference,
    };
    this.transactions.set(providerWithdrawalId, tx);

    return { ...withdrawal };
  }

  public async updateTransactionStatus(
    providerTransactionId: string,
    status: CustodyTransactionStatus,
  ): Promise<CustodyTransaction> {
    const tx = this.transactions.get(providerTransactionId);
    if (!tx) {
      throw new CustodyTransactionNotFoundError(providerTransactionId);
    }
    if (status === 'REJECTED' || status === 'FAILED') {
      // Reflect the failure on the corresponding withdrawal request if any.
      const withdrawal = Array.from(this.withdrawals.values()).find(
        (w) => w.providerWithdrawalId === providerTransactionId,
      );
      if (withdrawal) {
        this.withdrawals.set(withdrawal.clientWithdrawalId, {
          ...withdrawal,
          status,
          updatedAt: new Date(),
        });
      }
      throw new CustodyOperationRejectedError(
        `Mock custody transaction "${providerTransactionId}" transitioned to ${status}`,
        { providerTransactionId, status },
      );
    }

    const updated: CustodyTransaction = {
      ...tx,
      status,
      updatedAt: new Date(),
      confirmations: status === 'CONFIRMED' ? Math.max(tx.confirmations ?? 0, 1) : tx.confirmations,
    };
    this.transactions.set(providerTransactionId, updated);

    const withdrawal = Array.from(this.withdrawals.values()).find(
      (w) => w.providerWithdrawalId === providerTransactionId,
    );
    if (withdrawal) {
      this.withdrawals.set(withdrawal.clientWithdrawalId, {
        ...withdrawal,
        status,
        updatedAt: new Date(),
      });
    }

    return { ...updated };
  }

  // -------------------------------------------------------------------------
  // Test/mock-only helpers (NOT part of the ICustodyAdapter contract)
  // -------------------------------------------------------------------------

  /** Inject a mock custody-side balance for tests. */
  public seedBalance(balance: CustodyBalance): void {
    this.balances.set(balanceKey(balance.accountId, balance.asset, balance.network), { ...balance });
  }

  /** Register a mock custody-side account. */
  public seedAccount(account: CustodyAccount): void {
    this.accounts.set(account.accountId, { ...account });
  }

  /** Set mock health for failure-path tests. */
  public setHealthy(healthy: boolean): void {
    this.healthy = healthy;
  }

  /** Total number of simulated withdrawal requests held in mock state. */
  public get withdrawalCount(): number {
    return this.withdrawals.size;
  }
}

function balanceKey(accountId: string, asset: string, network: string): string {
  return `${accountId}|${asset}|${network}`;
}

/** Default supported asset/network set — the Phase 9.1 approved pairs. */
function defaultMockAssetNetworks(): CustodyAssetNetwork[] {
  return [
    {
      asset: 'USDT',
      network: 'ETHEREUM',
      isActive: true,
      decimals: 6,
      confirmationsRequired: 12,
      minDeposit: '0.000001',
      minWithdrawal: '1',
      withdrawalFee: '0.5',
      contractAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      addressFormat: 'EVM_HEX',
      requiresMemo: false,
    },
    {
      asset: 'USDC',
      network: 'ETHEREUM',
      isActive: true,
      decimals: 6,
      confirmationsRequired: 12,
      minDeposit: '0.000001',
      minWithdrawal: '1',
      withdrawalFee: '0.5',
      contractAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      addressFormat: 'EVM_HEX',
      requiresMemo: false,
    },
    {
      asset: 'BTC',
      network: 'BITCOIN',
      isActive: true,
      decimals: 8,
      confirmationsRequired: 2,
      minDeposit: '0.00000001',
      minWithdrawal: '0.0001',
      withdrawalFee: '0.00005',
      contractAddress: null,
      addressFormat: 'BITCOIN_BECH32',
      requiresMemo: false,
    },
    {
      asset: 'ETH',
      network: 'ETHEREUM',
      isActive: true,
      decimals: 18,
      confirmationsRequired: 12,
      minDeposit: '0.000000000000000001',
      minWithdrawal: '0.001',
      withdrawalFee: '0.0005',
      contractAddress: null,
      addressFormat: 'EVM_HEX',
      requiresMemo: false,
    },
  ];
}