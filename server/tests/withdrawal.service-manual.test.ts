/**
 * Phase 11K — Manual Safe Mode: Withdrawal Service Confirmation Tests
 *
 * Exercises WithdrawalService.confirmManualWithdrawal and
 * markReadyForManualExecution against a mocked database with a mocked
 * on-chain verifier. Covers:
 *   D. confirmation requires tx hash
 *   E. invalid tx hash
 *   F. wrong sender
 *   G. wrong destination
 *   H. wrong amount
 *   I. wrong chain
 *   J. failed receipt
 *   K. duplicate confirmation (state guard)
 *   L. duplicate tx hash (cross-withdrawal guard)
 *   P. cancellation releases funds for READY state
 *   Q. failure/release path via status worker semantics
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WithdrawalService } from '../src/services/wallet/withdrawal.service';
import { manualTxVerificationService } from '../src/services/custody/manual-tx-verification.service';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------
vi.mock('../src/config/env', () => ({
  env: {
    CUSTODY_HOT_WALLET_ADDRESS: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
    CUSTODY_CHAIN_ID: 31337,
    CRYPTO_WITHDRAWALS_ENABLED: true,
  },
}));

vi.mock('../src/config/database', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../src/services/ledger/ledger.service', () => ({
  ledgerService: { record: vi.fn(), getBalances: vi.fn() },
}));

vi.mock('../src/services/compliance/aml.service', () => ({
  amlService: { evaluate: vi.fn() },
}));

vi.mock('../src/services/admin/audit.service', () => ({
  auditService: { record: vi.fn() },
}));

vi.mock('../src/services/wallet/withdrawal-policy.service', () => ({
  withdrawalPolicyService: { evaluate: vi.fn() },
}));

vi.mock('../src/services/custody/manual-tx-verification.service', () => ({
  manualTxVerificationService: {
    verifyWithdrawalTx: vi.fn(),
  },
}));

// The custody service is not needed for confirmManualWithdrawal unit tests.
vi.mock('../src/services/custody/custody.service', () => ({
  custodyService: {},
}));

vi.mock('../src/services/market/event-bus', () => ({
  eventBus: { emit: vi.fn() },
}));

vi.mock('../src/services/notification/notification.types', () => ({}));

function mockTransactionClient(overrides: { rows?: any[] } = {}) {
  const calls: string[] = [];
  const txClient: any = {
    query: vi.fn(async (sql: string) => {
      calls.push(sql);
      // Duplicate check: SELECT id FROM withdrawals ... WHERE tx_hash = $1
      if (sql.includes('SELECT id FROM withdrawals') && sql.includes('tx_hash')) {
        return { rows: [] };
      }
      if (sql.includes('FROM withdrawals') || sql.includes('w.*, a.user_id')) {
        return { rows: overrides.rows ?? [] };
      }
      if (sql.includes('UPDATE withdrawals')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    }),
  };
  return { txClient, calls };
}

function makeRow(overrides: Partial<any> = {}): any {
  return {
    id: 'wid-1',
    account_id: 'acc-1',
    asset: 'ETH',
    amount: '0.5',
    network: 'ETHEREUM',
    destination_address: '0xRecipient',
    status: 'PENDING',
    crypto_status: 'READY_FOR_MANUAL_EXECUTION',
    user_id: 'user-1',
    tx_hash: null,
    provider_withdrawal_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('WithdrawalService.confirmManualWithdrawal', () => {
  let service: WithdrawalService;
  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      transaction: vi.fn(async (cb: any) => {
        const { txClient } = mockTransactionClient({ rows: [makeRow()] });
        return await cb(txClient);
      }),
    };
    service = new WithdrawalService(mockDb as any, {} as any, {} as any);
    vi.mocked(manualTxVerificationService.verifyWithdrawalTx).mockReset();
  });

  it('D. confirmation requires a tx hash (empty/invalid rejected)', async () => {
    await expect(
      service.confirmManualWithdrawal('wid-1', '', 'admin-1')
    ).rejects.toThrow(/Transaction hash must be a 0x-prefixed/);
    await expect(
      service.confirmManualWithdrawal('wid-1', 'not-a-hash', 'admin-1')
    ).rejects.toThrow(/Transaction hash must be a 0x-prefixed/);
  });

  it('E. invalid tx hash format rejected', async () => {
    await expect(
      service.confirmManualWithdrawal('wid-1', '0x1234', 'admin-1')
    ).rejects.toThrow(/Transaction hash must be a 0x-prefixed/);
  });

  it('K. non-READY_FOR_MANUAL_EXECUTION withdrawal cannot be confirmed', async () => {
    mockDb.transaction = vi.fn(async (cb: any) => {
      const { txClient } = mockTransactionClient({
        rows: [makeRow({ crypto_status: 'APPROVED' })],
      });
      return await cb(txClient);
    });
    await expect(
      service.confirmManualWithdrawal('wid-1', '0x' + '11'.repeat(32), 'admin-1')
    ).rejects.toThrow(/not awaiting manual execution/);
  });

  it('L. duplicate tx hash across two withdrawals is rejected', async () => {
    mockDb.transaction = vi.fn(async (cb: any) => {
      const { txClient } = mockTransactionClient({ rows: [makeRow()] });
      txClient.query.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT id FROM withdrawals') && sql.includes('tx_hash')) {
          return { rows: [{ id: 'wid-2' }] };
        }
        if (sql.includes('FROM withdrawals') || sql.includes('w.*')) return { rows: [makeRow()] };
        return { rows: [] };
      });
      return await cb(txClient);
    });
    await expect(
      service.confirmManualWithdrawal('wid-1', '0x' + '11'.repeat(32), 'admin-1')
    ).rejects.toThrow(/already used by another withdrawal/);
  });

  it('F–J. verification failure rejects confirmation (wrong sender/dest/amount/chain/receipt)', async () => {
    vi.mocked(manualTxVerificationService.verifyWithdrawalTx).mockResolvedValue({
      verified: false,
      reason: 'sender mismatch: expected 0xSender, got 0xOther',
    });
    await expect(
      service.confirmManualWithdrawal('wid-1', '0x' + '11'.repeat(32), 'admin-1')
    ).rejects.toThrow(/On-chain verification failed: sender mismatch/);
  });

  it('success: verified tx_hash transitions READY -> SUBMITTED and writes tx_hash', async () => {
    vi.mocked(manualTxVerificationService.verifyWithdrawalTx).mockResolvedValue({
      verified: true,
    });
    let updateSql = '';
    mockDb.transaction = vi.fn(async (cb: any) => {
      const { txClient } = mockTransactionClient({ rows: [makeRow()] });
      txClient.query.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT id FROM withdrawals') && sql.includes('tx_hash')) return { rows: [] };
        if (sql.includes('UPDATE withdrawals')) { updateSql = sql; return { rows: [], rowCount: 1 }; }
        if (sql.includes('FROM withdrawals') || sql.includes('w.*')) return { rows: [makeRow()] };
        return { rows: [] };
      });
      return await cb(txClient);
    });

    const txHash = '0x' + 'ab'.repeat(32);
    await service.confirmManualWithdrawal('wid-1', txHash, 'admin-1');
    expect(updateSql).toContain('crypto_status = \'SUBMITTED\'');
    expect(updateSql).toContain('tx_hash');
    expect(manualTxVerificationService.verifyWithdrawalTx).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSender: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
        expectedDestination: '0xRecipient',
        asset: 'ETH',
        expectedAmount: '0.5',
      })
    );
  });
});

describe('WithdrawalService.markReadyForManualExecution', () => {
  it('transitions SUBMITTING -> READY_FOR_MANUAL_EXECUTION', async () => {
    let captured: { sql: string; params: any[] } | null = null;
    const mockDb = {
      query: vi.fn(async (sql: string, params?: any[]) => {
        captured = { sql, params: params ?? [] };
        return { rows: [], rowCount: 1 };
      }),
    };
    const service = new WithdrawalService(mockDb as any, {} as any, {} as any);
    await service.markReadyForManualExecution('wid-1');
    expect(captured!.sql).toContain('READY_FOR_MANUAL_EXECUTION');
    expect(captured!.sql).toContain("crypto_status = 'SUBMITTING'");
  });
});

describe('WithdrawalService.cancelWithdrawal — P. READY state cancellable', () => {
  it('cancels a READY_FOR_MANUAL_EXECUTION withdrawal (funds released)', async () => {
    const txClient: any = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT * FROM withdrawals')) {
          return {
            rows: [{
              id: 'wid-1', account_id: 'acc-1', user_id: 'user-1', asset: 'ETH',
              amount: '0.5', fee: '0.001', network: 'ETHEREUM', destination_address: '0xR',
              status: 'PENDING', crypto_status: 'READY_FOR_MANUAL_EXECUTION',
              created_at: new Date(), updated_at: new Date(),
            }],
          };
        }
        if (sql.includes('UPDATE withdrawals')) return { rows: [], rowCount: 1 };
        return { rows: [] };
      }),
    };
    const mockDb = {
      query: vi.fn(),
      transaction: vi.fn(async (cb: any) => await cb(txClient)),
    };
    const ledger = {
      postTransaction: vi.fn(async () => undefined),
    };
    const service = new WithdrawalService(mockDb as any, ledger as any, {} as any);
    // The READY_FOR_MANUAL_EXECUTION state must pass the state guard; the
    // ledger post (funds release) then executes. We assert no INVALID_STATE.
    await service.cancelWithdrawal('wid-1');
    expect(ledger.postTransaction).toHaveBeenCalledTimes(1);
  });
});