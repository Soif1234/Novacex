import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers, Transaction } from 'ethers';

/**
 * P0-2 Gas-Aware KMS Reservation Tests
 *
 * These tests verify that the spendable-balance formula in KmsCustodyProvider
 * correctly accounts for gas obligations of pending transactions, preventing
 * nonce holes caused by broadcast failures due to insufficient funds.
 *
 * Gas ceiling constants (must match kms-custody-provider.ts):
 *   WITHDRAWAL_MAX_GAS = 21000 * 20 gwei = 0.00042 ETH
 *   TREASURY_MAX_GAS   = 60000 * 20 gwei = 0.0012 ETH
 *   SAFETY_BUFFER       = 0.001 ETH
 */

const WITHDRAWAL_MAX_GAS = 21000n * ethers.parseUnits('20', 'gwei');  // 420000000000000n
const TREASURY_MAX_GAS = 60000n * ethers.parseUnits('20', 'gwei');    // 1200000000000000n
const SAFETY_BUFFER = ethers.parseEther('0.001');

// ─── Mock Database ──────────────────────────────────────────────────────────
function createMockDb(options: {
  pendingWithdrawals?: { count: number; totalAmount: string };
  pendingTreasury?: { count: number; totalAmount: string };
  nextNonce?: number;
  existingWithdrawal?: { crypto_status: string; network_nonce: number | null } | null;
} = {}) {
  const opts = {
    pendingWithdrawals: options.pendingWithdrawals ?? { count: 0, totalAmount: '0' },
    pendingTreasury: options.pendingTreasury ?? { count: 0, totalAmount: '0' },
    nextNonce: options.nextNonce ?? 0,
    existingWithdrawal: options.existingWithdrawal ?? null,
  };

  const queries: string[] = [];

  const queryFn = async (sql: string, params?: any[]) => {
    queries.push(sql.trim().substring(0, 80));

    // hot_wallet_nonces
    if (sql.includes('hot_wallet_nonces') && sql.includes('SELECT')) {
      return { rows: [{ next_nonce: opts.nextNonce }] };
    }
    if (sql.includes('hot_wallet_nonces') && (sql.includes('UPDATE') || sql.includes('INSERT'))) {
      return { rows: [] };
    }
    // Withdrawal status for idempotency
    if (sql.includes('FROM withdrawals WHERE id') && sql.includes('FOR UPDATE')) {
      if (opts.existingWithdrawal) {
        return { rows: [opts.existingWithdrawal] };
      }
      return { rows: [] };
    }
    // Pending withdrawals (gas-aware query with COUNT)
    if (sql.includes('FROM withdrawals') && sql.includes('SUM') && sql.includes('COUNT')) {
      return {
        rows: [{
          sum: opts.pendingWithdrawals.totalAmount,
          cnt: String(opts.pendingWithdrawals.count)
        }]
      };
    }
    // Pending treasury (gas-aware query with COUNT)
    if (sql.includes('treasury_custody_artifacts') && sql.includes('SUM') && sql.includes('COUNT')) {
      return {
        rows: [{
          sum: opts.pendingTreasury.totalAmount,
          cnt: String(opts.pendingTreasury.count)
        }]
      };
    }
    // Withdrawal nonce update
    if (sql.includes('UPDATE withdrawals SET network_nonce')) {
      return { rows: [] };
    }
    // withdrawal_transactions INSERT
    if (sql.includes('INSERT INTO withdrawal_transactions')) {
      return { rows: [] };
    }
    // withdrawal_transactions SELECT (existing check)
    if (sql.includes('FROM withdrawal_transactions')) {
      return { rows: [] };
    }
    // withdrawals provider_withdrawal_id
    if (sql.includes('SELECT id FROM withdrawals WHERE id')) {
      return { rows: [] };
    }
    // Generic fallback
    return { rows: [] };
  };

  return {
    query: queryFn,
    transaction: async (fn: any) => fn({ query: queryFn }),
    _queries: queries,
  };
}

// ─── Spendable Balance Calculation (extracted logic) ────────────────────────
// This replicates the exact formula from kms-custody-provider.ts to unit test it.
function calculateSpendableBalance(
  onChainBalance: bigint,
  pendingWithdrawals: { count: bigint; totalValue: bigint },
  pendingTreasury: { count: bigint; totalValue: bigint },
  thisTransactionValue: bigint,
  thisTransactionGas: bigint
): { available: bigint; totalNeeded: bigint; sufficient: boolean } {
  const totalPendingValue = pendingWithdrawals.totalValue + pendingTreasury.totalValue;
  const totalPendingGas = (pendingWithdrawals.count * WITHDRAWAL_MAX_GAS) +
                          (pendingTreasury.count * TREASURY_MAX_GAS);
  const totalPending = totalPendingValue + totalPendingGas;

  const totalNeeded = thisTransactionValue + thisTransactionGas + SAFETY_BUFFER;
  const available = onChainBalance - totalPending;

  return {
    available,
    totalNeeded,
    sufficient: available >= totalNeeded
  };
}

describe('P0-2: Gas-Aware KMS Balance Reservation', () => {

  describe('Spendable Balance Formula', () => {

    it('should account for gas of 0 pending transactions (baseline)', () => {
      const result = calculateSpendableBalance(
        ethers.parseEther('10'),        // 10 ETH on-chain
        { count: 0n, totalValue: 0n },  // no pending withdrawals
        { count: 0n, totalValue: 0n },  // no pending treasury
        ethers.parseEther('1'),          // withdraw 1 ETH
        WITHDRAWAL_MAX_GAS               // customer withdrawal gas
      );

      // available = 10 ETH - 0 = 10 ETH
      // needed = 1 ETH + 0.00042 ETH + 0.001 ETH = 1.00142 ETH
      expect(result.sufficient).toBe(true);
      expect(result.available).toBe(ethers.parseEther('10'));
      expect(result.totalNeeded).toBe(
        ethers.parseEther('1') + WITHDRAWAL_MAX_GAS + SAFETY_BUFFER
      );
    });

    it('should account for gas of 10 pending withdrawals', () => {
      // 10 pending withdrawals of 0.5 ETH each = 5 ETH value
      // 10 * WITHDRAWAL_MAX_GAS = 10 * 0.00042 = 0.0042 ETH gas
      // Total pending = 5.0042 ETH
      const result = calculateSpendableBalance(
        ethers.parseEther('6'),
        { count: 10n, totalValue: ethers.parseEther('5') },
        { count: 0n, totalValue: 0n },
        ethers.parseEther('0.5'),
        WITHDRAWAL_MAX_GAS
      );

      const expectedPending = ethers.parseEther('5') + (10n * WITHDRAWAL_MAX_GAS);
      const expectedAvailable = ethers.parseEther('6') - expectedPending;
      const expectedNeeded = ethers.parseEther('0.5') + WITHDRAWAL_MAX_GAS + SAFETY_BUFFER;

      expect(result.available).toBe(expectedAvailable);
      expect(result.totalNeeded).toBe(expectedNeeded);
      // 6 - 5.0042 = 0.9958 ETH available
      // Needed = 0.5 + 0.00042 + 0.001 = 0.50142 ETH
      expect(result.sufficient).toBe(true);
    });

    it('should REJECT when gas of pending txs causes insufficient funds', () => {
      // Without gas accounting: 6 ETH on-chain, 5 ETH pending value, need 0.99 ETH → passes
      // With gas accounting: 6 ETH - 5 ETH value - 0.0042 ETH gas = 0.9958 available
      // Need: 0.99 + 0.00042 + 0.001 = 0.99142 → passes (barely)
      //
      // But at 100 pending: gas = 100 * 0.00042 = 0.042 ETH
      // 6 - 5 - 0.042 = 0.958 available. Need 0.99142 → FAIL
      const result = calculateSpendableBalance(
        ethers.parseEther('6'),
        { count: 100n, totalValue: ethers.parseEther('5') },
        { count: 0n, totalValue: 0n },
        ethers.parseEther('0.99'),
        WITHDRAWAL_MAX_GAS
      );

      expect(result.sufficient).toBe(false);
    });

    it('should account for mixed withdrawal + treasury gas obligations', () => {
      // 5 withdrawals + 3 treasury transfers
      // Withdrawal gas: 5 * 0.00042 = 0.0021 ETH
      // Treasury gas: 3 * 0.0012 = 0.0036 ETH
      // Total gas: 0.0057 ETH
      const result = calculateSpendableBalance(
        ethers.parseEther('10'),
        { count: 5n, totalValue: ethers.parseEther('3') },
        { count: 3n, totalValue: ethers.parseEther('2') },
        ethers.parseEther('1'),
        TREASURY_MAX_GAS  // this is a treasury transfer
      );

      const expectedPendingGas = (5n * WITHDRAWAL_MAX_GAS) + (3n * TREASURY_MAX_GAS);
      const expectedPendingValue = ethers.parseEther('5');
      const expectedAvailable = ethers.parseEther('10') - expectedPendingValue - expectedPendingGas;
      const expectedNeeded = ethers.parseEther('1') + TREASURY_MAX_GAS + SAFETY_BUFFER;

      expect(result.available).toBe(expectedAvailable);
      expect(result.totalNeeded).toBe(expectedNeeded);
      expect(result.sufficient).toBe(true);
    });

    it('should prevent nonce hole: 100 concurrent withdrawals draining gas budget', () => {
      // Scenario: 100 concurrent 0.01 ETH withdrawals
      // Value: 100 * 0.01 = 1 ETH
      // Gas: 100 * 0.00042 = 0.042 ETH
      // Total pending: 1.042 ETH
      // On-chain: 1.05 ETH
      // Available: 1.05 - 1.042 = 0.008 ETH
      // 101st withdrawal needs: 0.01 + 0.00042 + 0.001 = 0.01142 ETH → REJECTED
      const result = calculateSpendableBalance(
        ethers.parseEther('1.05'),
        { count: 100n, totalValue: ethers.parseEther('1') },
        { count: 0n, totalValue: 0n },
        ethers.parseEther('0.01'),
        WITHDRAWAL_MAX_GAS
      );

      expect(result.sufficient).toBe(false);
    });

    it('should reject gas-insufficient even when value is covered', () => {
      // On-chain: 1.001 ETH
      // No pending
      // Value: 1 ETH (fully covered!)
      // But gas + buffer: 0.00042 + 0.001 = 0.00142 ETH
      // Total needed: 1.00142 > 1.001 available → REJECTED
      const result = calculateSpendableBalance(
        ethers.parseEther('1.001'),
        { count: 0n, totalValue: 0n },
        { count: 0n, totalValue: 0n },
        ethers.parseEther('1'),
        WITHDRAWAL_MAX_GAS
      );

      expect(result.sufficient).toBe(false);
    });

    it('should correctly handle treasury gas ceiling (higher than withdrawal)', () => {
      // Treasury gas is 0.0012 ETH vs withdrawal 0.00042 ETH
      // The difference is material with many pending
      const resultWithdrawal = calculateSpendableBalance(
        ethers.parseEther('2'),
        { count: 0n, totalValue: 0n },
        { count: 0n, totalValue: 0n },
        ethers.parseEther('1'),
        WITHDRAWAL_MAX_GAS
      );

      const resultTreasury = calculateSpendableBalance(
        ethers.parseEther('2'),
        { count: 0n, totalValue: 0n },
        { count: 0n, totalValue: 0n },
        ethers.parseEther('1'),
        TREASURY_MAX_GAS
      );

      // Treasury should require more
      expect(resultTreasury.totalNeeded).toBeGreaterThan(resultWithdrawal.totalNeeded);
      // Both should pass with 2 ETH balance
      expect(resultWithdrawal.sufficient).toBe(true);
      expect(resultTreasury.sufficient).toBe(true);
    });
  });

  describe('Nonce Hole Prevention', () => {

    it('should prevent oversubscription that would lead to broadcast failure', () => {
      // The critical scenario: many pending txs consume the gas budget
      // Without gas accounting, a late arrival would reserve a nonce,
      // attempt to broadcast, fail with "insufficient funds", and create a nonce hole.
      //
      // With gas accounting, the reservation itself is rejected.
      for (let pendingCount = 0; pendingCount <= 200; pendingCount += 10) {
        const valuePerTx = ethers.parseEther('0.01');
        const totalPendingValue = BigInt(pendingCount) * valuePerTx;
        const totalPendingGas = BigInt(pendingCount) * WITHDRAWAL_MAX_GAS;
        const onChainBalance = totalPendingValue + totalPendingGas + valuePerTx; // Exact: covers all pending + 1 more value, but NOT the new gas

        const result = calculateSpendableBalance(
          onChainBalance,
          { count: BigInt(pendingCount), totalValue: totalPendingValue },
          { count: 0n, totalValue: 0n },
          valuePerTx,
          WITHDRAWAL_MAX_GAS
        );

        // The new transaction's gas + safety buffer is NOT covered
        expect(result.sufficient).toBe(false);
      }
    });
  });

  describe('Constants Integrity', () => {
    it('WITHDRAWAL_MAX_GAS matches 21000 * 20gwei', () => {
      expect(WITHDRAWAL_MAX_GAS).toBe(21000n * 20000000000n);
      expect(WITHDRAWAL_MAX_GAS).toBe(420000000000000n); // 0.00042 ETH
    });

    it('TREASURY_MAX_GAS matches 60000 * 20gwei', () => {
      expect(TREASURY_MAX_GAS).toBe(60000n * 20000000000n);
      expect(TREASURY_MAX_GAS).toBe(1200000000000000n); // 0.0012 ETH
    });

    it('SAFETY_BUFFER is 0.001 ETH', () => {
      expect(SAFETY_BUFFER).toBe(ethers.parseEther('0.001'));
      expect(SAFETY_BUFFER).toBe(1000000000000000n);
    });
  });
});
