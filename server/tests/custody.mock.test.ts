/**
 * Phase 9.2 — Custody Abstraction Layer: Unit Tests
 *
 * Acceptance criteria (Part 8):
 * 1. Mock provider health
 * 2. Asset/network capability lookup
 * 3. Mock balance lookup
 * 4. Deposit-address simulation
 * 5. Mock withdrawal creation
 * 6. Mock transaction status transitions
 * 7. Provider error mapping
 * 8. CUSTODY_ENABLED=false fail-closed behavior
 * 9. Switching provider implementation behind the same adapter interface
 * 10. Mock custody activity does NOT modify wallet_balances/ledger/trades/positions
 * 11. Existing paper wallet functionality remains intact
 *
 * Additionally validates:
 *  - config default for CUSTODY_ENABLED
 *  - server-side validation of asset/network identifiers
 *  - capability-gated writes
 */

import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { loadConfig } from '../src/config/env';
import { ICustodyAdapter } from '../src/services/custody/custody-adapter';
import {
  CustodyService,
  createCustodyService,
  custodyService,
  MockCustodyProvider,
} from '../src/services/custody';
import {
  CustodyDisabledError,
  CustodyTransactionNotFoundError,
  ProviderUnavailableError,
  UnsupportedAssetNetworkError,
  CustodyCapabilityUnavailableError,
  InvalidCustodyRequestError,
  CustodyOperationRejectedError,
} from '../src/services/custody';
import {
  CustodyProviderCapability,
  CustodyBalance,
  CustodyTransactionStatus,
  WithdrawalRequest,
  CustodyProviderHealth,
  CustodyAccount,
  CustodyAssetNetwork,
} from '../src/services/custody';
import { walletService } from '../src/services/wallet/wallet.service';
import { authService } from '../src/services/auth/auth.service';
import { circuitBreakerService } from '../src/services/system/circuit-breaker.service';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeId(): string {
  return crypto.randomUUID();
}

async function createTestUser(): Promise<{ userId: string; accountId: string }> {
  const signup = await authService.signup({
    email: `custody_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@novacex.io`,
    password: 'TestPassword123!Secure',
    username: `ctest_${Date.now().toString().slice(-4)}_${Math.random().toString(36).slice(2, 6)}`,
  });
  const { db } = await import('../src/config/database');
  const accRes = await db.query<any>('SELECT id FROM accounts WHERE user_id = $1 AND type = $2', [
    signup.user.id,
    'SPOT',
  ]);
  return { userId: signup.user.id, accountId: accRes.rows[0].id };
}

// ---------------------------------------------------------------------------
// Fake adapter (alternative implementation of ICustodyAdapter, for test 9/7)
// ---------------------------------------------------------------------------

class FakeCustodyAdapter implements ICustodyAdapter {
  public readonly providerId = 'FAKE_ADAPTER';
  public readonly isMock = true as const;
  private fakeHealthy = true;
  private readonly caps: CustodyProviderCapability[];
  private readonly throwOnGetBalances: boolean;

  constructor(options?: { throwOnGetBalances?: boolean; caps?: CustodyProviderCapability[] }) {
    this.throwOnGetBalances = options?.throwOnGetBalances ?? false;
    this.caps = options?.caps ?? [
      CustodyProviderCapability.HEALTH,
      CustodyProviderCapability.BALANCE_QUERY,
    ];
  }

  public setHealthy(v: boolean) { this.fakeHealthy = v; }

  getCapabilities(): CustodyProviderCapability[] {
    return [...this.caps];
  }
  hasCapability(cap: CustodyProviderCapability): boolean {
    return this.caps.includes(cap);
  }
  async healthCheck(): Promise<CustodyProviderHealth> {
    return {
      providerId: this.providerId,
      healthy: this.fakeHealthy,
      latencyMs: 0,
      detail: 'fake',
      checkedAt: new Date(),
    };
  }
  async getSupportedAssetNetworks(): Promise<CustodyAssetNetwork[]> { return []; }
  async getAccounts(): Promise<CustodyAccount[]> { return []; }
  async getBalances(): Promise<CustodyBalance[]> {
    if (this.throwOnGetBalances) {
      throw new Error('simulated provider backend explosion');
    }
    return [];
  }
  async getDepositAddress(): Promise<any> { throw new Error('not implemented'); }
  async getWithdrawalStatus(): Promise<any> { throw new Error('not implemented'); }
  async getTransaction(): Promise<any> { throw new Error('not implemented'); }
  async requestWithdrawal(): Promise<any> { throw new Error('not implemented'); }
  async updateTransactionStatus(): Promise<any> { throw new Error('not implemented'); }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Phase 9.2: Custody Abstraction Layer Unit Tests', () => {
  beforeEach(async () => {
    const { db } = await import('../src/config/database');
    db.reset?.();
    circuitBreakerService.resetCache();
    await db.connect();
  });

  // -----------------------------------------------------------------------
  // 0. Config default
  // -----------------------------------------------------------------------

  it('00. CUSTODY_ENABLED defaults to false in all environments', () => {
    const config = loadConfig();
    expect(config.CUSTODY_ENABLED).toBe(false);
    const overridden = loadConfig({ CUSTODY_ENABLED: true });
    expect(overridden.CUSTODY_ENABLED).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 1. Mock provider health
  // -----------------------------------------------------------------------

  it('01. Mock provider reports healthy by default with correct providerId', async () => {
    const mock = new MockCustodyProvider();
    const health = await mock.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.providerId).toBe('MOCK_CUSTODY');
    expect(health.latencyMs).toBe(0);
    expect(health.detail).toContain('healthy');
  });

  it('01b. Mock provider can be set unhealthy for failure-path tests', async () => {
    const mock = new MockCustodyProvider({ healthy: false });
    expect((await mock.healthCheck()).healthy).toBe(false);

    mock.setHealthy(false);
    expect((await mock.healthCheck()).healthy).toBe(false);

    mock.setHealthy(true);
    expect((await mock.healthCheck()).healthy).toBe(true);
  });

  it('01c. CustodyService exposes mock health via CAL', async () => {
    const mock = new MockCustodyProvider();
    const cal = createCustodyService({ enabled: true, adapter: mock });
    const health = await cal.getHealth();
    expect(health.healthy).toBe(true);
    expect(health.providerId).toBe('MOCK_CUSTODY');
  });

  // -----------------------------------------------------------------------
  // 2. Asset/network capability lookup
  // -----------------------------------------------------------------------

  it('02. Mock provider supports the Phase 9.1 approved asset/network pairs', async () => {
    const mock = new MockCustodyProvider();
    const networks = await mock.getSupportedAssetNetworks();
    expect(networks.length).toBe(4);

    const pairs = networks.map((n) => `${n.asset}/${n.network}`);
    expect(pairs).toContain('USDT/ETHEREUM');
    expect(pairs).toContain('USDC/ETHEREUM');
    expect(pairs).toContain('BTC/BITCOIN');
    expect(pairs).toContain('ETH/ETHEREUM');
  });

  it('02b. Mock advertises read capabilities', () => {
    const mock = new MockCustodyProvider();
    expect(mock.hasCapability(CustodyProviderCapability.HEALTH)).toBe(true);
    expect(mock.hasCapability(CustodyProviderCapability.BALANCE_QUERY)).toBe(true);
    expect(mock.hasCapability(CustodyProviderCapability.DEPOSIT_ADDRESS)).toBe(true);
    expect(mock.hasCapability(CustodyProviderCapability.ASSET_NETWORK_LOOKUP)).toBe(true);
    expect(mock.hasCapability(CustodyProviderCapability.WITHDRAWAL_REQUEST)).toBe(true);
    expect(mock.hasCapability(CustodyProviderCapability.WITHDRAWAL_STATUS)).toBe(true);
    expect(mock.hasCapability(CustodyProviderCapability.TRANSACTION_LOOKUP)).toBe(true);
  });

  it('02c. CAL throws CustodyCapabilityUnavailableError when provider lacks capability', async () => {
    // Fake WITHOUT BALANCE_QUERY capability
    const minimal = new FakeCustodyAdapter({ caps: [CustodyProviderCapability.HEALTH] });
    const cal = createCustodyService({ enabled: true, adapter: minimal });
    await expect(cal.getBalances()).rejects.toThrow(CustodyCapabilityUnavailableError);
  });

  // -----------------------------------------------------------------------
  // 3. Mock balance lookup
  // -----------------------------------------------------------------------

  it('03. Mock balance lookup returns empty by default; seeded balances are returned', async () => {
    const mock = new MockCustodyProvider();
    const accountId = makeId();

    // Default empty
    expect(await mock.getBalances(accountId)).toEqual([]);
    expect(await mock.getBalances()).toEqual([]);

    // Seed a balance
    mock.seedBalance({
      accountId,
      asset: 'USDT',
      network: 'ETHEREUM',
      available: '50000.000000',
      locked: '0.000000',
      total: '50000.000000',
      updatedAt: new Date(),
    });

    const balances = await mock.getBalances(accountId);
    expect(balances.length).toBe(1);
    expect(balances[0].asset).toBe('USDT');
    expect(balances[0].available).toBe('50000.000000');
  });

  it('03b. CAL exposes mock balances via getBalances', async () => {
    const mock = new MockCustodyProvider();
    const accountId = makeId();
    mock.seedBalance({
      accountId,
      asset: 'ETH',
      network: 'ETHEREUM',
      available: '100.000000000000000000',
      locked: '0',
      total: '100.000000000000000000',
      updatedAt: new Date(),
    });
    const cal = createCustodyService({ enabled: true, adapter: mock });
    const balances = await cal.getBalances(accountId);
    expect(balances.length).toBe(1);
    expect(balances[0].asset).toBe('ETH');
  });

  // -----------------------------------------------------------------------
  // 4. Deposit-address simulation
  // -----------------------------------------------------------------------

  it('04. Mock deposit address is deterministic per (asset, network, accountId)', async () => {
    const mock = new MockCustodyProvider();
    const accountId = makeId();
    const addr1 = await mock.getDepositAddress('USDT', 'ETHEREUM', accountId);
    const addr2 = await mock.getDepositAddress('USDT', 'ETHEREUM', accountId);
    // Same input → same address (idempotent)
    expect(addr1.address).toBe(addr2.address);
    expect(addr1.asset).toBe('USDT');
    expect(addr1.network).toBe('ETHEREUM');
    // Different network → different address
    const addr3 = await mock.getDepositAddress('BTC', 'BITCOIN', accountId);
    expect(addr3.address).not.toBe(addr1.address);
    expect(addr3.address).toMatch(/^MOCK_BITCOIN_/);
  });

  it('04b. Unsupported asset/network for deposit address throws InvalidCustodyRequestError', async () => {
    const mock = new MockCustodyProvider();
    const accountId = makeId();
    await expect(mock.getDepositAddress('SOL', 'SOLANA', accountId)).rejects.toThrow(
      InvalidCustodyRequestError,
    );
  });

  it('04c. CAL validates asset/network before delegating deposit address creation', async () => {
    const mock = new MockCustodyProvider();
    const cal = createCustodyService({ enabled: true, adapter: mock });
    const accountId = makeId();
    // Unsupported network → UnsupportedAssetNetworkError (from CAL, not from mock)
    await expect(cal.getDepositAddress('USDT', 'SOLANA', accountId)).rejects.toThrow(
      UnsupportedAssetNetworkError,
    );
    // Supported pair works
    const addr = await cal.getDepositAddress('USDT', 'ETHEREUM', accountId);
    expect(addr.address).toBeTruthy();
  });

  // -----------------------------------------------------------------------
  // 5. Mock withdrawal creation
  // -----------------------------------------------------------------------

  it('05. Mock withdrawal creates a PENDING withdrawal + transaction', async () => {
    const mock = new MockCustodyProvider();
    const cal = createCustodyService({ enabled: true, adapter: mock });
    const accountId = makeId();
    const clientId = `wd-${Date.now()}`;

    const result = await cal.requestWithdrawal({
      clientWithdrawalId: clientId,
      accountId,
      asset: 'USDT',
      network: 'ETHEREUM',
      amount: '100.000000',
      destinationAddress: '0x1234567890abcdef1234567890abcdef12345678',
      status: 'PENDING' as CustodyTransactionStatus,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(result.clientWithdrawalId).toBe(clientId);
    expect(result.status).toBe('PENDING');
    expect(result.providerWithdrawalId).toBeTruthy();
    expect(result.providerReference).toContain('mock-wd-');

    // Also check the transaction was created
    const tx = await cal.getTransaction(result.providerWithdrawalId!);
    expect(tx.direction).toBe('WITHDRAWAL');
    expect(tx.amount).toBe('100.000000');
  });

  it('05b. Duplicate client withdrawal id is idempotent', async () => {
    const mock = new MockCustodyProvider();
    const accountId = makeId();
    const clientId = `wd-dup-${Date.now()}`;
    const req: WithdrawalRequest = {
      clientWithdrawalId: clientId,
      accountId,
      asset: 'USDT',
      network: 'ETHEREUM',
      amount: '50',
      destinationAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      status: 'PENDING',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const r1 = await mock.requestWithdrawal(req);
    const r2 = await mock.requestWithdrawal(req);
    expect(r2.clientWithdrawalId).toBe(clientId);
    expect(r2.status).toBe('PENDING');
    // Same request should return the same withdrawal (not a second one)
    expect(mock.withdrawalCount).toBe(1);
  });

  it('05c. Zero/negative withdrawal amount is rejected', async () => {
    const mock = new MockCustodyProvider();
    const accountId = makeId();
    await expect(
      mock.requestWithdrawal({
        clientWithdrawalId: `wd-zero-${Date.now()}`,
        accountId,
        asset: 'USDT',
        network: 'ETHEREUM',
        amount: '0',
        destinationAddress: '0x0000000000000000000000000000000000000000',
        status: 'PENDING',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toThrow(InvalidCustodyRequestError);
  });

  // -----------------------------------------------------------------------
  // 6. Mock transaction status transitions
  // -----------------------------------------------------------------------

  it('06. Mock transaction status can transition through lifecycle', async () => {
    const mock = new MockCustodyProvider();
    const accountId = makeId();
    const clientId = `wd-lifecycle-${Date.now()}`;

    const wd = await mock.requestWithdrawal({
      clientWithdrawalId: clientId,
      accountId,
      asset: 'USDT',
      network: 'ETHEREUM',
      amount: '10',
      destinationAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      status: 'PENDING',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const txId = wd.providerWithdrawalId!;

    // PENDING → SIGNING
    const tx1 = await mock.updateTransactionStatus(txId, 'SIGNING');
    expect(tx1.status).toBe('SIGNING');

    // SIGNING → BROADCAST
    const tx2 = await mock.updateTransactionStatus(txId, 'BROADCAST');
    expect(tx2.status).toBe('BROADCAST');

    // BROADCAST → CONFIRMED
    const tx3 = await mock.updateTransactionStatus(txId, 'CONFIRMED');
    expect(tx3.status).toBe('CONFIRMED');
    expect(tx3.confirmations).toBeGreaterThanOrEqual(1);

    // Withdrawal also reflects the status
    const wdFinal = await mock.getWithdrawalStatus(clientId);
    expect(wdFinal.status).toBe('CONFIRMED');
  });

  it('06b. Mock FAILED/REJECTED transition throws CustodyOperationRejectedError', async () => {
    const mock = new MockCustodyProvider();
    const accountId = makeId();
    const clientId = `wd-fail-${Date.now()}`;
    const wd = await mock.requestWithdrawal({
      clientWithdrawalId: clientId,
      accountId,
      asset: 'USDT',
      network: 'ETHEREUM',
      amount: '5',
      destinationAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      status: 'PENDING',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(mock.updateTransactionStatus(wd.providerWithdrawalId!, 'FAILED')).rejects.toThrow(
      CustodyOperationRejectedError,
    );
  });

  it('06c. Unknown transaction ID throws CustodyTransactionNotFoundError', async () => {
    const mock = new MockCustodyProvider();
    await expect(mock.getTransaction('nonexistent-id')).rejects.toThrow(CustodyTransactionNotFoundError);
    await expect(mock.updateTransactionStatus('nonexistent-id', 'CONFIRMED')).rejects.toThrow(
      CustodyTransactionNotFoundError,
    );
  });

  // -----------------------------------------------------------------------
  // 7. Provider error mapping
  // -----------------------------------------------------------------------

  it('07. CAL wraps unknown provider errors as ProviderUnavailableError', async () => {
    const adapter = new FakeCustodyAdapter({ throwOnGetBalances: true });
    const cal = createCustodyService({ enabled: true, adapter });
    await expect(cal.getBalances()).rejects.toThrow(ProviderUnavailableError);
  });

  it('07b. CAL passes through CustodyError subclasses without wrapping', async () => {
    const mock = new MockCustodyProvider();
    const cal = createCustodyService({ enabled: true, adapter: mock });
    // Unsupported asset/network throws UnsupportedAssetNetworkError (from CAL validation)
    await expect(cal.getDepositAddress('SOL', 'SOLANA', makeId())).rejects.toThrow(
      UnsupportedAssetNetworkError,
    );
    // Nonexistent transaction throws CustodyTransactionNotFoundError (from mock)
    await expect(cal.getTransaction('nonexistent')).rejects.toThrow(CustodyTransactionNotFoundError);
  });

  // -----------------------------------------------------------------------
  // 8. CUSTODY_ENABLED=false fail-closed
  // -----------------------------------------------------------------------

  it('08. Disabled custody service throws CustodyDisabledError on ALL operations', async () => {
    const mock = new MockCustodyProvider();
    const cal = createCustodyService({ enabled: false, adapter: mock });

    await expect(cal.getHealth()).rejects.toThrow(CustodyDisabledError);
    await expect(cal.getSupportedAssetNetworks()).rejects.toThrow(CustodyDisabledError);
    await expect(cal.getAccounts()).rejects.toThrow(CustodyDisabledError);
    await expect(cal.getBalances()).rejects.toThrow(CustodyDisabledError);
    await expect(cal.getDepositAddress('USDT', 'ETHEREUM', makeId())).rejects.toThrow(CustodyDisabledError);
    await expect(cal.getWithdrawalStatus('x')).rejects.toThrow(CustodyDisabledError);
    await expect(cal.getTransaction('x')).rejects.toThrow(CustodyDisabledError);
    await expect(
      cal.requestWithdrawal({
        clientWithdrawalId: 'x',
        accountId: makeId(),
        asset: 'USDT',
        network: 'ETHEREUM',
        amount: '1',
        destinationAddress: '0x0',
        status: 'PENDING',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toThrow(CustodyDisabledError);
    await expect(cal.updateTransactionStatus('x', 'CONFIRMED')).rejects.toThrow(CustodyDisabledError);
  });

  it('08b. Disabled service returns false for isEnabled() and null for providerId', () => {
    const cal = createCustodyService({ enabled: false, adapter: null });
    expect(cal.isEnabled()).toBe(false);
    expect(cal.getProviderId()).toBeNull();
  });

  it('08c. Default (disabled) singleton service is disabled', () => {
    expect(custodyService.isEnabled()).toBe(false);
    expect(custodyService.getProviderId()).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 9. Switching provider implementation behind the same interface
  // -----------------------------------------------------------------------

  it('09. CAL works with any ICustodyAdapter implementation (mock vs fake)', async () => {
    // Mock provider
    const mock = new MockCustodyProvider();
    const cal1 = createCustodyService({ enabled: true, adapter: mock });
    const health1 = await cal1.getHealth();
    expect(health1.providerId).toBe('MOCK_CUSTODY');

    // Fake adapter (different implementation of same interface)
    const fake = new FakeCustodyAdapter();
    const cal2 = createCustodyService({ enabled: true, adapter: fake });
    const health2 = await cal2.getHealth();
    expect(health2.providerId).toBe('FAKE_ADAPTER');
    // Change fake state
    fake.setHealthy(false);
    const health2b = await cal2.getHealth();
    expect(health2b.healthy).toBe(false);
    // Mock still unaffected
    const health1b = await cal1.getHealth();
    expect(health1b.healthy).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 10. Mock custody activity does NOT modify financial state
  // -----------------------------------------------------------------------

  it('10. Mock custody operations never touch wallet_balances, ledger, orders, trades, or positions', async () => {
    const { db } = await import('../src/config/database');
    // Setup: create a user + account (baseline)
    const { userId, accountId } = await createTestUser();

    // Baseline wallet balances BEFORE any mock activity
    const baselineWb = await walletService.getBalances(userId, accountId);
    const baselineWbCount = baselineWb.length;

    // Baseline ledger entries count via handler-24 (supported pattern)
    const countLe = await db.query('SELECT COUNT(*) FROM ledger_entries WHERE account_id = $1', [accountId]);
    const baselineLeCount = Number(countLe.rows[0]?.total ?? 0);

    // Run several mock custody operations (read + write + status transitions)
    const mock = new MockCustodyProvider();
    mock.seedBalance({
      accountId,
      asset: 'USDT',
      network: 'ETHEREUM',
      available: '99999.999999',
      locked: '0',
      total: '99999.999999',
      updatedAt: new Date(),
    });
    await mock.getBalances(accountId);
    await mock.getDepositAddress('USDT', 'ETHEREUM', accountId);
    await mock.getDepositAddress('BTC', 'BITCOIN', accountId);
    const wd = await mock.requestWithdrawal({
      clientWithdrawalId: `test10-${Date.now()}`,
      accountId,
      asset: 'USDT',
      network: 'ETHEREUM',
      amount: '100',
      destinationAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
      status: 'PENDING',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await mock.updateTransactionStatus(wd.providerWithdrawalId!, 'CONFIRMED');
    await mock.getWithdrawalStatus(wd.clientWithdrawalId);

    // After mock activity, wallet balances must be identical
    const afterWb = await walletService.getBalances(userId, accountId);
    expect(afterWb.length).toBe(baselineWbCount);
    expect(afterWb).toEqual(baselineWb);

    // Ledger entries count unchanged
    const afterLe = await db.query('SELECT COUNT(*) FROM ledger_entries WHERE account_id = $1', [accountId]);
    const afterLeCount = Number(afterLe.rows[0]?.total ?? 0);
    expect(afterLeCount).toBe(baselineLeCount);

    // No orders, trades, or futures positions exist (these require no user setup)
    const orders = await db.query('SELECT * FROM orders WHERE account_id = $1', [accountId]);
    expect(orders.rowCount).toBe(0);
    const trades = await db.query('SELECT * FROM trades WHERE account_id = $1', [accountId]);
    expect(trades.rowCount).toBe(0);
    const positions = await db.query('SELECT * FROM futures_positions WHERE account_id = $1', [accountId]);
    expect(positions.rowCount).toBe(0);

    // Mock state DID grow (isolated provider-side storage)
    expect(mock.withdrawalCount).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 11. Existing paper wallet functionality remains intact
  // -----------------------------------------------------------------------

  it('11. Paper deposit/withdrawal still works correctly after custody service is created', async () => {
    const { db } = await import('../src/config/database');
    const { userId, accountId } = await createTestUser();

    // Create an ENABLED custody service — it must not interfere with paper wallet
    const mock = new MockCustodyProvider();
    const cal = createCustodyService({ enabled: true, adapter: mock });

    // Perform a paper deposit (existing wallet flow)
    const adminSignup = await authService.signup({
      email: `admin_custody_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@novacex.io`,
      password: 'AdminPassword123!Secure',
      username: `admincust_${Date.now().toString().slice(-4)}_${Math.random().toString(36).slice(2, 6)}`,
    });
    await db.query("UPDATE users SET role = 'ADMIN' WHERE id = $1", [adminSignup.user.id]);

    const ref = `paper-dep-custody-${Date.now()}`;
    await walletService.paperDeposit({
      adminUserId: adminSignup.user.id,
      targetAccountId: accountId,
      asset: 'USDT',
      amount: '2500',
      referenceId: ref,
    });

    // Verify the balance was credited in the NovaCEX ledger
    const balances = await walletService.getBalances(userId, accountId);
    const usdt = balances.find((b) => b.asset === 'USDT');
    expect(usdt).toBeDefined();
    expect(usdt!.availableBalance).toBe('2500.000000000000000000');

    // Verify the custody mock is intact and independent — no paper balance leaked in
    const health = await cal.getHealth();
    expect(health.healthy).toBe(true);
    const mockBalances = await mock.getBalances(accountId);
    const mockUsdt = mockBalances.find((b) => b.asset === 'USDT');
    expect(mockUsdt).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // 12. Validation: missing required withdrawal fields
  // -----------------------------------------------------------------------

  it('12. CAL rejects withdrawal with missing clientWithdrawalId or destinationAddress', async () => {
    const mock = new MockCustodyProvider();
    const cal = createCustodyService({ enabled: true, adapter: mock });
    const accountId = makeId();

    await expect(
      cal.requestWithdrawal({
        clientWithdrawalId: '',
        accountId,
        asset: 'USDT',
        network: 'ETHEREUM',
        amount: '1',
        destinationAddress: '0x0',
        status: 'PENDING',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toThrow(InvalidCustodyRequestError);

    await expect(
      cal.requestWithdrawal({
        clientWithdrawalId: 'wd-valid',
        accountId,
        asset: 'USDT',
        network: 'ETHEREUM',
        amount: '1',
        destinationAddress: '',
        status: 'PENDING',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toThrow(InvalidCustodyRequestError);
  });

  // -----------------------------------------------------------------------
  // 13. Unsupported network identifier validation
  // -----------------------------------------------------------------------

  it('13. CAL validates network identifiers against Phase 9.1 known networks', async () => {
    const mock = new MockCustodyProvider();
    const cal = createCustodyService({ enabled: true, adapter: mock });
    const accountId = makeId();

    await expect(cal.getDepositAddress('USDT', 'SOLANA', accountId)).rejects.toThrow(
      UnsupportedAssetNetworkError,
    );
    await expect(cal.getDepositAddress('USDT', '', accountId)).rejects.toThrow(
      InvalidCustodyRequestError,
    );
  });
});