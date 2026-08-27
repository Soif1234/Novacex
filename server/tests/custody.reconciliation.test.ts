import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { db } from '../src/config/database';
import { env } from '../src/config/env';
import { decimalAdd, decimalSubtract, decimalCompare } from '../src/services/ledger/decimal';
import { MockCustodyProvider } from '../src/services/custody/mock-custody-provider';
import { custodyService } from '../src/services/custody/custody.service';
import { reconciliationService } from '../src/services/compliance/reconciliation.service';
import { circuitBreakerService } from '../src/services/system/circuit-breaker.service';

describe('Phase 9.8 - Custody Reconciliation Check-3', () => {
  const asset = 'USDT';
  const network = 'ETHEREUM';
  let userId: string;
  let accountId: string;
  let originalEnvCustodyEnabled: boolean;
  let mockCustodyProvider: MockCustodyProvider;

  beforeAll(async () => { await db.connect(); });
  afterAll(async () => { await db.close(); });

  beforeEach(async () => {
    originalEnvCustodyEnabled = env.CUSTODY_ENABLED;
    env.CUSTODY_ENABLED = true;

    // Clean all tables via in-memory DB reset
    (db as any).reset();
    circuitBreakerService.resetCache();
    await db.connect();

    // Mock custody provider - USDT/ETHEREUM active by default
    mockCustodyProvider = new MockCustodyProvider({
      supportedAssetNetworks: [
        { asset, network, isActive: true, confirmationsRequired: 1, minDeposit: '0', minWithdrawal: '0', withdrawalFee: '0', requiresMemo: false }
      ]
    });
    (custodyService as any).adapter = mockCustodyProvider;
    (custodyService as any).enabled = true;

    // Seed a test user and FUNDING account
    userId = crypto.randomUUID();
    await db.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'hash')`,
      [userId, `test-${userId}@example.com`]
    );

    accountId = crypto.randomUUID();
    await db.query(
      `INSERT INTO accounts (id, user_id, type) VALUES ($1, $2, 'FUNDING')`,
      [accountId, userId]
    );
  });

  afterEach(() => {
    env.CUSTODY_ENABLED = originalEnvCustodyEnabled;
  });

  /**
   * Seed an internal wallet balance WITH a matching ledger CREDIT entry so
   * Check-1 remains consistent. ALL arithmetic uses exact decimal strings.
   */
  async function seedInternalBalance(amount: string, locked: string = '0'): Promise<void> {
    const walletId = 'wallet_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const walletTotal = decimalAdd(amount, locked);
    const txId = 'tx_seed_' + crypto.randomUUID();
    const entryId = 'entry_' + crypto.randomUUID();

    // Wallet balance
    await db.query(
      `INSERT INTO wallet_balances (id, account_id, asset, available_balance, locked_balance) VALUES ($1, $2, $3, $4, $5)`,
      [walletId, accountId, asset, amount, locked]
    );

    // Matching ledger CREDIT so Check-1 reports zero diff
    await db.query(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, asset, direction, amount, balance_after) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [entryId, txId, accountId, asset, 'CREDIT', walletTotal, walletTotal]
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1-3: Basic match / mismatch (no tolerance)
  // ─────────────────────────────────────────────────────────────────────────

  it('1. Exact internal/custody match -> PASSED', async () => {
    await seedInternalBalance('100', '0');
    mockCustodyProvider.seedBalance({ accountId: 'mock', asset, network, available: '100', locked: '0', total: '100', updatedAt: new Date() });

    const report = await reconciliationService.runReconciliation('TEST');
    const custodyErrors = report.details.filter((d: any) => d.type === 'CUSTODY_MISMATCH' || d.type === 'CUSTODY_API_ERROR');
    expect(custodyErrors).toHaveLength(0);
  });

  it('2. Internal > custody with no tolerance => CRITICAL', async () => {
    await seedInternalBalance('100', '0');
    mockCustodyProvider.seedBalance({ accountId: 'mock', asset, network, available: '90', locked: '0', total: '90', updatedAt: new Date() });

    const report = await reconciliationService.runReconciliation('TEST');
    const err = report.details.find((d: any) => d.type === 'CUSTODY_MISMATCH') as any;
    expect(err).toBeDefined();
    expect(err.severity).toBe('CRITICAL');
    expect(err.asset).toBe(asset);
    expect(err.internalTotal).toBe('100.000000000000000000');
    expect(err.custodyTotal).toBe('90.000000000000000000');
    expect(err.discrepancy).toBe('10.000000000000000000');
  });

  it('3. Custody > internal with no tolerance => CRITICAL', async () => {
    await seedInternalBalance('100', '0');
    mockCustodyProvider.seedBalance({ accountId: 'mock', asset, network, available: '110', locked: '0', total: '110', updatedAt: new Date() });

    const report = await reconciliationService.runReconciliation('TEST');
    const err = report.details.find((d: any) => d.type === 'CUSTODY_MISMATCH') as any;
    expect(err).toBeDefined();
    expect(err.severity).toBe('CRITICAL');
    expect(err.internalTotal).toBe('100.000000000000000000');
    expect(err.custodyTotal).toBe('110.000000000000000000');
    // internal < custody => diff negative
    expect(decimalCompare(err.discrepancy, '0')).toBeLessThan(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4-7: Tolerance classification
  // ─────────────────────────────────────────────────────────────────────────

  it('4. Internal > custody within pending-withdrawal tolerance => WARNING', async () => {
    await seedInternalBalance('90', '10');
    mockCustodyProvider.seedBalance({ accountId: 'mock', asset, network, available: '90', locked: '0', total: '90', updatedAt: new Date() });

    // 10 SUBMITTED => tolerance = 10
    await db.query(
      `INSERT INTO withdrawals (id, account_id, asset, network, amount, fee, status, crypto_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [crypto.randomUUID(), accountId, asset, network, '10', '0', 'PENDING', 'SUBMITTED']
    );

    const report = await reconciliationService.runReconciliation('TEST');
    const err = report.details.find((d: any) => d.type === 'CUSTODY_MISMATCH') as any;
    expect(err).toBeDefined();
    expect(err.severity).toBe('WARNING');
    expect(err.pendingWithdrawalTolerance).toBe('10.000000000000000000');
  });

  it('5. Custody > internal within pending-deposit tolerance => WARNING', async () => {
    await seedInternalBalance('100', '0');
    mockCustodyProvider.seedBalance({ accountId: 'mock', asset, network, available: '110', locked: '0', total: '110', updatedAt: new Date() });

    // 10 DETECTED deposit => tolerance = 10
    await db.query(
      `INSERT INTO blockchain_deposits (id, chain_id, asset, network, transaction_hash, block_number, block_hash, block_timestamp, log_index, to_address, amount, raw_amount, token_contract, decimals, confirmation_count, required_confirmations, status, detected_at, confirmed_at, reorged_at, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
      [crypto.randomUUID(), 'ethereum', asset, network, '0x', 1, '0x', new Date(), 0, '0x', '0x', '10', '10', null, 8, 1, 1, 'DETECTED', new Date(), null, null]
    );

    const report = await reconciliationService.runReconciliation('TEST');
    const err = report.details.find((d: any) => d.type === 'CUSTODY_MISMATCH') as any;
    expect(err).toBeDefined();
    expect(err.severity).toBe('WARNING');
    expect(err.pendingDepositTolerance).toBe('10.000000000000000000');
  });

  it('6. Difference exactly equal to tolerance => WARNING', async () => {
    await seedInternalBalance('110', '0');
    mockCustodyProvider.seedBalance({ accountId: 'mock', asset, network, available: '100', locked: '0', total: '100', updatedAt: new Date() });

    // diff=10, tolerance=10 => equal => WARNING not CRITICAL
    await db.query(
      `INSERT INTO withdrawals (id, account_id, asset, network, amount, fee, status, crypto_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [crypto.randomUUID(), accountId, asset, network, '10', '0', 'PENDING', 'SIGNING']
    );

    const report = await reconciliationService.runReconciliation('TEST');
    const err = report.details.find((d: any) => d.type === 'CUSTODY_MISMATCH') as any;
    expect(err).toBeDefined();
    expect(err.severity).toBe('WARNING');
    // tolerance = 10, diff = 10, absDiff = 10, absDiff > tolerance? No (10 > 10 is false) => WARNING
    expect(err.tolerance).toBe('10.000000000000000000');
  });

  it('7. Difference one unit above tolerance => CRITICAL', async () => {
    await seedInternalBalance('111', '0');
    mockCustodyProvider.seedBalance({ accountId: 'mock', asset, network, available: '100', locked: '0', total: '100', updatedAt: new Date() });

    // diff=11, tolerance=10 => absDiff(11) > tolerance(10) => CRITICAL
    await db.query(
      `INSERT INTO withdrawals (id, account_id, asset, network, amount, fee, status, crypto_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [crypto.randomUUID(), accountId, asset, network, '10', '0', 'PENDING', 'SUBMITTED']
    );

    const report = await reconciliationService.runReconciliation('TEST');
    const err = report.details.find((d: any) => d.type === 'CUSTODY_MISMATCH') as any;
    expect(err).toBeDefined();
    expect(err.severity).toBe('CRITICAL');
    expect(err.discrepancy).toBe('11.000000000000000000');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 8-9: Internal states NOT tolerance
  // ─────────────────────────────────────────────────────────────────────────

  it('8. PENDING_REVIEW withdrawal is NOT tolerance', async () => {
    await seedInternalBalance('110', '0');
    mockCustodyProvider.seedBalance({ accountId: 'mock', asset, network, available: '100', locked: '0', total: '100', updatedAt: new Date() });

    await db.query(
      `INSERT INTO withdrawals (id, account_id, asset, network, amount, fee, status, crypto_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [crypto.randomUUID(), accountId, asset, network, '10', '0', 'PENDING', 'PENDING_REVIEW']
    );

    const report = await reconciliationService.runReconciliation('TEST');
    const err = report.details.find((d: any) => d.type === 'CUSTODY_MISMATCH') as any;
    expect(err.severity).toBe('CRITICAL');
  });

  it('9. APPROVED withdrawal is NOT tolerance', async () => {
    await seedInternalBalance('110', '0');
    mockCustodyProvider.seedBalance({ accountId: 'mock', asset, network, available: '100', locked: '0', total: '100', updatedAt: new Date() });

    await db.query(
      `INSERT INTO withdrawals (id, account_id, asset, network, amount, fee, status, crypto_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [crypto.randomUUID(), accountId, asset, network, '10', '0', 'PENDING', 'APPROVED']
    );

    const report = await reconciliationService.runReconciliation('TEST');
    const err = report.details.find((d: any) => d.type === 'CUSTODY_MISMATCH') as any;
    expect(err.severity).toBe('CRITICAL');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 10-11: Custody-progressed withdrawals DO contribute tolerance
  // ─────────────────────────────────────────────────────────────────────────

  it('10. SUBMITTED withdrawal contributes tolerance', async () => {
    await seedInternalBalance('110', '0');
    mockCustodyProvider.seedBalance({ accountId: 'mock', asset, network, available: '100', locked: '0', total: '100', updatedAt: new Date() });

    await db.query(
      `INSERT INTO withdrawals (id, account_id, asset, network, amount, fee, status, crypto_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [crypto.randomUUID(), accountId, asset, network, '10', '0', 'PENDING', 'SUBMITTED']
    );

    const report = await reconciliationService.runReconciliation('TEST');
    const err = report.details.find((d: any) => d.type === 'CUSTODY_MISMATCH') as any;
    expect(err.severity).toBe('WARNING');
  });

  it('11. UNKNOWN withdrawal contributes tolerance', async () => {
    await seedInternalBalance('110', '0');
    mockCustodyProvider.seedBalance({ accountId: 'mock', asset, network, available: '100', locked: '0', total: '100', updatedAt: new Date() });

    await db.query(
      `INSERT INTO withdrawals (id, account_id, asset, network, amount, fee, status, crypto_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [crypto.randomUUID(), accountId, asset, network, '10', '0', 'PENDING', 'UNKNOWN']
    );

    const report = await reconciliationService.runReconciliation('TEST');
    const err = report.details.find((d: any) => d.type === 'CUSTODY_MISMATCH') as any;
    expect(err.severity).toBe('WARNING');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 12-14: Deposit tolerance states
  // ─────────────────────────────────────────────────────────────────────────

  it('12. DETECTED deposit contributes tolerance', async () => {
    await seedInternalBalance('100', '0');
    mockCustodyProvider.seedBalance({ accountId: 'mock', asset, network, available: '110', locked: '0', total: '110', updatedAt: new Date() });

    await db.query(
      `INSERT INTO blockchain_deposits (id, chain_id, asset, network, transaction_hash, block_number, block_hash, block_timestamp, log_index, to_address, amount, raw_amount, token_contract, decimals, confirmation_count, required_confirmations, status, detected_at, confirmed_at, reorged_at, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
      [crypto.randomUUID(), 'ethereum', asset, network, '0x', 1, '0x', new Date(), 0, '0x', '0x', '10', '10', null, 8, 1, 1, 'DETECTED', new Date(), null, null]
    );

    const report = await reconciliationService.runReconciliation('TEST');
    const err = report.details.find((d: any) => d.type === 'CUSTODY_MISMATCH') as any;
    expect(err.severity).toBe('WARNING');
  });

  it('13. CONFIRMED but uncredited deposit contributes tolerance', async () => {
    await seedInternalBalance('100', '0');
    mockCustodyProvider.seedBalance({ accountId: 'mock', asset, network, available: '110', locked: '0', total: '110', updatedAt: new Date() });

    await db.query(
      `INSERT INTO blockchain_deposits (id, chain_id, asset, network, transaction_hash, block_number, block_hash, block_timestamp, log_index, to_address, amount, raw_amount, token_contract, decimals, confirmation_count, required_confirmations, status, detected_at, confirmed_at, reorged_at, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
      [crypto.randomUUID(), 'ethereum', asset, network, '0x', 1, '0x', new Date(), 0, '0x', '0x', '10', '10', null, 8, 1, 1, 'CONFIRMED', new Date(), new Date(), null, null]
    );

    const report = await reconciliationService.runReconciliation('TEST');
    const err = report.details.find((d: any) => d.type === 'CUSTODY_MISMATCH') as any;
    expect(err.severity).toBe('WARNING');
  });

  it('14. CONFIRMED credited deposit does NOT contribute tolerance', async () => {
    await seedInternalBalance('100', '0');
    mockCustodyProvider.seedBalance({ accountId: 'mock', asset, network, available: '110', locked: '0', total: '110', updatedAt: new Date() });

    const depId = crypto.randomUUID();
    await db.query(
      `INSERT INTO blockchain_deposits (id, chain_id, asset, network, transaction_hash, block_number, block_hash, block_timestamp, log_index, to_address, amount, raw_amount, token_contract, decimals, confirmation_count, required_confirmations, status, detected_at, confirmed_at, reorged_at, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
      [depId, 'ethereum', asset, network, '0x', 1, '0x', new Date(), 0, '0x', '0x', '10', '10', null, 8, 1, 1, 'CONFIRMED', new Date(), new Date(), null, null]
    );
    // Mark as credited
    await db.query(
      `UPDATE blockchain_deposits SET is_credited = TRUE, ledger_tx_id = $1, updated_at = NOW() WHERE id = $2`,
      ['tx_credited', depId]
    );

    const report = await reconciliationService.runReconciliation('TEST');
    const err = report.details.find((d: any) => d.type === 'CUSTODY_MISMATCH') as any;
    expect(err.severity).toBe('CRITICAL');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 15-16: Provider failure
  // ─────────────────────────────────────────────────────────────────────────

  it('15-16. Provider error => CUSTODY_API_ERROR, no circuit breaker', async () => {
    await seedInternalBalance('100', '0');
    mockCustodyProvider.seedBalance({ accountId: 'mock', asset, network, available: '90', locked: '0', total: '90', updatedAt: new Date() });

    vi.spyOn(mockCustodyProvider, 'getBalances').mockRejectedValue(new Error('Timeout'));

    const report = await reconciliationService.runReconciliation('TEST');
    const err = report.details.find((d: any) => d.type === 'CUSTODY_API_ERROR') as any;
    expect(err).toBeDefined();
    expect(err.severity).toBe('WARNING');

    // Verify no HALT_WITHDRAWALS triggered (default SYSTEM_ACTIVE row may exist)
    const cbRes = await db.query('SELECT * FROM system_circuit_breakers');
    expect(cbRes.rows.every((r: any) => (r.mode ?? r.mode) !== 'HALT_WITHDRAWALS')).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 17-18: Circuit breaker behavior
  // ─────────────────────────────────────────────────────────────────────────

  it('17. Critical mismatch triggers HALT_WITHDRAWALS', async () => {
    await seedInternalBalance('100', '0');
    mockCustodyProvider.seedBalance({ accountId: 'mock', asset, network, available: '90', locked: '0', total: '90', updatedAt: new Date() });

    await reconciliationService.runReconciliation('TEST');

    // Verify circuit breaker triggered
    const cbState = await circuitBreakerService.getState();
    expect(cbState.mode).toBe('HALT_WITHDRAWALS');
    expect(cbState.isWithdrawalsEnabled).toBe(false);
  });

  it('18. WARNING mismatch does NOT trigger halt', async () => {
    await seedInternalBalance('110', '0');
    mockCustodyProvider.seedBalance({ accountId: 'mock', asset, network, available: '100', locked: '0', total: '100', updatedAt: new Date() });

    await db.query(
      `INSERT INTO withdrawals (id, account_id, asset, network, amount, fee, status, crypto_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [crypto.randomUUID(), accountId, asset, network, '10', '0', 'PENDING', 'SIGNING']
    );

    await reconciliationService.runReconciliation('TEST');

    // Verify no HALT_WITHDRAWALS triggered
    const cbRes = await db.query('SELECT * FROM system_circuit_breakers');
    expect(cbRes.rows.every((r: any) => r.mode !== 'HALT_WITHDRAWALS')).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 19: CUSTODY_ENABLED=false
  // ─────────────────────────────────────────────────────────────────────────

  it('19. CUSTODY_ENABLED=false skips Check-3 entirely', async () => {
    env.CUSTODY_ENABLED = false;
    await seedInternalBalance('100', '0');
    mockCustodyProvider.seedBalance({ accountId: 'mock', asset, network, available: '90', locked: '0', total: '90', updatedAt: new Date() });

    // Spy to prove custody is never called
    const getBalancesSpy = vi.spyOn(custodyService, 'getBalances');
    const getSupportedNetworksSpy = vi.spyOn(custodyService, 'getSupportedAssetNetworks');

    const report = await reconciliationService.runReconciliation('TEST');
    const custodyErrors = report.details.filter((d: any) => d.type === 'CUSTODY_MISMATCH' || d.type === 'CUSTODY_API_ERROR');
    expect(custodyErrors).toHaveLength(0);

    // Prove custody provider was never called
    expect(getBalancesSpy).not.toHaveBeenCalled();
    expect(getSupportedNetworksSpy).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 20: Multiple networks aggregate
  // ─────────────────────────────────────────────────────────────────────────

  it('20. Multiple networks for same asset aggregate correctly', async () => {
    // Add TRON network to both asset_networks and mock provider
    await db.query(
      `INSERT INTO asset_networks (asset, network, is_active, confirmations_required, min_deposit, min_withdrawal, withdrawal_fee)
       VALUES ($1, $2, true, 1, '0', '0', '0')
       ON CONFLICT DO NOTHING`,
      [asset, 'TRON']
    );
    mockCustodyProvider = new MockCustodyProvider({
      supportedAssetNetworks: [
        { asset, network, isActive: true, confirmationsRequired: 1, minDeposit: '0', minWithdrawal: '0', withdrawalFee: '0', requiresMemo: false },
        { asset, network: 'TRON', isActive: true, confirmationsRequired: 1, minDeposit: '0', minWithdrawal: '0', withdrawalFee: '0', requiresMemo: false }
      ]
    });
    (custodyService as any).adapter = mockCustodyProvider;

    await seedInternalBalance('200', '0');

    // ETHEREUM: 100, TRON: 100 => custody total = 200 => match
    mockCustodyProvider.seedBalance({ accountId: 'mock1', asset, network, available: '100', locked: '0', total: '100', updatedAt: new Date() });
    mockCustodyProvider.seedBalance({ accountId: 'mock2', asset, network: 'TRON', available: '100', locked: '0', total: '100', updatedAt: new Date() });

    const report = await reconciliationService.runReconciliation('TEST');
    const custodyErrors = report.details.filter((d: any) => d.type === 'CUSTODY_MISMATCH' || d.type === 'CUSTODY_API_ERROR');
    expect(custodyErrors).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 21: Multiple assets isolated
  // ─────────────────────────────────────────────────────────────────────────

  it('21. Multiple assets remain isolated from one another', async () => {
    // Mock provider supports both USDT (matches) and BTC (mismatches)
    mockCustodyProvider = new MockCustodyProvider({
      supportedAssetNetworks: [
        { asset, network, isActive: true, confirmationsRequired: 1, minDeposit: '0', minWithdrawal: '0', withdrawalFee: '0', requiresMemo: false },
        { asset: 'BTC', network: 'BITCOIN', isActive: true, confirmationsRequired: 1, minDeposit: '0', minWithdrawal: '0', withdrawalFee: '0', requiresMemo: false }
      ]
    });
    (custodyService as any).adapter = mockCustodyProvider;

    // USDT matches
    await seedInternalBalance('100', '0');
    mockCustodyProvider.seedBalance({ accountId: 'mock', asset, network, available: '100', locked: '0', total: '100', updatedAt: new Date() });

    // BTC mismatches (internal 50, custody 0)
    await db.query(
      `INSERT INTO wallet_balances (id, account_id, asset, available_balance, locked_balance) VALUES ($1, $2, $3, $4, $5)`,
      ['btc_wallet_' + Date.now(), accountId, 'BTC', '50', '0']
    );
    const btcTxId = 'tx_btc_' + crypto.randomUUID();
    await db.query(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, asset, direction, amount, balance_after) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['btc_entry_' + crypto.randomUUID(), btcTxId, accountId, 'BTC', 'CREDIT', '50', '50']
    );

        const report = await reconciliationService.runReconciliation('TEST');
    const custodyErrors = report.details.filter((d: any) => d.type === 'CUSTODY_MISMATCH');
    expect(custodyErrors).toHaveLength(1);
    expect(custodyErrors[0].asset).toBe('BTC');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 22: Check-1 unchanged
  // ─────────────────────────────────────────────────────────────────────────

  it('22. Check-1 remains unchanged (BALANCE_MISMATCH still detected)', async () => {
    env.CUSTODY_ENABLED = false; // isolate Check-1
    await seedInternalBalance('100', '0');

    // Corrupt wallet to create a Check-1 mismatch
    await db.query(
      `UPDATE wallet_balances SET available_balance = '99999' WHERE account_id = $1 AND asset = $2`,
      [accountId, asset]
    );

    const report = await reconciliationService.runReconciliation('TEST');
    const balanceMismatch = report.details.find((d: any) => d.type === 'BALANCE_MISMATCH' && d.accountId === accountId);
    expect(balanceMismatch).toBeDefined();
    expect(balanceMismatch?.walletTotal).toContain('99999');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 23: Check-2 / 110 unchanged
  // ─────────────────────────────────────────────────────────────────────────

  it('23. Check-2 / 110 DOUBLE_ENTRY_VIOLATION remains unchanged', async () => {
    env.CUSTODY_ENABLED = false; // isolate Check-2
    // Seed a TRADING_FEE transaction with unbalanced entries
    const txId = 'tx_unbalanced_' + crypto.randomUUID();
    await db.query(
      `INSERT INTO ledger_transactions (id, account_id, transaction_type, reference_id, description, metadata) VALUES ($1, $2, $3, $4, $5, $6)`,
      [txId, accountId, 'TRADING_FEE', 'ref_' + txId, 'unbalanced', '{}']
    );
    // One CREDIT with no matching DEBIT => net non-zero => DOUBLE_ENTRY_VIOLATION
    await db.query(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, asset, direction, amount, balance_after) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['entry_' + crypto.randomUUID(), txId, accountId, 'USDT', 'CREDIT', '100', '100']
    );

    const report = await reconciliationService.runReconciliation('TEST');
    const doubleEntry = report.details.find((d: any) => d.type === 'DOUBLE_ENTRY_VIOLATION');
    expect(doubleEntry).toBeDefined();
    expect(doubleEntry?.transactionId).toBe(txId);
    expect(doubleEntry?.discrepancy).not.toBe('0');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 24: Read-only guarantee
  // ─────────────────────────────────────────────────────────────────────────

  it('24. Reconciliation remains read-only for wallet and ledger', async () => {
    await seedInternalBalance('100', '0');
    mockCustodyProvider.seedBalance({ accountId: 'mock', asset, network, available: '90', locked: '0', total: '90', updatedAt: new Date() });

    // Snapshot wallet_balances and ledger before reconciliation
    const walletBefore = await db.query('SELECT * FROM wallet_balances');
    const ledgerEntriesBefore = await db.query('SELECT * FROM ledger_entries');
    const withdrawalsBefore = await db.query('SELECT * FROM withdrawals');

    // Run reconciliation (critical mismatch -> should trigger halt but NOT modify balances)
    await reconciliationService.runReconciliation('TEST');

    const walletAfter = await db.query('SELECT * FROM wallet_balances');
    const ledgerEntriesAfter = await db.query('SELECT * FROM ledger_entries');
    const withdrawalsAfter = await db.query('SELECT * FROM withdrawals');

    // Wallet and ledger must be identical
    expect(JSON.stringify(walletAfter.rows)).toBe(JSON.stringify(walletBefore.rows));
    expect(JSON.stringify(ledgerEntriesAfter.rows)).toBe(JSON.stringify(ledgerEntriesBefore.rows));
    expect(JSON.stringify(withdrawalsAfter.rows)).toBe(JSON.stringify(withdrawalsBefore.rows));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Fractional precision proof — no Number()/parseFloat() anywhere
  // ─────────────────────────────────────────────────────────────────────────

  it('fractional precision: exact 0.000000000000000001 above tolerance => CRITICAL', async () => {
    // Internal 100.000000000000000001, custody 100, tolerance 0
    // diff = 0.000000000000000001, absDiff > tolerance (0) => CRITICAL
    await seedInternalBalance('100.000000000000000001', '0');
    mockCustodyProvider.seedBalance({ accountId: 'mock', asset, network, available: '100', locked: '0', total: '100', updatedAt: new Date() });

    const report = await reconciliationService.runReconciliation('TEST');
    const err = report.details.find((d: any) => d.type === 'CUSTODY_MISMATCH') as any;
    expect(err).toBeDefined();
    expect(err.severity).toBe('CRITICAL');
    // The exact fractional diff must be preserved as a string (not rounded by Number)
    expect(err.discrepancy).toBe('0.000000000000000001');
  });

  it('fractional precision: exact 0.000000000000000001 within tolerance => WARNING', async () => {
    // Internal 100.000000000000000001, custody 100, tolerance 0.000000000000000001
    // diff = 0.000000000000000001, absDiff == tolerance (0.000000000000000001) => WARNING
    await seedInternalBalance('100.000000000000000001', '0');
    mockCustodyProvider.seedBalance({ accountId: 'mock', asset, network, available: '100', locked: '0', total: '100', updatedAt: new Date() });

    // Tolerance deposit: 0.000000000000000001 = exactly the diff
    await db.query(
      `INSERT INTO blockchain_deposits (id, chain_id, asset, network, transaction_hash, block_number, block_hash, block_timestamp, log_index, to_address, amount, raw_amount, token_contract, decimals, confirmation_count, required_confirmations, status, detected_at, confirmed_at, reorged_at, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
      [crypto.randomUUID(), 'ethereum', asset, network, '0x', 1, '0x', new Date(), 0, '0x', '0x', '0.000000000000000001', '0.000000000000000001', null, 18, 1, 1, 'DETECTED', new Date(), null, null]
    );

    const report = await reconciliationService.runReconciliation('TEST');
    const err = report.details.find((d: any) => d.type === 'CUSTODY_MISMATCH') as any;
    expect(err).toBeDefined();
    expect(err.severity).toBe('WARNING');
    expect(err.tolerance).toBe('0.000000000000000001');
  });
});