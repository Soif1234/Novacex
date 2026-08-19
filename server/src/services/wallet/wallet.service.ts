import crypto from 'crypto';
import { db, IDatabaseConnection } from '../../config/database';
import { AccountEntity, AccountType, AssetEntity } from '../../models/account.model';
import { LedgerTxType } from '../../models/ledger.model';
import { ledgerService, LedgerService, LedgerHistoryResult } from '../ledger/ledger.service';
import { validateAmount, decimalNormalize, countDecimalPlaces } from '../ledger/decimal';
import { logger } from '../../config/logger';
import {
  InvalidAssetError,
  AssetDisabledError,
  ExcessiveDecimalPrecisionError,
  AccountNotFoundError,
  AccountOwnershipDeniedError,
  SameAccountTransferError,
  CrossUserTransferDeniedError,
  WalletError,
  WalletErrorCode,
} from './errors';

export interface WalletBalanceItem {
  accountId: string;
  accountType: AccountType;
  asset: string;
  availableBalance: string;
  lockedBalance: string;
  totalBalance: string;
}

export interface PaperDepositDto {
  adminUserId: string;
  targetAccountId: string;
  targetUserId?: string;
  asset: string;
  amount: string;
  referenceId: string;
  description?: string;
}

export interface PaperDepositReceipt {
  mode: 'PAPER';
  status: 'COMPLETED';
  transactionId: string;
  accountId: string;
  accountType: AccountType;
  asset: string;
  amount: string;
  balanceAfter: string;
  referenceId: string;
  createdAt: Date;
}

export interface PaperWithdrawDto {
  userId: string;
  accountId: string;
  asset: string;
  amount: string;
  referenceId: string;
  destinationAddress?: string;
  description?: string;
}

export interface PaperWithdrawReceipt {
  mode: 'PAPER';
  status: 'COMPLETED';
  transactionId: string;
  accountId: string;
  accountType: AccountType;
  asset: string;
  amount: string;
  balanceAfter: string;
  referenceId: string;
  destinationAddress: string;
  createdAt: Date;
}

export interface TransferDto {
  userId: string;
  fromAccountId: string;
  toAccountId: string;
  asset: string;
  amount: string;
  referenceId: string;
  description?: string;
}

export interface TransferReceipt {
  status: 'COMPLETED';
  transactionId: string;
  fromAccountId: string;
  toAccountId: string;
  fromAccountType: AccountType;
  toAccountType: AccountType;
  asset: string;
  amount: string;
  referenceId: string;
  createdAt: Date;
}

export class WalletService {
  constructor(
    private database: IDatabaseConnection = db,
    private ledger: LedgerService = ledgerService
  ) {}

  /**
   * Validate that an asset exists in the registry, is active, and the amount does not exceed decimal precision.
   */
  public async validateAsset(symbol: string, amount?: string): Promise<AssetEntity> {
    if (!symbol || typeof symbol !== 'string') {
      throw new InvalidAssetError(String(symbol), 'Asset symbol is required');
    }

    const cleanSymbol = symbol.trim().toUpperCase();
    const assetRes = await this.database.query<any>(
      'SELECT symbol, name, decimals, is_active AS "isActive", is_fiat AS "isFiat", min_withdrawal_amount AS "minWithdrawalAmount", withdrawal_fee AS "withdrawalFee", created_at AS "createdAt" FROM assets WHERE symbol = $1',
      [cleanSymbol]
    );

    const assetRow = assetRes.rows[0];
    if (!assetRow) {
      throw new InvalidAssetError(cleanSymbol, `Asset "${cleanSymbol}" is not registered in the system`);
    }

    const asset: AssetEntity = {
      symbol: assetRow.symbol,
      name: assetRow.name,
      decimals: Number(assetRow.decimals),
      isActive: Boolean(assetRow.isActive ?? assetRow.is_active),
      isFiat: Boolean(assetRow.isFiat ?? assetRow.is_fiat),
      minWithdrawalAmount: assetRow.minWithdrawalAmount ?? assetRow.min_withdrawal_amount ?? '0',
      withdrawalFee: assetRow.withdrawalFee ?? assetRow.withdrawal_fee ?? '0',
      createdAt: assetRow.createdAt ? new Date(assetRow.createdAt) : new Date(),
    };

    if (!asset.isActive) {
      throw new AssetDisabledError(cleanSymbol);
    }

    if (amount !== undefined) {
      validateAmount(amount);
      const decimals = countDecimalPlaces(amount);
      if (decimals > asset.decimals) {
        throw new ExcessiveDecimalPrecisionError(cleanSymbol, amount, asset.decimals);
      }
    }

    return asset;
  }

  /**
   * Get all wallet balances for an authenticated user across owned accounts.
   */
  public async getBalances(
    userId: string,
    accountId?: string,
    accountType?: AccountType
  ): Promise<WalletBalanceItem[]> {
    // 1. Fetch user's accounts
    const accountsRes = await this.database.query<any>(
      'SELECT id, user_id AS "userId", type, created_at AS "createdAt", updated_at AS "updatedAt" FROM accounts WHERE user_id = $1',
      [userId]
    );

    let userAccounts: AccountEntity[] = accountsRes.rows.map(r => ({
      id: r.id,
      userId: r.userId || r.user_id,
      type: r.type,
      createdAt: r.createdAt ? new Date(r.createdAt) : new Date(),
      updatedAt: r.updatedAt ? new Date(r.updatedAt) : new Date(),
    }));

    if (userAccounts.length === 0) {
      userAccounts = await this.initializeAccounts(userId);
    }

    // 2. Filter if specific accountId is requested
    if (accountId) {
      const target = userAccounts.find(a => a.id === accountId);
      if (!target) {
        throw new AccountOwnershipDeniedError(accountId);
      }
      userAccounts = [target];
    }

    // 3. Filter if specific accountType is requested
    if (accountType) {
      userAccounts = userAccounts.filter(a => a.type === accountType);
    }

    // 4. Fetch balances from authoritative LedgerService
    const results: WalletBalanceItem[] = [];
    for (const acc of userAccounts) {
      const balances = await this.ledger.getAllBalances(acc.id);
      for (const b of balances) {
        results.push({
          accountId: acc.id,
          accountType: acc.type,
          asset: b.asset,
          availableBalance: b.availableBalance,
          lockedBalance: b.lockedBalance,
          totalBalance: b.totalBalance,
        });
      }
    }

    // 5. Deterministic sorting: accountType ASC, then asset ASC
    const typeOrder: Record<AccountType, number> = {
      SPOT: 1,
      FUTURES: 2,
      FUNDING: 3,
      SYSTEM_VAULT: 4,
    };

    results.sort((a, b) => {
      const ordA = typeOrder[a.accountType] || 99;
      const ordB = typeOrder[b.accountType] || 99;
      if (ordA !== ordB) return ordA - ordB;
      return a.asset.localeCompare(b.asset);
    });

    return results;
  }

  /**
   * Get single asset balance for a specific account.
   */
  public async getBalance(userId: string, accountId: string, asset: string): Promise<WalletBalanceItem> {
    await this.validateAsset(asset);

    const accRes = await this.database.query<any>(
      'SELECT id, user_id AS "userId", type FROM accounts WHERE id = $1',
      [accountId]
    );

    const acc = accRes.rows[0];
    if (!acc) {
      throw new AccountNotFoundError(accountId);
    }

    if ((acc.userId || acc.user_id) !== userId) {
      throw new AccountOwnershipDeniedError(accountId);
    }

    const bal = await this.ledger.getBalance(accountId, asset.toUpperCase());

    return {
      accountId,
      accountType: acc.type,
      asset: asset.toUpperCase(),
      availableBalance: bal.availableBalance,
      lockedBalance: bal.lockedBalance,
      totalBalance: bal.totalBalance,
    };
  }

  /**
   * Admin-only paper deposit. Credits the target account via LedgerService.
   */
  public async paperDeposit(dto: PaperDepositDto): Promise<PaperDepositReceipt> {
    if (!dto.referenceId || typeof dto.referenceId !== 'string' || !dto.referenceId.trim()) {
      throw new WalletError('referenceId is required for idempotency', 400, WalletErrorCode.MISSING_PARAMETER);
    }

    // 1. Validate asset & amount precision
    await this.validateAsset(dto.asset, dto.amount);

    // 2. Validate target account exists
    const accRes = await this.database.query<any>(
      'SELECT id, user_id AS "userId", type FROM accounts WHERE id = $1',
      [dto.targetAccountId]
    );

    const acc = accRes.rows[0];
    if (!acc) {
      throw new AccountNotFoundError(dto.targetAccountId);
    }

    if (dto.targetUserId && (acc.userId || acc.user_id) !== dto.targetUserId) {
      throw new WalletError(
        `Target account "${dto.targetAccountId}" does not belong to specified target user "${dto.targetUserId}"`,
        400,
        WalletErrorCode.ACCOUNT_OWNERSHIP_DENIED
      );
    }

    const cleanAsset = dto.asset.trim().toUpperCase();
    const cleanRef = dto.referenceId.trim();

    // 3. Delegate mutation to LedgerService
    const result = await this.ledger.credit(
      dto.targetAccountId,
      cleanAsset,
      dto.amount,
      'DEPOSIT',
      cleanRef,
      dto.description || 'Admin Paper Deposit',
      {
        mode: 'PAPER',
        adminUserId: dto.adminUserId,
        targetUserId: acc.userId || acc.user_id,
        targetAccountType: acc.type,
      }
    );

    logger.info('Admin paper deposit completed', {
      adminUserId: dto.adminUserId,
      targetAccountId: dto.targetAccountId,
      asset: cleanAsset,
      amount: dto.amount,
      referenceId: cleanRef,
      transactionId: result.transactionId,
    });

    return {
      mode: 'PAPER',
      status: 'COMPLETED',
      transactionId: result.transactionId,
      accountId: dto.targetAccountId,
      accountType: acc.type,
      asset: cleanAsset,
      amount: decimalNormalize(dto.amount),
      balanceAfter: result.entries[0]?.balanceAfter || '0',
      referenceId: cleanRef,
      createdAt: result.createdAt,
    };
  }

  /**
   * Paper withdrawal from authenticated user's account.
   * Debits available balance via LedgerService.
   */
  public async paperWithdraw(dto: PaperWithdrawDto): Promise<PaperWithdrawReceipt> {
    if (!dto.referenceId || typeof dto.referenceId !== 'string' || !dto.referenceId.trim()) {
      throw new WalletError('referenceId is required for idempotency', 400, WalletErrorCode.MISSING_PARAMETER);
    }

    // 1. Validate asset & amount precision
    await this.validateAsset(dto.asset, dto.amount);

    // 2. Validate account ownership
    const accRes = await this.database.query<any>(
      'SELECT id, user_id AS "userId", type FROM accounts WHERE id = $1',
      [dto.accountId]
    );

    const acc = accRes.rows[0];
    if (!acc) {
      throw new AccountNotFoundError(dto.accountId);
    }

    if ((acc.userId || acc.user_id) !== dto.userId) {
      throw new AccountOwnershipDeniedError(dto.accountId);
    }

    const cleanAsset = dto.asset.trim().toUpperCase();
    const cleanRef = dto.referenceId.trim();
    const destAddress = dto.destinationAddress?.trim() || 'PAPER_WITHDRAWAL_ADDRESS';

    // 3. Delegate mutation to LedgerService
    const result = await this.ledger.debit(
      dto.accountId,
      cleanAsset,
      dto.amount,
      'WITHDRAWAL',
      cleanRef,
      dto.description || 'Paper Withdrawal',
      {
        mode: 'PAPER',
        userId: dto.userId,
        destinationAddress: destAddress,
        accountType: acc.type,
      }
    );

    logger.info('Paper withdrawal completed', {
      userId: dto.userId,
      accountId: dto.accountId,
      asset: cleanAsset,
      amount: dto.amount,
      referenceId: cleanRef,
      transactionId: result.transactionId,
    });

    return {
      mode: 'PAPER',
      status: 'COMPLETED',
      transactionId: result.transactionId,
      accountId: dto.accountId,
      accountType: acc.type,
      asset: cleanAsset,
      amount: decimalNormalize(dto.amount),
      balanceAfter: result.entries[0]?.balanceAfter || '0',
      referenceId: cleanRef,
      destinationAddress: destAddress,
      createdAt: result.createdAt,
    };
  }

  /**
   * Internal transfer between accounts owned by the same user.
   * Atomically debits source and credits destination via LedgerService.
   */
  public async transfer(dto: TransferDto): Promise<TransferReceipt> {
    if (!dto.referenceId || typeof dto.referenceId !== 'string' || !dto.referenceId.trim()) {
      throw new WalletError('referenceId is required for idempotency', 400, WalletErrorCode.MISSING_PARAMETER);
    }

    if (dto.fromAccountId === dto.toAccountId) {
      throw new SameAccountTransferError(dto.fromAccountId);
    }

    // 1. Validate asset & amount precision
    await this.validateAsset(dto.asset, dto.amount);

    // 2. Validate BOTH accounts exist and belong to the authenticated user
    const [fromRes, toRes] = await Promise.all([
      this.database.query<any>('SELECT id, user_id AS "userId", type FROM accounts WHERE id = $1', [dto.fromAccountId]),
      this.database.query<any>('SELECT id, user_id AS "userId", type FROM accounts WHERE id = $1', [dto.toAccountId]),
    ]);

    const fromAcc = fromRes.rows[0];
    const toAcc = toRes.rows[0];

    if (!fromAcc) {
      throw new AccountNotFoundError(dto.fromAccountId);
    }
    if (!toAcc) {
      throw new AccountNotFoundError(dto.toAccountId);
    }

    const fromOwner = fromAcc.userId || fromAcc.user_id;
    const toOwner = toAcc.userId || toAcc.user_id;

    if (fromOwner !== dto.userId) {
      throw new AccountOwnershipDeniedError(dto.fromAccountId);
    }
    if (toOwner !== dto.userId) {
      throw new CrossUserTransferDeniedError();
    }

    const cleanAsset = dto.asset.trim().toUpperCase();
    const cleanRef = dto.referenceId.trim();

    // 3. Delegate atomic transfer to LedgerService
    const result = await this.ledger.transfer(
      dto.fromAccountId,
      dto.toAccountId,
      cleanAsset,
      dto.amount,
      cleanRef,
      dto.description || `Internal Transfer ${fromAcc.type} -> ${toAcc.type}`,
      {
        mode: 'INTERNAL_TRANSFER',
        userId: dto.userId,
        fromType: fromAcc.type,
        toType: toAcc.type,
      }
    );

    logger.info('Internal transfer completed', {
      userId: dto.userId,
      fromAccountId: dto.fromAccountId,
      toAccountId: dto.toAccountId,
      asset: cleanAsset,
      amount: dto.amount,
      referenceId: cleanRef,
      transactionId: result.transactionId,
    });

    return {
      status: 'COMPLETED',
      transactionId: result.transactionId,
      fromAccountId: dto.fromAccountId,
      toAccountId: dto.toAccountId,
      fromAccountType: fromAcc.type,
      toAccountType: toAcc.type,
      asset: cleanAsset,
      amount: decimalNormalize(dto.amount),
      referenceId: cleanRef,
      createdAt: result.createdAt,
    };
  }

  /**
   * Retrieve paginated transaction history scoped strictly to the authenticated user.
   */
  public async getTransactions(
    userId: string,
    options: {
      accountId?: string;
      asset?: string;
      transactionType?: LedgerTxType;
      page?: number;
      pageSize?: number;
    } = {}
  ): Promise<LedgerHistoryResult> {
    // 1. Fetch user accounts
    const accountsRes = await this.database.query<any>(
      'SELECT id, user_id AS "userId", type FROM accounts WHERE user_id = $1',
      [userId]
    );

    const userAccountIds = accountsRes.rows.map(r => r.id);

    if (options.accountId) {
      if (!userAccountIds.includes(options.accountId)) {
        throw new AccountOwnershipDeniedError(options.accountId);
      }
      return this.ledger.getHistory(options.accountId, options);
    }

    // Default to the first account (e.g. SPOT) if no accountId is specified
    const primaryAccountId = userAccountIds[0];
    if (!primaryAccountId) {
      return { entries: [], total: 0, page: 1, pageSize: options.pageSize || 50 };
    }

    return this.ledger.getHistory(primaryAccountId, options);
  }

  /**
   * Initialize default SPOT, FUTURES, FUNDING accounts for a user with zero initial balances.
   */
  public async initializeAccounts(userId: string): Promise<AccountEntity[]> {
    const existing = await this.database.query<any>(
      'SELECT id, user_id AS "userId", type, created_at AS "createdAt", updated_at AS "updatedAt" FROM accounts WHERE user_id = $1',
      [userId]
    );

    const accounts: AccountEntity[] = existing.rows.map(r => ({
      id: r.id,
      userId: r.userId || r.user_id,
      type: r.type,
      createdAt: r.createdAt ? new Date(r.createdAt) : new Date(),
      updatedAt: r.updatedAt ? new Date(r.updatedAt) : new Date(),
    }));

    const existingTypes = new Set(accounts.map(a => a.type));
    const requiredTypes: AccountType[] = ['SPOT', 'FUTURES', 'FUNDING'];

    for (const reqType of requiredTypes) {
      if (!existingTypes.has(reqType)) {
        const id = crypto.randomUUID();
        await this.database.query(
          'INSERT INTO accounts (id, user_id, type) VALUES ($1, $2, $3)',
          [id, userId, reqType]
        );
        accounts.push({
          id,
          userId,
          type: reqType,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    }

    return accounts;
  }
}

export const walletService = new WalletService();
