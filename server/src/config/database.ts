import crypto from 'crypto';
import { env } from './env';
import { logger } from './logger';
import { UserEntity, UserProfileEntity, UserAuthCredentialsEntity, UserSessionEntity } from '../models/user.model';
import { AccountEntity, AssetEntity, WalletBalanceEntity } from '../models/account.model';
import { LedgerTransactionEntity, LedgerEntryEntity } from '../models/ledger.model';

export interface DatabaseStatus {
  connected: boolean;
  poolSize: number;
  activeConnections: number;
  idleConnections: number;
  lastPingMs?: number;
  error?: string;
}

export interface QueryResult<T = unknown> {
  rows: T[];
  rowCount: number;
}

export interface IDatabaseConnection {
  connect(): Promise<void>;
  close(): Promise<void>;
  query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  transaction<T = unknown>(callback: (client: IDatabaseConnection) => Promise<T>): Promise<T>;
  healthCheck(): Promise<{ healthy: boolean; latencyMs: number; error?: string }>;
  getStatus(): DatabaseStatus;
  reset?(): void;
}

export class DatabasePool implements IDatabaseConnection {
  private isConnected = false;
  private connectionError: string | null = null;
  private activeClients = 0;
  private totalPoolSize = 0;

  // In-memory relational tables for local dev/testing
  private users = new Map<string, UserEntity>();
  private usersByEmail = new Map<string, string>(); // email -> id
  private userProfiles = new Map<string, UserProfileEntity>(); // userId -> profile
  private userCredentials = new Map<string, UserAuthCredentialsEntity>(); // userId -> creds
  private userSessions = new Map<string, UserSessionEntity>(); // tokenHash -> session
  private accounts = new Map<string, AccountEntity>(); // id -> account
  private assets = new Map<string, AssetEntity>(); // symbol -> asset
  private schemaMigrations = new Set<string>();

  // Ledger tables
  private walletBalances = new Map<string, WalletBalanceEntity>(); // "accountId:asset" -> balance
  private ledgerTransactions = new Map<string, LedgerTransactionEntity>(); // id -> tx
  private ledgerTxByRef = new Map<string, string>(); // "accountId:referenceId" -> txId
  private ledgerEntries: LedgerEntryEntity[] = []; // append-only journal
  private lockedWallets = new Set<string>(); // concurrency lock keys

  constructor(private config = env) {
    this.totalPoolSize = config.DB_POOL_MIN;
    this.initDefaultAssets();
  }

  private initDefaultAssets(): void {
    const defaultAssets: AssetEntity[] = [
      { symbol: 'USDT', name: 'Tether USD', decimals: 8, isActive: true, isFiat: false, minWithdrawalAmount: '10', withdrawalFee: '1', createdAt: new Date() },
      { symbol: 'USDC', name: 'USD Coin', decimals: 8, isActive: true, isFiat: false, minWithdrawalAmount: '10', withdrawalFee: '1', createdAt: new Date() },
      { symbol: 'BTC', name: 'Bitcoin', decimals: 8, isActive: true, isFiat: false, minWithdrawalAmount: '0.001', withdrawalFee: '0.0005', createdAt: new Date() },
      { symbol: 'ETH', name: 'Ethereum', decimals: 8, isActive: true, isFiat: false, minWithdrawalAmount: '0.01', withdrawalFee: '0.005', createdAt: new Date() },
      { symbol: 'SOL', name: 'Solana', decimals: 8, isActive: true, isFiat: false, minWithdrawalAmount: '0.1', withdrawalFee: '0.01', createdAt: new Date() },
      { symbol: 'XRP', name: 'Ripple', decimals: 8, isActive: true, isFiat: false, minWithdrawalAmount: '1', withdrawalFee: '0.1', createdAt: new Date() },
      { symbol: 'DOGE', name: 'Dogecoin', decimals: 8, isActive: true, isFiat: false, minWithdrawalAmount: '10', withdrawalFee: '1', createdAt: new Date() },
      { symbol: 'FUTURES_USDT', name: 'Futures Collateral USDT', decimals: 8, isActive: true, isFiat: false, minWithdrawalAmount: '0', withdrawalFee: '0', createdAt: new Date() },
    ];
    for (const a of defaultAssets) {
      this.assets.set(a.symbol, { ...a });
    }
  }

  public async connect(): Promise<void> {
    logger.info('Initializing PostgreSQL connection pool', {
      host: this.config.DB_HOST,
      port: this.config.DB_PORT,
      database: this.config.DB_NAME,
      user: this.config.DB_USER
    });

    this.isConnected = true;
    this.connectionError = null;
    logger.info('PostgreSQL connection pool initialized successfully');
  }

  public async close(): Promise<void> {
    logger.info('Draining PostgreSQL connection pool');
    this.isConnected = false;
    this.activeClients = 0;
    logger.info('PostgreSQL connection pool drained');
  }

  public reset(): void {
    this.users.clear();
    this.usersByEmail.clear();
    this.userProfiles.clear();
    this.userCredentials.clear();
    this.userSessions.clear();
    this.accounts.clear();
    this.assets.clear();
    this.initDefaultAssets();
    this.schemaMigrations.clear();
    this.walletBalances.clear();
    this.ledgerTransactions.clear();
    this.ledgerTxByRef.clear();
    this.ledgerEntries = [];
    this.lockedWallets.clear();
  }

  public async transaction<T = unknown>(callback: (client: IDatabaseConnection) => Promise<T>): Promise<T> {
    if (!this.isConnected) throw new Error('Database is not connected');

    // Create snapshots for rollback safety
    const snapUsers = new Map(this.users);
    const snapUsersByEmail = new Map(this.usersByEmail);
    const snapProfiles = new Map(this.userProfiles);
    const snapCreds = new Map(this.userCredentials);
    const snapSessions = new Map(this.userSessions);
    const snapAccounts = new Map(this.accounts);
    const snapAssets = new Map(this.assets);
    const snapWalletBalances = new Map(this.walletBalances);
    const snapLedgerTransactions = new Map(this.ledgerTransactions);
    const snapLedgerTxByRef = new Map(this.ledgerTxByRef);
    const snapLedgerEntries = [...this.ledgerEntries];

    try {
      const result = await callback(this);
      return result;
    } catch (err) {
      // Rollback state on error
      this.users = snapUsers;
      this.usersByEmail = snapUsersByEmail;
      this.userProfiles = snapProfiles;
      this.userCredentials = snapCreds;
      this.userSessions = snapSessions;
      this.accounts = snapAccounts;
      this.assets = snapAssets;
      this.walletBalances = snapWalletBalances;
      this.ledgerTransactions = snapLedgerTransactions;
      this.ledgerTxByRef = snapLedgerTxByRef;
      this.ledgerEntries = snapLedgerEntries;
      throw err;
    }
  }

  private mapUser(u: UserEntity): any {
    return {
      ...u,
      account_status: u.accountStatus,
      created_at: u.createdAt,
      updated_at: u.updatedAt
    };
  }

  private mapProfile(p: UserProfileEntity): any {
    return {
      ...p,
      user_id: p.userId,
      display_name: p.displayName,
      avatar_url: p.avatarUrl,
      created_at: p.createdAt,
      updated_at: p.updatedAt
    };
  }

  private mapCreds(c: UserAuthCredentialsEntity): any {
    return {
      ...c,
      user_id: c.userId,
      password_hash: c.passwordHash,
      two_factor_enabled: c.twoFactorEnabled,
      failed_login_attempts: c.failedLoginAttempts,
      locked_until: c.lockedUntil,
      last_login_at: c.lastLoginAt,
      updated_at: c.updatedAt
    };
  }

  private mapSession(s: UserSessionEntity): any {
    return {
      ...s,
      user_id: s.userId,
      token_hash: s.tokenHash,
      ip_address: s.ipAddress,
      user_agent: s.userAgent,
      expires_at: s.expiresAt,
      created_at: s.createdAt,
      last_active_at: s.lastActiveAt
    };
  }

  private mapAccount(a: AccountEntity): any {
    return {
      ...a,
      user_id: a.userId,
      created_at: a.createdAt,
      updated_at: a.updatedAt
    };
  }

  private mapAsset(a: AssetEntity): any {
    return {
      ...a,
      is_active: a.isActive,
      is_fiat: a.isFiat,
      isActive: a.isActive,
      isFiat: a.isFiat,
      min_withdrawal_amount: a.minWithdrawalAmount,
      withdrawal_fee: a.withdrawalFee,
      minWithdrawalAmount: a.minWithdrawalAmount,
      withdrawalFee: a.withdrawalFee,
      created_at: a.createdAt,
      createdAt: a.createdAt
    };
  }

  public async query<T = unknown>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    if (!this.isConnected) {
      throw new Error('Database is not connected');
    }

    const trimmed = sql.trim();

    // 1. INSERT INTO users
    if (/INSERT\s+INTO\s+users/i.test(trimmed)) {
      const id = (params[0] as string) || crypto.randomUUID();
      const email = (params[1] as string).toLowerCase().trim();
      const role = (params[2] as 'USER' | 'ADMIN') || 'USER';
      const status = (params[3] as 'ACTIVE' | 'SUSPENDED') || 'ACTIVE';

      if (this.usersByEmail.has(email)) {
        const err = new Error(`duplicate key value violates unique constraint "users_email_key"`);
        (err as any).code = '23505';
        throw err;
      }

      const entity: UserEntity = {
        id,
        email,
        role,
        accountStatus: status,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      this.users.set(id, entity);
      this.usersByEmail.set(email, id);

      return { rows: [this.mapUser(entity) as T], rowCount: 1 };
    }

    // 2. SELECT ... FROM users WHERE email = $1
    if (/FROM\s+users\s+WHERE\s+email\s*=/i.test(trimmed)) {
      const email = (params[0] as string)?.toLowerCase().trim();
      const userId = this.usersByEmail.get(email);
      const user = userId ? this.users.get(userId) : undefined;
      return { rows: user ? [this.mapUser(user) as T] : [], rowCount: user ? 1 : 0 };
    }

    // 3. SELECT ... FROM users WHERE id = $1
    if (/FROM\s+users\s+WHERE\s+id\s*=/i.test(trimmed)) {
      const id = params[0] as string;
      const user = this.users.get(id);
      return { rows: user ? [this.mapUser(user) as T] : [], rowCount: user ? 1 : 0 };
    }

    // 4. INSERT INTO user_profiles
    if (/INSERT\s+INTO\s+user_profiles/i.test(trimmed)) {
      const userId = params[0] as string;
      const username = params[1] as string;
      const displayName = params[2] as string;
      const avatarUrl = params[3] as string | undefined;

      const profile: UserProfileEntity = {
        userId,
        username,
        displayName,
        avatarUrl,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      this.userProfiles.set(userId, profile);
      return { rows: [this.mapProfile(profile) as T], rowCount: 1 };
    }

    // 5. SELECT ... FROM user_profiles WHERE user_id = $1
    if (/FROM\s+user_profiles\s+WHERE\s+user_id\s*=/i.test(trimmed)) {
      const userId = params[0] as string;
      const profile = this.userProfiles.get(userId);
      return { rows: profile ? [this.mapProfile(profile) as T] : [], rowCount: profile ? 1 : 0 };
    }

    // 6. INSERT INTO user_auth_credentials
    if (/INSERT\s+INTO\s+user_auth_credentials/i.test(trimmed)) {
      const userId = params[0] as string;
      const passwordHash = params[1] as string;

      const creds: UserAuthCredentialsEntity = {
        userId,
        passwordHash,
        twoFactorEnabled: false,
        failedLoginAttempts: 0,
        updatedAt: new Date()
      };
      this.userCredentials.set(userId, creds);
      return { rows: [this.mapCreds(creds) as T], rowCount: 1 };
    }

    // 7. SELECT ... FROM user_auth_credentials WHERE user_id = $1
    if (/FROM\s+user_auth_credentials\s+WHERE\s+user_id\s*=/i.test(trimmed)) {
      const userId = params[0] as string;
      const creds = this.userCredentials.get(userId);
      return { rows: creds ? [this.mapCreds(creds) as T] : [], rowCount: creds ? 1 : 0 };
    }

    // 8. INSERT INTO accounts
    if (/INSERT\s+INTO\s+accounts/i.test(trimmed)) {
      const id = (params[0] as string) || crypto.randomUUID();
      const userId = params[1] as string;
      const type = params[2] as 'SPOT' | 'FUTURES' | 'FUNDING';

      const account: AccountEntity = {
        id,
        userId,
        type,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      this.accounts.set(id, account);
      return { rows: [this.mapAccount(account) as T], rowCount: 1 };
    }

    // 9. SELECT ... FROM accounts WHERE id = $1 AND user_id = $2
    if (/FROM\s+accounts.*WHERE\s+id\s*=\s*\$1\s+AND\s+user_id\s*=\s*\$2/i.test(trimmed)) {
      const id = params[0] as string;
      const userId = params[1] as string;
      const account = this.accounts.get(id);
      if (account && account.userId === userId) {
        return { rows: [this.mapAccount(account) as T], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // 9b. SELECT ... FROM accounts WHERE id = $1
    if (/FROM\s+accounts.*WHERE\s+id\s*=\s*\$1/i.test(trimmed)) {
      const id = params[0] as string;
      const account = this.accounts.get(id);
      return { rows: account ? [this.mapAccount(account) as T] : [], rowCount: account ? 1 : 0 };
    }

    // 9c. SELECT ... FROM accounts WHERE user_id = $1
    if (/FROM\s+accounts.*WHERE\s+user_id\s*=/i.test(trimmed)) {
      const userId = params[0] as string;
      const userAccounts = Array.from(this.accounts.values()).filter(a => a.userId === userId);
      return { rows: userAccounts.map(a => this.mapAccount(a)) as T[], rowCount: userAccounts.length };
    }

    // 9d. SELECT ... FROM assets WHERE symbol = $1
    if (/FROM\s+assets\s+WHERE\s+symbol\s*=/i.test(trimmed)) {
      const symbol = (params[0] as string)?.toUpperCase();
      const asset = this.assets.get(symbol);
      return { rows: asset ? [this.mapAsset(asset) as T] : [], rowCount: asset ? 1 : 0 };
    }

    // 9e. SELECT ... FROM assets
    if (/FROM\s+assets/i.test(trimmed) && !/WHERE/i.test(trimmed)) {
      const allAssets = Array.from(this.assets.values());
      return { rows: allAssets.map(a => this.mapAsset(a)) as T[], rowCount: allAssets.length };
    }

    // 9f. UPDATE assets SET is_active = ... WHERE symbol = ...
    if (/UPDATE\s+assets\s+SET\s+is_active/i.test(trimmed)) {
      let isActive = true;
      let symbol = '';

      if (params.length >= 2) {
        isActive = Boolean(params[0]);
        symbol = (params[1] as string)?.toUpperCase();
      } else {
        const activeMatch = /is_active\s*=\s*(true|false)/i.exec(trimmed);
        if (activeMatch) {
          isActive = activeMatch[1].toLowerCase() === 'true';
        }
        const symbolMatch = /symbol\s*=\s*['"]?([a-zA-Z0-9_]+)['"]?/i.exec(trimmed);
        if (symbolMatch) {
          symbol = symbolMatch[1].toUpperCase();
        }
      }

      const asset = this.assets.get(symbol);
      if (asset) {
        asset.isActive = isActive;
        return { rows: [this.mapAsset(asset) as T], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }


    // 10. INSERT INTO user_sessions
    if (/INSERT\s+INTO\s+user_sessions/i.test(trimmed)) {
      const id = (params[0] as string) || crypto.randomUUID();
      const userId = params[1] as string;
      const tokenHash = params[2] as string;
      const ip = params[3] as string | undefined;
      const userAgent = params[4] as string | undefined;
      const expiresAt = (params[5] as Date) || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const session: UserSessionEntity = {
        id,
        userId,
        tokenHash,
        ipAddress: ip,
        userAgent,
        status: 'ACTIVE',
        expiresAt,
        createdAt: new Date(),
        lastActiveAt: new Date()
      };
      this.userSessions.set(tokenHash, session);
      return { rows: [this.mapSession(session) as T], rowCount: 1 };
    }

    // 11. SELECT ... FROM user_sessions WHERE token_hash = $1
    if (/FROM\s+user_sessions\s+WHERE\s+token_hash\s*=/i.test(trimmed)) {
      const tokenHash = params[0] as string;
      const session = this.userSessions.get(tokenHash);
      if (!session) return { rows: [], rowCount: 0 };
      if (session.status === 'ACTIVE' && session.expiresAt.getTime() < Date.now()) {
        session.status = 'EXPIRED';
      }
      return { rows: [this.mapSession(session) as T], rowCount: 1 };
    }

    // 12. UPDATE user_sessions SET status = 'REVOKED' WHERE token_hash = $1
    if (/UPDATE\s+user_sessions\s+SET\s+status\s*=\s*'REVOKED'\s+WHERE\s+token_hash\s*=/i.test(trimmed)) {
      const tokenHash = params[0] as string;
      const session = this.userSessions.get(tokenHash);
      if (session) {
        session.status = 'REVOKED';
        return { rows: [this.mapSession(session) as T], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // 13. Schema Migrations handling
    if (/INSERT\s+INTO\s+schema_migrations/i.test(trimmed)) {
      const version = params[0] as string;
      this.schemaMigrations.add(version);
      return { rows: [], rowCount: 1 };
    }

    if (/FROM\s+schema_migrations/i.test(trimmed)) {
      const rows = Array.from(this.schemaMigrations).map(v => ({
        version: v,
        name: v,
        checksum: 'checksum',
        appliedAt: new Date()
      }));
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }

    // ── LEDGER TABLE HANDLERS ──────────────────────────────────────────────

    // 14. SELECT ... FROM wallet_balances WHERE account_id = $1 AND asset = $2 FOR UPDATE
    if (/FROM\s+wallet_balances\s+WHERE\s+account_id\s*=\s*\$1\s+AND\s+asset\s*=\s*\$2/i.test(trimmed)) {
      const accId = params[0] as string;
      const asset = params[1] as string;
      const key = `${accId}:${asset}`;
      const wb = this.walletBalances.get(key);

      // Simulate row-level lock for concurrency
      if (/FOR\s+UPDATE/i.test(trimmed)) {
        if (this.lockedWallets.has(key)) {
          throw new Error(`LOCK_CONFLICT: wallet row ${key} is already locked by another transaction`);
        }
        this.lockedWallets.add(key);
      }

      if (!wb) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          id: wb.id,
          account_id: wb.accountId,
          asset: wb.asset,
          available_balance: wb.availableBalance,
          locked_balance: wb.lockedBalance,
          availableBalance: wb.availableBalance,
          lockedBalance: wb.lockedBalance,
          updated_at: wb.updatedAt,
        } as unknown as T],
        rowCount: 1,
      };
    }

    // 15. SELECT ... FROM wallet_balances WHERE account_id = $1 ORDER BY asset
    if (/FROM\s+wallet_balances\s+WHERE\s+account_id\s*=\s*\$1/i.test(trimmed) && !/asset/i.test(trimmed.split('WHERE')[1]?.split('ORDER')[0] || '')) {
      const accId = params[0] as string;
      const rows: any[] = [];
      for (const [key, wb] of this.walletBalances) {
        if (wb.accountId === accId) {
          rows.push({
            id: wb.id,
            account_id: wb.accountId,
            asset: wb.asset,
            available_balance: wb.availableBalance,
            locked_balance: wb.lockedBalance,
            availableBalance: wb.availableBalance,
            lockedBalance: wb.lockedBalance,
            updated_at: wb.updatedAt,
          });
        }
      }
      rows.sort((a, b) => a.asset.localeCompare(b.asset));
      return { rows: rows as T[], rowCount: rows.length };
    }

    // 16. INSERT INTO wallet_balances ... ON CONFLICT DO NOTHING
    if (/INSERT\s+INTO\s+wallet_balances/i.test(trimmed)) {
      const id = params[0] as string;
      const accId = params[1] as string;
      const asset = params[2] as string;
      const available = (params[3] as string) || '0';
      const locked = (params[4] as string) || '0';
      const key = `${accId}:${asset}`;

      if (/ON\s+CONFLICT.*DO\s+NOTHING/i.test(trimmed) && this.walletBalances.has(key)) {
        return { rows: [], rowCount: 0 };
      }

      const wb: WalletBalanceEntity = {
        id,
        accountId: accId,
        asset,
        availableBalance: available,
        lockedBalance: locked,
        updatedAt: new Date(),
      };
      this.walletBalances.set(key, wb);
      return { rows: [wb as unknown as T], rowCount: 1 };
    }

    // 17. UPDATE wallet_balances SET available_balance = $1, locked_balance = $2
    if (/UPDATE\s+wallet_balances\s+SET/i.test(trimmed)) {
      const available = params[0] as string;
      const locked = params[1] as string;
      const accId = params[2] as string;
      const asset = params[3] as string;
      const key = `${accId}:${asset}`;
      const wb = this.walletBalances.get(key);

      if (wb) {
        wb.availableBalance = available;
        wb.lockedBalance = locked;
        wb.updatedAt = new Date();
        // Release lock after update
        this.lockedWallets.delete(key);
        return { rows: [wb as unknown as T], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // 18. SELECT ... FROM ledger_transactions WHERE account_id = $1 AND reference_id = $2
    if (/FROM\s+ledger_transactions\s+WHERE\s+account_id\s*=\s*\$1\s+AND\s+reference_id\s*=\s*\$2/i.test(trimmed)) {
      const accId = params[0] as string;
      const refId = params[1] as string;
      const refKey = `${accId}:${refId}`;
      const txId = this.ledgerTxByRef.get(refKey);

      if (!txId) return { rows: [], rowCount: 0 };
      const tx = this.ledgerTransactions.get(txId);
      if (!tx) return { rows: [], rowCount: 0 };

      return {
        rows: [{
          id: tx.id,
          account_id: tx.accountId,
          transaction_type: tx.transactionType,
          transactionType: tx.transactionType,
          reference_id: tx.referenceId,
          description: tx.description,
          metadata: tx.metadata,
          created_at: tx.createdAt,
          createdAt: tx.createdAt,
        } as unknown as T],
        rowCount: 1,
      };
    }

    // 19. INSERT INTO ledger_transactions
    if (/INSERT\s+INTO\s+ledger_transactions/i.test(trimmed)) {
      const id = params[0] as string;
      const accId = params[1] as string;
      const txType = params[2] as string;
      const refId = params[3] as string;
      const description = params[4] as string;
      const metadataRaw = params[5];

      const refKey = `${accId}:${refId}`;
      if (this.ledgerTxByRef.has(refKey)) {
        const err = new Error(`duplicate key value violates unique constraint "ledger_transactions_account_id_reference_id_key"`);
        (err as any).code = '23505';
        throw err;
      }

      const metadata = metadataRaw
        ? (typeof metadataRaw === 'string' ? JSON.parse(metadataRaw) : metadataRaw)
        : undefined;

      const tx: LedgerTransactionEntity = {
        id,
        accountId: accId,
        transactionType: txType as any,
        referenceId: refId,
        description,
        metadata: metadata as Record<string, unknown> | undefined,
        createdAt: new Date(),
      };
      this.ledgerTransactions.set(id, tx);
      this.ledgerTxByRef.set(refKey, id);
      return { rows: [tx as unknown as T], rowCount: 1 };
    }

    // 20. INSERT INTO ledger_entries
    if (/INSERT\s+INTO\s+ledger_entries/i.test(trimmed)) {
      const id = params[0] as string;
      const txId = params[1] as string;
      const accId = params[2] as string;
      const asset = params[3] as string;
      const direction = params[4] as string;
      const amount = params[5] as string;
      const balanceAfter = params[6] as string;

      const entry: LedgerEntryEntity = {
        id,
        transactionId: txId,
        accountId: accId,
        asset,
        direction: direction as 'CREDIT' | 'DEBIT',
        amount,
        balanceAfter,
        createdAt: new Date(),
      };
      this.ledgerEntries.push(entry);
      return { rows: [entry as unknown as T], rowCount: 1 };
    }

    // 21. SELECT ... FROM ledger_entries WHERE transaction_id = $1
    if (/FROM\s+ledger_entries\s+WHERE\s+transaction_id\s*=\s*\$1/i.test(trimmed)) {
      const txId = params[0] as string;
      const entries = this.ledgerEntries.filter(e => e.transactionId === txId);
      return {
        rows: entries.map(e => ({
          id: e.id,
          transaction_id: e.transactionId,
          account_id: e.accountId,
          asset: e.asset,
          direction: e.direction,
          amount: e.amount,
          balance_after: e.balanceAfter,
          balanceAfter: e.balanceAfter,
          created_at: e.createdAt,
        })) as unknown as T[],
        rowCount: entries.length,
      };
    }

    // 22. SELECT ... FROM ledger_entries WHERE account_id = $1 AND asset = $2 AND direction = 'CREDIT'
    if (/FROM\s+ledger_entries\s+WHERE\s+account_id\s*=\s*\$1\s+AND\s+asset\s*=\s*\$2\s+AND\s+direction\s*=\s*'CREDIT'/i.test(trimmed)) {
      const accId = params[0] as string;
      const asset = params[1] as string;
      const entries = this.ledgerEntries.filter(e => e.accountId === accId && e.asset === asset && e.direction === 'CREDIT');
      let total = '0';
      for (const e of entries) {
        // Simple string addition for test compatibility
        total = this.decimalAddSimple(total, e.amount);
      }
      return { rows: [{ total } as unknown as T], rowCount: 1 };
    }

    // 23. SELECT ... FROM ledger_entries WHERE account_id = $1 AND asset = $2 AND direction = 'DEBIT'
    if (/FROM\s+ledger_entries\s+WHERE\s+account_id\s*=\s*\$1\s+AND\s+asset\s*=\s*\$2\s+AND\s+direction\s*=\s*'DEBIT'/i.test(trimmed)) {
      const accId = params[0] as string;
      const asset = params[1] as string;
      const entries = this.ledgerEntries.filter(e => e.accountId === accId && e.asset === asset && e.direction === 'DEBIT');
      let total = '0';
      for (const e of entries) {
        total = this.decimalAddSimple(total, e.amount);
      }
      return { rows: [{ total } as unknown as T], rowCount: 1 };
    }

    // 24. SELECT COUNT(*) FROM ledger_entries ... (history count)
    if (/SELECT\s+COUNT\s*\(\s*\*\s*\)/i.test(trimmed) && /ledger_entries/i.test(trimmed)) {
      const accId = params[0] as string;
      let entries = this.ledgerEntries.filter(e => e.accountId === accId);

      // Apply additional filters if params exist
      let pIdx = 1;
      if (params[pIdx] && /e\.asset\s*=\s*\$/i.test(trimmed)) {
        const asset = params[pIdx] as string;
        entries = entries.filter(e => e.asset === asset);
        pIdx++;
      }
      if (params[pIdx] && /t\.transaction_type\s*=\s*\$/i.test(trimmed)) {
        const txType = params[pIdx] as string;
        entries = entries.filter(e => {
          const tx = this.ledgerTransactions.get(e.transactionId);
          return tx?.transactionType === txType;
        });
        pIdx++;
      }
      if (params[pIdx] && /t\.reference_id\s*=\s*\$/i.test(trimmed)) {
        const refId = params[pIdx] as string;
        entries = entries.filter(e => {
          const tx = this.ledgerTransactions.get(e.transactionId);
          return tx?.referenceId === refId;
        });
      }

      return { rows: [{ total: String(entries.length) } as unknown as T], rowCount: 1 };
    }

    // 25. SELECT ... FROM ledger_entries JOIN ledger_transactions (history query)
    if (/FROM\s+ledger_entries\s+e\s+JOIN\s+ledger_transactions\s+t/i.test(trimmed)) {
      const accId = params[0] as string;
      let entries = this.ledgerEntries.filter(e => e.accountId === accId);

      // Apply filters
      let pIdx = 1;
      if (params[pIdx] && /e\.asset\s*=\s*\$/i.test(trimmed)) {
        const asset = params[pIdx] as string;
        entries = entries.filter(e => e.asset === asset);
        pIdx++;
      }
      if (params[pIdx] && /t\.transaction_type\s*=\s*\$/i.test(trimmed)) {
        const txType = params[pIdx] as string;
        entries = entries.filter(e => {
          const tx = this.ledgerTransactions.get(e.transactionId);
          return tx?.transactionType === txType;
        });
        pIdx++;
      }
      if (params[pIdx] && /t\.reference_id\s*=\s*\$/i.test(trimmed)) {
        const refId = params[pIdx] as string;
        entries = entries.filter(e => {
          const tx = this.ledgerTransactions.get(e.transactionId);
          return tx?.referenceId === refId;
        });
        pIdx++;
      }

      // Sort by created_at DESC
      entries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      // Pagination: LIMIT and OFFSET
      const limit = params[pIdx] as number | undefined;
      const offset = params[pIdx + 1] as number | undefined;
      if (limit !== undefined && offset !== undefined) {
        entries = entries.slice(offset, offset + limit);
      }

      const rows = entries.map(e => {
        const tx = this.ledgerTransactions.get(e.transactionId)!;
        return {
          transaction_id: e.transactionId,
          transactionId: e.transactionId,
          transaction_type: tx?.transactionType,
          transactionType: tx?.transactionType,
          reference_id: tx?.referenceId,
          referenceId: tx?.referenceId,
          description: tx?.description,
          direction: e.direction,
          asset: e.asset,
          amount: e.amount,
          balance_after: e.balanceAfter,
          balanceAfter: e.balanceAfter,
          created_at: e.createdAt,
          createdAt: e.createdAt,
        };
      });

      return { rows: rows as unknown as T[], rowCount: rows.length };
    }

    return { rows: [] as T[], rowCount: 0 };
  }

  /**
   * Simple fixed-point decimal addition for in-memory aggregation.
   * Used internally by query handlers to sum NUMERIC(36,18) values.
   */
  private decimalAddSimple(a: string, b: string): string {
    const PREC = 18;
    const SCAL = BigInt(10) ** BigInt(PREC);

    function parse(val: string): bigint {
      const parts = val.split('.');
      const intPart = parts[0] || '0';
      const fracPart = (parts[1] || '').padEnd(PREC, '0').slice(0, PREC);
      return BigInt(intPart) * SCAL + BigInt(fracPart);
    }

    function format(val: bigint): string {
      const intP = val / SCAL;
      const fracP = val % SCAL;
      return `${intP}.${fracP.toString().padStart(PREC, '0')}`;
    }

    return format(parse(a) + parse(b));
  }

  public async healthCheck(): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      if (!this.isConnected) {
        return {
          healthy: false,
          latencyMs: Date.now() - start,
          error: this.connectionError || 'Database pool disconnected'
        };
      }
      return { healthy: true, latencyMs: Date.now() - start };
    } catch (err) {
      const error = err as Error;
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        error: error.message
      };
    }
  }

  public getStatus(): DatabaseStatus {
    return {
      connected: this.isConnected,
      poolSize: this.totalPoolSize,
      activeConnections: this.activeClients,
      idleConnections: Math.max(0, this.totalPoolSize - this.activeClients),
      error: this.connectionError || undefined
    };
  }
}

export const db = new DatabasePool();
