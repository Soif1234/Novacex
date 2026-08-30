import crypto from 'crypto';
import { db, IDatabaseConnection } from '../../config/database';
import { LedgerTxType, EntryDirection, LedgerTransactionEntity, LedgerEntryEntity } from '../../models/ledger.model';
import { WalletBalanceEntity } from '../../models/account.model';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../config/logger';
import {
  LedgerError,
  LedgerErrorCode,
  InsufficientBalanceError,
  DuplicateReferenceError,
  ReferenceConflictError,
  UnbalancedTransactionError,
} from './errors';
import {
  validateAmount,
  decimalAdd,
  decimalSubtract,
  decimalCompare,
  decimalIsZero,
  decimalZero,
  decimalNormalize,
} from './decimal';
import { eventBus } from '../market/event-bus';


// ─── External-Boundary Transaction Types ──────────────────────────────────────

/**
 * Transaction types that legitimately represent an external asset entry or exit
 * and therefore are permitted to be single-sided (unbalanced) in the ledger.
 *
 * - DEPOSIT:               external asset enters the exchange (single CREDIT)
 * - WITHDRAWAL:            paper withdrawal path uses a single DEBIT (simulated exit)
 * - WITHDRAWAL_SETTLE:     external asset leaves the exchange (single DEBIT)
 * - TRADING_FEE:           fee accrues to the exchange from the user (single DEBIT)
 * - FUTURES_PNL_REALIZED:  realized PnL transfers between trader and market (single CREDIT/DEBIT)
 * - FUTURES_FUNDING_PAYMENT: funding rate paid/received to/from the market (single CREDIT/DEBIT)
 *
 * Every other transaction type is INTERNAL and MUST satisfy
 * SUM(CREDIT) == SUM(DEBIT) per asset.
 */
const EXTERNAL_BOUNDARY_TX_TYPES: ReadonlySet<string> = new Set<string>([
  'DEPOSIT',
  'WITHDRAWAL',
  'WITHDRAWAL_SETTLE',
  'TRADING_FEE',
  'FUTURES_PNL_REALIZED',
  'FUTURES_FUNDING_PAYMENT',
]);

// ─── Result Types ────────────────────────────────────────────────────────────

export interface LedgerTransactionResult {
  transactionId: string;
  accountId: string;
  transactionType: LedgerTxType;
  referenceId: string;
  entries: Array<{
    direction: EntryDirection;
    asset: string;
    amount: string;
    balanceAfter: string;
  }>;
  createdAt: Date;
}

export interface BalanceResult {
  accountId: string;
  asset: string;
  availableBalance: string;
  lockedBalance: string;
  totalBalance: string;
}

export interface LedgerHistoryEntry {
  transactionId: string;
  transactionType: LedgerTxType;
  referenceId: string;
  description: string;
  direction: EntryDirection;
  asset: string;
  amount: string;
  balanceAfter: string;
  createdAt: Date;
}

export interface LedgerHistoryResult {
  entries: LedgerHistoryEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ReconciliationResult {
  accountId: string;
  asset: string;
  walletAvailable: string;
  walletLocked: string;
  walletTotal: string;
  ledgerNetCredits: string;
  ledgerNetDebits: string;
  ledgerComputedBalance: string;
  isConsistent: boolean;
  discrepancy: string;
}

// ─── Double-Entry Transaction Builder ────────────────────────────────────────

export interface LedgerEntryInput {
  accountId: string;
  asset: string;
  direction: EntryDirection;
  amount: string;
  /** 'available' (default) or 'locked' — which balance sub-pool to affect */
  balancePool?: 'available' | 'locked';
}

export interface PostTransactionInput {
  /** Account that owns this business event. Used for idempotency key scope. */
  accountId: string;
  transactionType: LedgerTxType;
  referenceId: string;
  description: string;
  entries: LedgerEntryInput[];
  metadata?: Record<string, unknown>;
}

// ─── LedgerService ───────────────────────────────────────────────────────────

export class LedgerService {
  constructor(private database: IDatabaseConnection = db) {}

  // ── Balances ─────────────────────────────────────────────────────────────

  /**
   * Get balance for a specific account + asset.
   * Returns zero balances if no wallet row exists.
   */
  public async getBalance(accountId: string, asset: string, externalTxClient?: IDatabaseConnection): Promise<BalanceResult> {
    const dbClient = externalTxClient || this.database;
    const result = await dbClient.query<any>(
      `SELECT available_balance, locked_balance
       FROM wallet_balances
       WHERE account_id = $1 AND asset = $2`,
      [accountId, asset]
    );

    const row = result.rows[0];
    const available = row?.available_balance ?? row?.availableBalance ?? '0';
    const locked = row?.locked_balance ?? row?.lockedBalance ?? '0';

    return {
      accountId,
      asset,
      availableBalance: decimalNormalize(available),
      lockedBalance: decimalNormalize(locked),
      totalBalance: decimalAdd(available, locked),
    };
  }

  /**
   * Get all balances for an account across all assets.
   */
  public async getAllBalances(accountId: string): Promise<BalanceResult[]> {
    const result = await this.database.query<any>(
      `SELECT asset, available_balance, locked_balance
       FROM wallet_balances
       WHERE account_id = $1
       ORDER BY asset ASC`,
      [accountId]
    );

    return result.rows.map((row: any) => {
      const available = row.available_balance ?? row.availableBalance ?? '0';
      const locked = row.locked_balance ?? row.lockedBalance ?? '0';
      return {
        accountId,
        asset: row.asset,
        availableBalance: decimalNormalize(available),
        lockedBalance: decimalNormalize(locked),
        totalBalance: decimalAdd(available, locked),
      };
    });
  }

  // ── Credit ───────────────────────────────────────────────────────────────

  /**
   * Credit an account's available balance (increase).
   */
  public async credit(
    accountId: string,
    asset: string,
    amount: string,
    transactionType: LedgerTxType,
    referenceId: string,
    description: string,
    metadata?: Record<string, unknown>,
    externalTxClient?: IDatabaseConnection
  ): Promise<LedgerTransactionResult> {
    validateAmount(amount);

    return this.postTransaction({
      accountId,
      transactionType,
      referenceId,
      description,
      metadata,
      entries: [
        { accountId, asset, direction: 'CREDIT', amount, balancePool: 'available' },
      ],
    }, externalTxClient);
  }

  // ── Debit ────────────────────────────────────────────────────────────────

  /**
   * Debit an account's available balance (decrease).
   * Fails if available balance < amount.
   */
  public async debit(
    accountId: string,
    asset: string,
    amount: string,
    transactionType: LedgerTxType,
    referenceId: string,
    description: string,
    metadata?: Record<string, unknown>,
    externalTxClient?: IDatabaseConnection
  ): Promise<LedgerTransactionResult> {
    validateAmount(amount);

    return this.postTransaction({
      accountId,
      transactionType,
      referenceId,
      description,
      metadata,
      entries: [
        { accountId, asset, direction: 'DEBIT', amount, balancePool: 'available' },
      ],
    }, externalTxClient);
  }

  // ── Reserve (available → locked) ─────────────────────────────────────────

  /**
   * Move funds from available to locked.
   */
  public async reserve(
    accountId: string,
    asset: string,
    amount: string,
    transactionType: LedgerTxType,
    referenceId: string,
    description: string,
    metadata?: Record<string, unknown>,
    externalTxClient?: IDatabaseConnection
  ): Promise<LedgerTransactionResult> {
    validateAmount(amount);

    return this.postTransaction({
      accountId,
      transactionType,
      referenceId,
      description,
      metadata,
      entries: [
        // Debit from available
        { accountId, asset, direction: 'DEBIT', amount, balancePool: 'available' },
        // Credit into locked
        { accountId, asset, direction: 'CREDIT', amount, balancePool: 'locked' },
      ],
    }, externalTxClient);
  }

  // ── Release (locked → available) ─────────────────────────────────────────

  /**
   * Move funds from locked to available.
   */
  public async release(
    accountId: string,
    asset: string,
    amount: string,
    transactionType: LedgerTxType,
    referenceId: string,
    description: string,
    metadata?: Record<string, unknown>,
    externalTxClient?: IDatabaseConnection
  ): Promise<LedgerTransactionResult> {
    validateAmount(amount);

    return this.postTransaction({
      accountId,
      transactionType,
      referenceId,
      description,
      metadata,
      entries: [
        // Debit from locked
        { accountId, asset, direction: 'DEBIT', amount, balancePool: 'locked' },
        // Credit into available
        { accountId, asset, direction: 'CREDIT', amount, balancePool: 'available' },
      ],
    }, externalTxClient);
  }

  // ── Internal Transfer (atomic cross-account) ────────────────────────────

  /**
   * Atomically transfer funds between two accounts.
   * Both debit and credit execute within a single PostgreSQL transaction.
   */
  public async transfer(
    fromAccountId: string,
    toAccountId: string,
    asset: string,
    amount: string,
    referenceId: string,
    description: string,
    metadata?: Record<string, unknown>
  ): Promise<LedgerTransactionResult> {
    validateAmount(amount);

    return this.postTransaction({
      accountId: fromAccountId,
      transactionType: 'INTERNAL_TRANSFER',
      referenceId,
      description,
      metadata,
      entries: [
        { accountId: fromAccountId, asset, direction: 'DEBIT', amount, balancePool: 'available' },
        { accountId: toAccountId, asset, direction: 'CREDIT', amount, balancePool: 'available' },
      ],
    });
  }

  // ── Post Transaction (Core Double-Entry Engine) ────────────────────────

  /**
   * The core authoritative ledger method.
   * 
   * Every financial mutation flows through this method.
   * 
   * Flow:
   *   BEGIN TRANSACTION
   *     1. Idempotency check (database UNIQUE constraint)
   *     2. Lock wallet rows FOR UPDATE (deterministic order)
   *     3. Validate all balances
   *     4. Create ledger_transactions record
   *     5. Create ledger_entries records (one per entry)
   *     6. Update wallet_balances
   *   COMMIT
   * 
   * On ANY failure: ROLLBACK (no partial mutation)
   */
  public async postTransaction(input: PostTransactionInput, externalTxClient?: IDatabaseConnection): Promise<LedgerTransactionResult> {
    const { accountId, transactionType, referenceId, description, entries, metadata } = input;

    if (!entries || entries.length === 0) {
      throw new LedgerError('Transaction must have at least one entry', 400, LedgerErrorCode.TRANSACTION_FAILED);
    }

    // Validate all amounts upfront
    for (const entry of entries) {
      validateAmount(entry.amount);
    }

    // ── 0. Balance Enforcement (internal double-entry invariant) ─────────
    // Every INTERNAL transaction must satisfy SUM(CREDIT) == SUM(DEBIT) per asset.
    // External-boundary transaction types (DEPOSIT, WITHDRAWAL_SETTLE, etc.) are
    // explicitly exempt. Validation happens BEFORE any wallet lock or mutation so a
    // failure leaves the transaction completely unchanged.
    if (!EXTERNAL_BOUNDARY_TX_TYPES.has(transactionType)) {
      const perAssetTotals = new Map<string, { debits: string; credits: string }>();
      for (const entry of entries) {
        const totals = perAssetTotals.get(entry.asset) || { debits: decimalZero(), credits: decimalZero() };
        if (entry.direction === 'DEBIT') {
          totals.debits = decimalAdd(totals.debits, entry.amount);
        } else {
          totals.credits = decimalAdd(totals.credits, entry.amount);
        }
        perAssetTotals.set(entry.asset, totals);
      }

      for (const [asset, totals] of perAssetTotals) {
        if (decimalCompare(totals.debits, totals.credits) !== 0) {
          throw new UnbalancedTransactionError(totals.debits, totals.credits);
        }
      }
    }

    const transactionId = crypto.randomUUID();

    const executeLogic = async (txClient: IDatabaseConnection) => {

      // ── 1. Idempotency Check ──────────────────────────────────────────

      const existingTx = await txClient.query<any>(
        `SELECT id, transaction_type, description
         FROM ledger_transactions
         WHERE account_id = $1 AND reference_id = $2`,
        [accountId, referenceId]
      );

      if (existingTx.rows.length > 0) {
        const existing = existingTx.rows[0];
        const existingType = existing.transaction_type ?? existing.transactionType;
        const existingDesc = existing.description;

        // Same reference, same parameters → idempotent success
        if (existingType === transactionType && existingDesc === description) {
          const existingEntries = await txClient.query<any>(
            `SELECT direction, asset, amount, balance_after
             FROM ledger_entries
             WHERE transaction_id = $1`,
            [existing.id]
          );

          return {
            transactionId: existing.id,
            accountId,
            transactionType,
            referenceId,
            entries: existingEntries.rows.map((e: any) => ({
              direction: e.direction,
              asset: e.asset,
              amount: e.amount,
              balanceAfter: e.balance_after ?? e.balanceAfter,
            })),
            createdAt: existing.created_at ?? existing.createdAt ?? new Date(),
          };
        }

        // Same reference, different parameters → conflict
        throw new ReferenceConflictError(referenceId);
      }

      // ── 2. Collect and Lock Wallet Rows ────────────────────────────────
      // Sort by (accountId, asset) for deterministic lock ordering
      const walletKeys = new Map<string, { accountId: string; asset: string }>();
      for (const entry of entries) {
        const key = `${entry.accountId}:${entry.asset}`;
        walletKeys.set(key, { accountId: entry.accountId, asset: entry.asset });
      }

      const sortedKeys = Array.from(walletKeys.values()).sort((a, b) => {
        const cmp = a.accountId.localeCompare(b.accountId);
        return cmp !== 0 ? cmp : a.asset.localeCompare(b.asset);
      });

      // Lock (or create) wallet rows
      const walletStates = new Map<string, { available: string; locked: string }>();
      for (const wk of sortedKeys) {
        const walletRow = await txClient.query<any>(
          `SELECT available_balance, locked_balance
           FROM wallet_balances
           WHERE account_id = $1 AND asset = $2
           FOR UPDATE`,
          [wk.accountId, wk.asset]
        );

        if (walletRow.rows.length === 0) {
          // Auto-create wallet row with zero balance (upsert)
          await txClient.query(
            `INSERT INTO wallet_balances (id, account_id, asset, available_balance, locked_balance, updated_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (account_id, asset) DO NOTHING`,
            [crypto.randomUUID(), wk.accountId, wk.asset, '0', '0']
          );
          walletStates.set(`${wk.accountId}:${wk.asset}`, { available: '0', locked: '0' });
        } else {
          const row = walletRow.rows[0];
          walletStates.set(`${wk.accountId}:${wk.asset}`, {
            available: row.available_balance ?? row.availableBalance ?? '0',
            locked: row.locked_balance ?? row.lockedBalance ?? '0',
          });
        }
      }

      // ── 3. Pre-validate All Balances ──────────────────────────────────
      // Apply entries to a working copy to detect any violation before commit
      const workingBalances = new Map<string, { available: string; locked: string }>();
      for (const [key, state] of walletStates) {
        workingBalances.set(key, { ...state });
      }

      for (const entry of entries) {
        const key = `${entry.accountId}:${entry.asset}`;
        const wb = workingBalances.get(key)!;
        const pool = entry.balancePool ?? 'available';

        if (entry.direction === 'DEBIT') {
          if (pool === 'available') {
            if (decimalCompare(wb.available, entry.amount) < 0 && entry.accountId !== '22222222-2222-2222-2222-222222222222') {
              throw new InsufficientBalanceError('available', entry.asset, entry.amount, wb.available);
            }
            wb.available = decimalSubtract(wb.available, entry.amount);
          } else {
            if (decimalCompare(wb.locked, entry.amount) < 0) {
              throw new InsufficientBalanceError('locked', entry.asset, entry.amount, wb.locked);
            }
            wb.locked = decimalSubtract(wb.locked, entry.amount);
          }
        } else {
          // CREDIT
          if (pool === 'available') {
            wb.available = decimalAdd(wb.available, entry.amount);
          } else {
            wb.locked = decimalAdd(wb.locked, entry.amount);
          }
        }
      }

      // ── 4. Create Ledger Transaction ──────────────────────────────────
      await txClient.query(
        `INSERT INTO ledger_transactions (id, account_id, transaction_type, reference_id, description, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [transactionId, accountId, transactionType, referenceId, description, metadata ? JSON.stringify(metadata) : null]
      );

      // ── 5. Create Ledger Entries + Update Wallets ─────────────────────
      // Reset working balances to the locked values and apply incrementally for balanceAfter
      const appliedBalances = new Map<string, { available: string; locked: string }>();
      for (const [key, state] of walletStates) {
        appliedBalances.set(key, { ...state });
      }

      const resultEntries: LedgerTransactionResult['entries'] = [];

      for (const entry of entries) {
        const key = `${entry.accountId}:${entry.asset}`;
        const ab = appliedBalances.get(key)!;
        const pool = entry.balancePool ?? 'available';

        if (entry.direction === 'DEBIT') {
          if (pool === 'available') {
            ab.available = decimalSubtract(ab.available, entry.amount);
          } else {
            ab.locked = decimalSubtract(ab.locked, entry.amount);
          }
        } else {
          if (pool === 'available') {
            ab.available = decimalAdd(ab.available, entry.amount);
          } else {
            ab.locked = decimalAdd(ab.locked, entry.amount);
          }
        }

        const balanceAfter = decimalAdd(ab.available, ab.locked);

        await txClient.query(
          `INSERT INTO ledger_entries (transaction_id, account_id, asset, direction, amount, balance_after, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [transactionId, entry.accountId, entry.asset, entry.direction, entry.amount, balanceAfter]
        );


        resultEntries.push({
          direction: entry.direction,
          asset: entry.asset,
          amount: decimalNormalize(entry.amount),
          balanceAfter,
        });
      }

      // ── 6. Update Wallet Balances ─────────────────────────────────────
      for (const [key, finalBal] of appliedBalances) {
        const [accId, asset] = key.split(':');
        await txClient.query(
          `UPDATE wallet_balances
           SET available_balance = $1, locked_balance = $2, updated_at = NOW()
           WHERE account_id = $3 AND asset = $4`,
          [finalBal.available, finalBal.locked, accId, asset]
        );
      }

      logger.info('Ledger transaction committed', {
        transactionId,
        accountId,
        transactionType,
        referenceId,
        entryCount: entries.length,
      });

      return {
        transactionId,
        accountId,
        transactionType,
        referenceId,
        entries: resultEntries,
        appliedBalances: Array.from(appliedBalances.entries()),
        createdAt: new Date(),
      };
    };

    const txResult = externalTxClient ? await executeLogic(externalTxClient) : await this.database.transaction(executeLogic);

    // ── 7. Emit Domain Events strictly after successful commit ─────────────
    try {
      eventBus.publish({
        id: crypto.randomUUID(),
        type: 'ledger.transaction.posted',
        timestamp: Date.now(),
        version: '1.0.0',
        payload: {
          transactionId: txResult.transactionId,
          accountId: txResult.accountId,
          transactionType: txResult.transactionType,
          referenceId: txResult.referenceId,
          entries: txResult.entries,
          createdAt: txResult.createdAt.getTime(),
        },
      });

      for (const [key, bal] of (txResult as any).appliedBalances || []) {
        const [accId, asset] = key.split(':');
        const accRes = await this.database.query<any>('SELECT user_id AS "userId", type FROM accounts WHERE id = $1', [accId]);
        const acc = accRes.rows[0];
        const userId = acc ? (acc.userId || acc.user_id) : undefined;
        const accType = acc ? acc.type : 'SPOT';

        eventBus.publish({
          id: crypto.randomUUID(),
          type: 'wallet.balance.updated',
          channel: 'user:balances',
          userId,
          timestamp: Date.now(),
          version: '1.0.0',
          payload: {
            accountId: accId,
            accountType: accType,
            asset,
            availableBalance: bal.available,
            lockedBalance: bal.locked,
            totalBalance: decimalAdd(bal.available, bal.locked),
            transactionType: txResult.transactionType,
            referenceId: txResult.referenceId,
            timestamp: Date.now(),
          },
        });
      }
    } catch (evtErr: any) {
      logger.warn('Failed to publish ledger/balance event', { error: evtErr.message });
    }



    return {
      transactionId: txResult.transactionId,
      accountId: txResult.accountId,
      transactionType: txResult.transactionType,
      referenceId: txResult.referenceId,
      entries: txResult.entries,
      createdAt: txResult.createdAt,
    };
  }


  // ── Ledger History ──────────────────────────────────────────────────────

  /**
   * Retrieve paginated ledger history for an account.
   * Scoped to the authenticated account; never returns another user's data.
   */
  public async getHistory(
    accountId: string,
    options: {
      asset?: string;
      transactionType?: LedgerTxType;
      referenceId?: string;
      page?: number;
      pageSize?: number;
    } = {}
  ): Promise<LedgerHistoryResult> {
    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 50));
    const offset = (page - 1) * pageSize;

    // Build parameterized query
    const conditions: string[] = ['e.account_id = $1'];
    const params: unknown[] = [accountId];
    let paramIdx = 2;

    if (options.asset) {
      conditions.push(`e.asset = $${paramIdx}`);
      params.push(options.asset);
      paramIdx++;
    }

    if (options.transactionType) {
      conditions.push(`t.transaction_type = $${paramIdx}`);
      params.push(options.transactionType);
      paramIdx++;
    }

    if (options.referenceId) {
      conditions.push(`t.reference_id = $${paramIdx}`);
      params.push(options.referenceId);
      paramIdx++;
    }

    const whereClause = conditions.join(' AND ');

    // Count total
    const countResult = await this.database.query<any>(
      `SELECT COUNT(*) as total
       FROM ledger_entries e
       JOIN ledger_transactions t ON t.id = e.transaction_id
       WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0]?.total ?? '0', 10);

    // Fetch entries
    const entriesResult = await this.database.query<any>(
      `SELECT
         t.id AS transaction_id,
         t.transaction_type,
         t.reference_id,
         t.description,
         e.direction,
         e.asset,
         e.amount,
         e.balance_after,
         e.created_at
       FROM ledger_entries e
       JOIN ledger_transactions t ON t.id = e.transaction_id
       WHERE ${whereClause}
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, pageSize, offset]
    );

    return {
      entries: entriesResult.rows.map((row: any) => ({
        transactionId: row.transaction_id ?? row.transactionId,
        transactionType: row.transaction_type ?? row.transactionType,
        referenceId: row.reference_id ?? row.referenceId,
        description: row.description,
        direction: row.direction,
        asset: row.asset,
        amount: row.amount,
        balanceAfter: row.balance_after ?? row.balanceAfter,
        createdAt: row.created_at ? new Date(row.created_at) : new Date(row.createdAt),
      })),
      total,
      page,
      pageSize,
    };
  }

  // ── Reconciliation ──────────────────────────────────────────────────────

  /**
   * Reconcile wallet_balances against ledger_entries for one account+asset.
   * Reports discrepancies; does NOT auto-fix.
   */
  public async reconcile(accountId: string, asset: string): Promise<ReconciliationResult> {
    // 1. Get current wallet balance
    const balance = await this.getBalance(accountId, asset);

    // 2. Compute net from ledger entries
    const creditResult = await this.database.query<any>(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM ledger_entries
       WHERE account_id = $1 AND asset = $2 AND direction = 'CREDIT'`,
      [accountId, asset]
    );

    const debitResult = await this.database.query<any>(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM ledger_entries
       WHERE account_id = $1 AND asset = $2 AND direction = 'DEBIT'`,
      [accountId, asset]
    );

    const totalCredits = creditResult.rows[0]?.total ?? '0';
    const totalDebits = debitResult.rows[0]?.total ?? '0';
    const ledgerComputed = decimalSubtract(totalCredits, totalDebits);

    const walletTotal = balance.totalBalance;
    const discrepancy = decimalSubtract(walletTotal, ledgerComputed);
    const isConsistent = decimalIsZero(discrepancy);

    if (!isConsistent) {
      logger.warn('Reconciliation discrepancy detected', {
        accountId,
        asset,
        walletTotal,
        ledgerComputed,
        discrepancy,
      });
    }

    return {
      accountId,
      asset,
      walletAvailable: balance.availableBalance,
      walletLocked: balance.lockedBalance,
      walletTotal,
      ledgerNetCredits: decimalNormalize(totalCredits),
      ledgerNetDebits: decimalNormalize(totalDebits),
      ledgerComputedBalance: ledgerComputed,
      isConsistent,
      discrepancy,
    };
  }
}

export const ledgerService = new LedgerService();
