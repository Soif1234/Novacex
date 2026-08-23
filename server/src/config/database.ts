import pg from 'pg';
import crypto from 'crypto';
import { env } from './env';
import { logger } from './logger';
import { UserEntity, UserProfileEntity, UserAuthCredentialsEntity, UserSessionEntity } from '../models/user.model';
import { AccountEntity, AssetEntity, WalletBalanceEntity } from '../models/account.model';
import { LedgerTransactionEntity, LedgerEntryEntity } from '../models/ledger.model';
import { TradingPairEntity, OrderEntity, TradeEntity } from '../models/order.model';
import {
  FuturesPositionEntity,
  FuturesOrderEntity,
  FuturesTpSlConfigEntity,
  FuturesFundingHistoryEntity,
  FuturesLiquidationEntity,
} from '../models/futures.model';
import { decimalAdd, decimalSubtract, decimalCompare, decimalIsZero } from '../services/ledger/decimal';

export interface DatabaseStatus {
  connected: boolean;
  poolSize: number;
  activeConnections: number;
  idleConnections: number;
  waitingClients?: number;
  lastPingMs?: number;
  error?: string;
  config?: {
    min: number;
    max: number;
    idleTimeoutMillis: number;
    connectionTimeoutMillis: number;
    queryTimeoutMillis: number;
  };
}

export interface QueryResult<T = unknown> {
  rows: T[];
  rowCount: number;
}

export interface QueryOptions {
  timeoutMs?: number;
}

export interface IDatabaseConnection {
  connect(): Promise<void>;
  close(): Promise<void>;
  query<T = unknown>(sql: string, params?: unknown[], options?: QueryOptions): Promise<QueryResult<T>>;
  transaction<T = unknown>(callback: (client: IDatabaseConnection) => Promise<T>, options?: QueryOptions): Promise<T>;
  healthCheck(): Promise<{ healthy: boolean; latencyMs: number; error?: string }>;
  getStatus(): DatabaseStatus;
  reset?(): void;
}

function formatPgResult<T>(res: any): QueryResult<T> {
  if (!res) {
    return { rows: [], rowCount: 0 };
  }
  if (Array.isArray(res)) {
    const last = res[res.length - 1];
    const rows = (last?.rows || []) as T[];
    return {
      rows,
      rowCount: last?.rowCount ?? rows.length,
    };
  }
  return {
    rows: (res.rows || []) as T[],
    rowCount: res.rowCount ?? (res.rows ? res.rows.length : 0),
  };
}

/**
 * Real PostgreSQL Transaction Client.
 * Wraps an acquired pg.PoolClient for atomic multi-statement transactions with query timeout protection.
 */
export class PostgresTransactionClient implements IDatabaseConnection {
  constructor(private client: pg.PoolClient, private defaultOptions?: QueryOptions) {}

  public async connect(): Promise<void> {}
  public async close(): Promise<void> {}

  public async query<T = unknown>(
    sql: string,
    params: unknown[] = [],
    options?: QueryOptions
  ): Promise<QueryResult<T>> {
    const timeoutMs = options?.timeoutMs ?? this.defaultOptions?.timeoutMs ?? env.DB_QUERY_TIMEOUT_MS;

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const timeoutErr = new Error(`QUERY_TIMEOUT: PostgreSQL query exceeded execution timeout of ${timeoutMs}ms`);
        logger.error('PostgreSQL transaction query timeout exceeded', {
          timeoutMs,
          sql: sql.substring(0, 120),
        });
        reject(timeoutErr);
      }, timeoutMs);
    });

    try {
      const queryPromise = this.client.query(sql, params);
      const res = await Promise.race([queryPromise, timeoutPromise]);
      return formatPgResult<T>(res);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  public async transaction<T = unknown>(callback: (client: IDatabaseConnection) => Promise<T>): Promise<T> {
    return callback(this);
  }

  public async healthCheck(): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
    return { healthy: true, latencyMs: 0 };
  }

  public getStatus(): DatabaseStatus {
    return {
      connected: true,
      poolSize: 1,
      activeConnections: 1,
      idleConnections: 0,
    };
  }
}

/**
 * Real PostgreSQL Database Pool using 'pg.Pool'.
 * Production and runtime database adapter with resilience, queue monitoring, and query timeouts.
 */
export class PostgresDatabasePool implements IDatabaseConnection {
  private pool: pg.Pool;
  private isConnected = false;
  private connectionError: string | null = null;
  private poolConfig: pg.PoolConfig;

  constructor(customConfig?: pg.PoolConfig) {
    const baseConfig: pg.PoolConfig = env.DATABASE_URL
      ? {
          connectionString: env.DATABASE_URL,
          min: env.DB_POOL_MIN,
          max: env.DB_POOL_MAX,
          idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
          connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
          statement_timeout: env.DB_QUERY_TIMEOUT_MS,
          query_timeout: env.DB_QUERY_TIMEOUT_MS,
        }
      : {
          host: env.DB_HOST,
          port: env.DB_PORT,
          database: env.DB_NAME,
          user: env.DB_USER,
          password: env.DB_PASSWORD,
          min: env.DB_POOL_MIN,
          max: env.DB_POOL_MAX,
          idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
          connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
          statement_timeout: env.DB_QUERY_TIMEOUT_MS,
          query_timeout: env.DB_QUERY_TIMEOUT_MS,
        };

    this.poolConfig = customConfig ? { ...baseConfig, ...customConfig } : baseConfig;
    this.pool = new pg.Pool(this.poolConfig);

    this.pool.on('error', (err: Error) => {
      logger.error('Unexpected error on idle PostgreSQL client in connection pool', {
        error: err.message,
        stack: err.stack,
      });
      this.connectionError = err.message;
    });

    this.pool.on('connect', () => {
      if (this.pool.waitingCount > 0) {
        logger.warn('PostgreSQL connection pool client waiting in queue', {
          waitingCount: this.pool.waitingCount,
          totalCount: this.pool.totalCount,
          max: this.poolConfig.max,
        });
      }
    });
  }

  public async connect(): Promise<void> {
    try {
      logger.info('Initializing PostgreSQL connection pool', {
        host: this.poolConfig.host || env.DB_HOST,
        port: this.poolConfig.port || env.DB_PORT,
        database: this.poolConfig.database || env.DB_NAME,
        user: this.poolConfig.user || env.DB_USER,
        min: this.poolConfig.min ?? env.DB_POOL_MIN,
        max: this.poolConfig.max ?? env.DB_POOL_MAX,
        connectionTimeoutMillis: this.poolConfig.connectionTimeoutMillis ?? env.DB_CONNECTION_TIMEOUT_MS,
        idleTimeoutMillis: this.poolConfig.idleTimeoutMillis ?? env.DB_IDLE_TIMEOUT_MS,
        queryTimeoutMillis: this.poolConfig.statement_timeout ?? env.DB_QUERY_TIMEOUT_MS,
      });

      const client = await this.pool.connect();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }

      this.isConnected = true;
      this.connectionError = null;
      logger.info('PostgreSQL connection pool initialized successfully');
    } catch (err: any) {
      this.isConnected = false;
      this.connectionError = err.message;
      logger.error('Failed to connect to PostgreSQL database', { error: err.message });
      throw err;
    }
  }

  public async query<T = unknown>(
    sql: string,
    params: unknown[] = [],
    options?: QueryOptions
  ): Promise<QueryResult<T>> {
    if (!this.isConnected && this.pool.totalCount === 0) {
      await this.connect().catch(() => {});
    }

    if (this.pool.waitingCount > 0) {
      logger.warn('PostgreSQL pool queue depth high', {
        waitingCount: this.pool.waitingCount,
        totalCount: this.pool.totalCount,
        idleCount: this.pool.idleCount,
        max: this.poolConfig.max,
      });
    }

    const timeoutMs = options?.timeoutMs ?? (this.poolConfig.statement_timeout as number) ?? env.DB_QUERY_TIMEOUT_MS;

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const timeoutErr = new Error(`QUERY_TIMEOUT: PostgreSQL query exceeded execution timeout of ${timeoutMs}ms`);
        logger.error('PostgreSQL query timeout exceeded', {
          timeoutMs,
          sql: sql.substring(0, 120),
        });
        reject(timeoutErr);
      }, timeoutMs);
    });

    try {
      const queryPromise = this.pool.query(sql, params);
      const res = await Promise.race([queryPromise, timeoutPromise]);
      return formatPgResult<T>(res);
    } catch (err: any) {
      logger.error('PostgreSQL query execution error', {
        error: err.message,
        sql: sql.substring(0, 120),
      });
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  public async transaction<T = unknown>(
    callback: (client: IDatabaseConnection) => Promise<T>,
    options?: QueryOptions
  ): Promise<T> {
    const client = await this.pool.connect();
    const txClient = new PostgresTransactionClient(client, options);

    try {
      await client.query('BEGIN');
      const result = await callback(txClient);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr: any) {
        logger.error('Error during transaction rollback', { error: rollbackErr.message });
      }
      // Note: Financial transactions are NEVER automatically retried to prevent double execution.
      throw err;
    } finally {
      client.release();
    }
  }

  public async healthCheck(): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      await this.pool.query('SELECT 1');
      return { healthy: true, latencyMs: Date.now() - start };
    } catch (err: any) {
      return { healthy: false, latencyMs: Date.now() - start, error: err.message };
    }
  }

  public getStatus(): DatabaseStatus {
    return {
      connected: this.isConnected,
      poolSize: this.pool.totalCount,
      activeConnections: Math.max(0, this.pool.totalCount - this.pool.idleCount),
      idleConnections: this.pool.idleCount,
      waitingClients: this.pool.waitingCount,
      error: this.connectionError || undefined,
      config: {
        min: this.poolConfig.min ?? env.DB_POOL_MIN,
        max: this.poolConfig.max ?? env.DB_POOL_MAX,
        idleTimeoutMillis: this.poolConfig.idleTimeoutMillis ?? env.DB_IDLE_TIMEOUT_MS,
        connectionTimeoutMillis: this.poolConfig.connectionTimeoutMillis ?? env.DB_CONNECTION_TIMEOUT_MS,
        queryTimeoutMillis: (this.poolConfig.statement_timeout as number) ?? env.DB_QUERY_TIMEOUT_MS,
      },
    };
  }

  public async close(): Promise<void> {
    try {
      await this.pool.end();
      this.isConnected = false;
      logger.info('PostgreSQL connection pool closed cleanly');
    } catch (err: any) {
      logger.error('Error closing PostgreSQL pool', { error: err.message });
      throw err;
    }
  }
}

/**
 * In-Memory Database Pool.
 * Used for isolated unit testing without external database dependencies.
 */
export class InMemoryDatabasePool implements IDatabaseConnection {

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
  private apiKeys = new Map<string, any>(); // keyId -> apiKey
  private userKycProfiles = new Map<string, any>(); // userId -> kycProfile
  private sanctionedAddresses = new Map<string, any>(); // address -> record
  private adminAuditLogs: any[] = [];
  private systemCircuitBreaker: any = null;
  private reconciliationReports: any[] = [];
  private securityThreatAlerts = new Map<string, any>();
  private accounts = new Map<string, AccountEntity>(); // id -> account
  private assets = new Map<string, AssetEntity>(); // symbol -> asset
  private schemaMigrations = new Set<string>();

  // Ledger tables
  private walletBalances = new Map<string, WalletBalanceEntity>(); // "accountId:asset" -> balance
  private ledgerTransactions = new Map<string, LedgerTransactionEntity>(); // id -> tx
  private ledgerTxByRef = new Map<string, string>(); // "accountId:referenceId" -> txId
  private ledgerEntries: LedgerEntryEntity[] = []; // append-only journal
  private lockedWallets = new Set<string>(); // concurrency lock keys

  // Spot Order & Trade tables
  private tradingPairs = new Map<string, TradingPairEntity>(); // symbol -> pair
  private orders = new Map<string, OrderEntity>(); // id -> order
  private ordersByClientOrderId = new Map<string, string>(); // "accountId:clientOrderId" -> orderId
  private trades: TradeEntity[] = [];

  // Futures tables
  private futuresPositions = new Map<string, FuturesPositionEntity>(); // id -> position
  private futuresOrders = new Map<string, FuturesOrderEntity>(); // id -> futuresOrder
  private futuresTpSlConfigs = new Map<string, FuturesTpSlConfigEntity>(); // id -> config
  private futuresFundingHistory: FuturesFundingHistoryEntity[] = [];
  private futuresLiquidations: FuturesLiquidationEntity[] = [];
  private kLines: any[] = [];

  constructor(private config = env) {
    this.totalPoolSize = config.DB_POOL_MIN;
    this.initDefaultAssets();
    this.initDefaultTradingPairs();
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

  private initDefaultTradingPairs(): void {
    const defaultPairs: TradingPairEntity[] = [
      { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', marketType: 'SPOT', tickSize: '0.01', lotSize: '0.0001', minNotional: '5.0', makerFeeRate: '0.001', takerFeeRate: '0.001', isActive: true, createdAt: new Date() },
      { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', marketType: 'SPOT', tickSize: '0.01', lotSize: '0.001', minNotional: '5.0', makerFeeRate: '0.001', takerFeeRate: '0.001', isActive: true, createdAt: new Date() },
      { symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT', marketType: 'SPOT', tickSize: '0.001', lotSize: '0.01', minNotional: '5.0', makerFeeRate: '0.001', takerFeeRate: '0.001', isActive: true, createdAt: new Date() },
      { symbol: 'BTCUSDC', baseAsset: 'BTC', quoteAsset: 'USDC', marketType: 'SPOT', tickSize: '0.01', lotSize: '0.0001', minNotional: '5.0', makerFeeRate: '0.001', takerFeeRate: '0.001', isActive: true, createdAt: new Date() },
    ];
    for (const p of defaultPairs) {
      this.tradingPairs.set(p.symbol, { ...p });
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
    this.tradingPairs.clear();
    this.initDefaultTradingPairs();
    this.orders.clear();
    this.ordersByClientOrderId.clear();
    this.trades = [];
    this.futuresPositions.clear();
    this.futuresOrders.clear();
    this.futuresTpSlConfigs.clear();
    this.futuresFundingHistory = [];
    this.futuresLiquidations = [];
    this.apiKeys.clear();
    this.userKycProfiles.clear();
    this.sanctionedAddresses.clear();
    this.adminAuditLogs = [];
    this.systemCircuitBreaker = null;
    this.reconciliationReports = [];
    this.securityThreatAlerts.clear();
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
    const snapTradingPairs = new Map(this.tradingPairs);
    const snapOrders = new Map(this.orders);
    const snapOrdersByClientOrderId = new Map(this.ordersByClientOrderId);
    const snapTrades = [...this.trades];
    const snapFuturesPositions = new Map(this.futuresPositions);
    const snapFuturesOrders = new Map(this.futuresOrders);
    const snapFuturesTpSlConfigs = new Map(this.futuresTpSlConfigs);
    const snapFuturesFundingHistory = [...this.futuresFundingHistory];
    const snapFuturesLiquidations = [...this.futuresLiquidations];
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
      this.tradingPairs = snapTradingPairs;
      this.orders = snapOrders;
      this.ordersByClientOrderId = snapOrdersByClientOrderId;
      this.trades = snapTrades;
      this.futuresPositions = snapFuturesPositions;
      this.futuresOrders = snapFuturesOrders;
      this.futuresTpSlConfigs = snapFuturesTpSlConfigs;
      this.futuresFundingHistory = snapFuturesFundingHistory;
      this.futuresLiquidations = snapFuturesLiquidations;
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
      two_factor_secret: c.twoFactorSecret,
      twoFactorSecret: c.twoFactorSecret,
      two_factor_enabled: c.twoFactorEnabled,
      twoFactorEnabled: c.twoFactorEnabled,
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

  private mapTradingPair(tp: TradingPairEntity): any {
    return {
      ...tp,
      base_asset: tp.baseAsset,
      quote_asset: tp.quoteAsset,
      market_type: tp.marketType,
      tick_size: tp.tickSize,
      lot_size: tp.lotSize,
      min_notional: tp.minNotional,
      maker_fee_rate: tp.makerFeeRate,
      taker_fee_rate: tp.takerFeeRate,
      is_active: tp.isActive,
      created_at: tp.createdAt,
      baseAsset: tp.baseAsset,
      quoteAsset: tp.quoteAsset,
      marketType: tp.marketType,
      tickSize: tp.tickSize,
      lotSize: tp.lotSize,
      minNotional: tp.minNotional,
      makerFeeRate: tp.makerFeeRate,
      takerFeeRate: tp.takerFeeRate,
      isActive: tp.isActive,
      createdAt: tp.createdAt,
    };
  }

  private mapOrder(o: OrderEntity): any {
    return {
      ...o,
      client_order_id: o.clientOrderId,
      account_id: o.accountId,
      market: o.market,
      symbol: o.symbol,
      side: o.side,
      type: o.type,
      price: o.price,
      quantity: o.quantity,
      filled_quantity: o.filledQuantity,
      remaining_quantity: o.remainingQuantity,
      locked_amount: o.lockedAmount,
      locked_asset: o.lockedAsset,
      status: o.status,
      time_in_force: o.timeInForce,
      created_at: o.createdAt,
      updated_at: o.updatedAt,
      clientOrderId: o.clientOrderId,
      accountId: o.accountId,
      filledQuantity: o.filledQuantity,
      remainingQuantity: o.remainingQuantity,
      lockedAmount: o.lockedAmount,
      lockedAsset: o.lockedAsset,
      timeInForce: o.timeInForce,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
    };
  }

  private mapTrade(t: TradeEntity): any {
    return {
      ...t,
      order_id: t.orderId,
      account_id: t.accountId,
      market: t.market,
      symbol: t.symbol,
      side: t.side,
      price: t.price,
      quantity: t.quantity,
      quote_quantity: t.quoteQuantity,
      fee: t.fee,
      fee_asset: t.feeAsset,
      is_maker: t.isMaker,
      counterparty_order_id: t.counterpartyOrderId,
      created_at: t.createdAt,
      orderId: t.orderId,
      accountId: t.accountId,
      quoteQuantity: t.quoteQuantity,
      feeAsset: t.feeAsset,
      isMaker: t.isMaker,
      counterpartyOrderId: t.counterpartyOrderId,
      createdAt: t.createdAt,
    };
  }

  private mapFuturesPosition(p: FuturesPositionEntity): any {
    return {
      ...p,
      account_id: p.accountId,
      entry_price: p.entryPrice,
      mark_price: p.markPrice,
      liquidation_price: p.liquidationPrice,
      margin_mode: p.marginMode,
      initial_margin: p.initialMargin,
      maintenance_margin: p.maintenanceMargin,
      realized_pnl: p.realizedPnl,
      created_at: p.createdAt,
      updated_at: p.updatedAt,
      accountId: p.accountId,
      entryPrice: p.entryPrice,
      markPrice: p.markPrice,
      liquidationPrice: p.liquidationPrice,
      marginMode: p.marginMode,
      initialMargin: p.initialMargin,
      maintenanceMargin: p.maintenanceMargin,
      realizedPnl: p.realizedPnl,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  private mapFuturesOrder(fo: FuturesOrderEntity): any {
    return {
      ...fo,
      order_id: fo.orderId,
      account_id: fo.accountId,
      position_side: fo.positionSide,
      margin_mode: fo.marginMode,
      reduce_only: fo.reduceOnly,
      close_position: fo.closePosition,
      created_at: fo.createdAt,
      orderId: fo.orderId,
      accountId: fo.accountId,
      positionSide: fo.positionSide,
      marginMode: fo.marginMode,
      reduceOnly: fo.reduceOnly,
      closePosition: fo.closePosition,
      createdAt: fo.createdAt,
    };
  }

  private mapFuturesTpSl(c: FuturesTpSlConfigEntity): any {
    return {
      ...c,
      position_id: c.positionId,
      account_id: c.accountId,
      position_side: c.positionSide,
      take_profit_enabled: c.takeProfitEnabled,
      take_profit_price: c.takeProfitPrice,
      stop_loss_enabled: c.stopLossEnabled,
      stop_loss_price: c.stopLossPrice,
      created_at: c.createdAt,
      updated_at: c.updatedAt,
      positionId: c.positionId,
      accountId: c.accountId,
      positionSide: c.positionSide,
      takeProfitEnabled: c.takeProfitEnabled,
      takeProfitPrice: c.takeProfitPrice,
      stopLossEnabled: c.stopLossEnabled,
      stopLossPrice: c.stopLossPrice,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }

  private mapFuturesLiquidation(l: FuturesLiquidationEntity): any {
    return {
      ...l,
      position_id: l.positionId,
      account_id: l.accountId,
      bankruptcy_price: l.bankruptcyPrice,
      liquidation_price: l.liquidationPrice,
      loss_amount: l.lossAmount,
      insurance_fund_delta: l.insuranceFundDelta,
      created_at: l.createdAt,
      positionId: l.positionId,
      accountId: l.accountId,
      bankruptcyPrice: l.bankruptcyPrice,
      liquidationPrice: l.liquidationPrice,
      lossAmount: l.lossAmount,
      insuranceFundDelta: l.insuranceFundDelta,
      createdAt: l.createdAt,
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

    // 7b. UPDATE user_auth_credentials
    if (/UPDATE\s+user_auth_credentials/i.test(trimmed)) {
      if (/two_factor_secret\s*=\s*\$1/i.test(trimmed)) {
        const secret = params[0] as string;
        const userId = params[1] as string;
        const creds = this.userCredentials.get(userId);
        if (creds) {
          creds.twoFactorSecret = secret;
          creds.updatedAt = new Date();
        }
        return { rows: [], rowCount: 1 };
      }

      if (/two_factor_enabled\s*=\s*TRUE/i.test(trimmed)) {
        const userId = params[0] as string;
        const creds = this.userCredentials.get(userId);
        if (creds) {
          creds.twoFactorEnabled = true;
          creds.updatedAt = new Date();
        }
        return { rows: [], rowCount: 1 };
      }

      if (/two_factor_enabled\s*=\s*FALSE/i.test(trimmed)) {
        const userId = params[0] as string;
        const creds = this.userCredentials.get(userId);
        if (creds) {
          creds.twoFactorEnabled = false;
          creds.twoFactorSecret = undefined;
          creds.updatedAt = new Date();
        }
        return { rows: [], rowCount: 1 };
      }
    }

    // 7c. INSERT INTO api_keys
    if (/INSERT\s+INTO\s+api_keys/i.test(trimmed)) {
      const id = crypto.randomUUID();
      const userId = params[0] as string;
      const keyId = params[1] as string;
      const secretHash = params[2] as string;
      const encryptedSecret = params[3] as string;
      const secretPreview = params[4] as string;
      const label = params[5] as string;
      const permissions = params[6] as string[];
      const ipWhitelist = params[7] as string[];
      const expiresAt = params[8] ? new Date(params[8] as string) : undefined;

      const apiKey = {
        id,
        user_id: userId,
        userId,
        key_id: keyId,
        keyId,
        secret_hash: secretHash,
        secretHash,
        encrypted_secret: encryptedSecret,
        encryptedSecret,
        secret_preview: secretPreview,
        secretPreview,
        label,
        permissions,
        ip_whitelist: ipWhitelist,
        ipWhitelist,
        status: 'ACTIVE',
        last_used_at: undefined,
        expires_at: expiresAt,
        expiresAt,
        created_at: new Date(),
        createdAt: new Date(),
        updated_at: new Date(),
        updatedAt: new Date(),
      };

      this.apiKeys.set(keyId, apiKey);
      return { rows: [apiKey as T], rowCount: 1 };
    }

    // 7d. SELECT ... FROM api_keys WHERE user_id = $1
    if (/FROM\s+api_keys\s+WHERE\s+user_id\s*=/i.test(trimmed)) {
      const userId = params[0] as string;
      if (/COUNT\(\*\)/i.test(trimmed)) {
        const count = Array.from(this.apiKeys.values()).filter(k => (k.user_id === userId || k.userId === userId) && k.status === 'ACTIVE').length;
        return { rows: [{ count: String(count) }] as T[], rowCount: 1 };
      }
      const keys = Array.from(this.apiKeys.values())
        .filter(k => k.user_id === userId || k.userId === userId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return { rows: keys as T[], rowCount: keys.length };
    }

    // 7e. SELECT ... FROM api_keys WHERE key_id = $1
    if (/FROM\s+api_keys\s+WHERE\s+key_id\s*=/i.test(trimmed)) {
      const keyId = params[0] as string;
      const key = this.apiKeys.get(keyId);
      return { rows: key ? [key as T] : [], rowCount: key ? 1 : 0 };
    }

    // 7f. UPDATE api_keys SET status = 'REVOKED'
    if (/UPDATE\s+api_keys\s+SET\s+status\s*=\s*'REVOKED'/i.test(trimmed)) {
      const userId = params[0] as string;
      const keyIdOrId = params[1] as string | undefined;
      let count = 0;
      for (const [k, key] of this.apiKeys.entries()) {
        if ((key.user_id === userId || key.userId === userId) && key.status === 'ACTIVE') {
          if (!keyIdOrId || key.key_id === keyIdOrId || key.keyId === keyIdOrId || key.id === keyIdOrId) {
            key.status = 'REVOKED';
            key.updated_at = new Date();
            key.updatedAt = new Date();
            count++;
          }
        }
      }
      return { rows: count > 0 ? [{ id: userId }] as T[] : [], rowCount: count };
    }

    // 7g. UPDATE api_keys SET last_used_at
    if (/UPDATE\s+api_keys\s+SET\s+last_used_at/i.test(trimmed)) {
      const id = params[0] as string;
      for (const [k, key] of this.apiKeys.entries()) {
        if (key.id === id || key.key_id === id) {
          key.last_used_at = new Date();
          key.lastUsedAt = new Date();
          return { rows: [], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    }

    // 7h. INSERT INTO user_kyc_profiles
    if (/INSERT\s+INTO\s+user_kyc_profiles/i.test(trimmed)) {
      const userId = params[0] as string;
      const firstName = params[1] as string;
      const lastName = params[2] as string;
      const dateOfBirth = params[3] as string;
      const nationality = params[4] as string;
      const idDocumentType = params[5] as string;
      const idDocumentNumber = params[6] as string;
      const idDocumentFrontUrl = params[7] as string;
      const idDocumentBackUrl = params[8] as string;
      const proofOfAddressUrl = params[9] as string;

      const profile = {
        id: crypto.randomUUID(),
        user_id: userId,
        userId,
        tier: 'TIER_0',
        status: 'PENDING_REVIEW',
        first_name: firstName,
        firstName,
        last_name: lastName,
        lastName,
        date_of_birth: dateOfBirth,
        dateOfBirth,
        nationality,
        id_document_type: idDocumentType,
        idDocumentType,
        id_document_number: idDocumentNumber,
        idDocumentNumber,
        id_document_front_url: idDocumentFrontUrl,
        idDocumentFrontUrl,
        id_document_back_url: idDocumentBackUrl,
        idDocumentBackUrl,
        proof_of_address_url: proofOfAddressUrl,
        proofOfAddressUrl,
        rejection_reason: null,
        rejectionReason: undefined,
        reviewer_id: null,
        reviewerId: undefined,
        submitted_at: new Date(),
        submittedAt: new Date(),
        verified_at: null,
        verifiedAt: undefined,
        created_at: new Date(),
        createdAt: new Date(),
        updated_at: new Date(),
        updatedAt: new Date(),
      };

      this.userKycProfiles.set(userId, profile);
      return { rows: [profile as T], rowCount: 1 };
    }

    // 7i. UPDATE user_kyc_profiles
    if (/UPDATE\s+user_kyc_profiles/i.test(trimmed)) {
      if (/status\s*=\s*'PENDING_REVIEW'/i.test(trimmed)) {
        const userId = params[9] as string;
        let profile = this.userKycProfiles.get(userId);
        if (!profile) {
          profile = { id: crypto.randomUUID(), user_id: userId, userId, tier: 'TIER_0', created_at: new Date(), createdAt: new Date() };
          this.userKycProfiles.set(userId, profile);
        }
        profile.status = 'PENDING_REVIEW';
        profile.first_name = params[0];
        profile.firstName = params[0];
        profile.last_name = params[1];
        profile.lastName = params[1];
        profile.date_of_birth = params[2];
        profile.dateOfBirth = params[2];
        profile.nationality = params[3];
        profile.id_document_type = params[4];
        profile.idDocumentType = params[4];
        profile.id_document_number = params[5];
        profile.idDocumentNumber = params[5];
        profile.id_document_front_url = params[6];
        profile.idDocumentFrontUrl = params[6];
        profile.id_document_back_url = params[7];
        profile.idDocumentBackUrl = params[7];
        profile.proof_of_address_url = params[8];
        profile.proofOfAddressUrl = params[8];
        profile.rejection_reason = null;
        profile.rejectionReason = undefined;
        profile.submitted_at = new Date();
        profile.submittedAt = new Date();
        profile.updated_at = new Date();
        profile.updatedAt = new Date();
        return { rows: [profile as T], rowCount: 1 };
      }

      if (/status\s*=\s*'VERIFIED'/i.test(trimmed)) {
        const assignedTier = params[0] as string;
        const reviewerId = params[1] as string;
        const userId = params[2] as string;
        const profile = this.userKycProfiles.get(userId);
        if (profile) {
          profile.status = 'VERIFIED';
          profile.tier = assignedTier;
          profile.reviewer_id = reviewerId;
          profile.reviewerId = reviewerId;
          profile.rejection_reason = null;
          profile.rejectionReason = undefined;
          profile.verified_at = new Date();
          profile.verifiedAt = new Date();
          profile.updated_at = new Date();
          profile.updatedAt = new Date();
          return { rows: [profile as T], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      if (/status\s*=\s*'REJECTED'/i.test(trimmed)) {
        const reviewerId = params[0] as string;
        const rejectionReason = params[1] as string;
        const userId = params[2] as string;
        const profile = this.userKycProfiles.get(userId);
        if (profile) {
          profile.status = 'REJECTED';
          profile.tier = 'TIER_0';
          profile.reviewer_id = reviewerId;
          profile.reviewerId = reviewerId;
          profile.rejection_reason = rejectionReason;
          profile.rejectionReason = rejectionReason;
          profile.updated_at = new Date();
          profile.updatedAt = new Date();
          return { rows: [profile as T], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    }

    // 7j. SELECT ... FROM user_kyc_profiles WHERE user_id = $1
    if (/FROM\s+user_kyc_profiles\s+WHERE\s+user_id\s*=/i.test(trimmed)) {
      const userId = params[0] as string;
      const profile = this.userKycProfiles.get(userId);
      return { rows: profile ? [profile as T] : [], rowCount: profile ? 1 : 0 };
    }

    // 7k. Sanctioned Addresses queries
    if (/FROM\s+sanctioned_addresses\s+WHERE\s+address\s*=/i.test(trimmed)) {
      const address = params[0] as string;
      const record = this.sanctionedAddresses.get(address);
      if (record && record.is_active) {
        return { rows: [record as T], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (/INSERT\s+INTO\s+sanctioned_addresses/i.test(trimmed)) {
      const address = params[0] as string;
      const reason = params[1] as string;
      const source = params[2] as string;
      const record = {
        id: crypto.randomUUID(),
        address,
        reason,
        source: source || 'OFAC',
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      };
      this.sanctionedAddresses.set(address, record);
      return { rows: [record as T], rowCount: 1 };
    }

    // 7l. 24-hour withdrawal sum query
    if (/FROM\s+ledger_transactions\s+lt[\s\S]*JOIN\s+ledger_entries\s+le[\s\S]*lt\.transaction_type\s*=\s*'WITHDRAWAL'/i.test(trimmed)) {
      const accountIds = params[0] as string[];
      const withdrawalEntries: any[] = [];
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;

      for (const entry of this.ledgerEntries) {
        if (entry.direction === 'DEBIT' && Array.isArray(accountIds) && accountIds.includes(entry.accountId)) {
          const tx = this.ledgerTransactions.get(entry.transactionId);
          if (tx && tx.transactionType === 'WITHDRAWAL' && tx.createdAt.getTime() >= cutoff) {
            withdrawalEntries.push({ amount: entry.amount });
          }
        }
      }
      return { rows: withdrawalEntries as T[], rowCount: withdrawalEntries.length };
    }

    // 7m. INSERT INTO admin_audit_logs
    if (/INSERT\s+INTO\s+admin_audit_logs/i.test(trimmed)) {
      const adminUserId = params[0] as string;
      const action = params[1] as string;
      const targetUserId = params[2] as string | null;
      const targetResourceType = params[3] as string;
      const targetResourceId = params[4] as string | null;
      const prevState = params[5] ? JSON.parse(params[5] as string) : null;
      const newState = params[6] ? JSON.parse(params[6] as string) : null;
      const reason = params[7] as string | null;
      const ipAddress = params[8] as string | null;
      const userAgent = params[9] as string | null;

      const log = {
        id: crypto.randomUUID(),
        admin_user_id: adminUserId,
        adminUserId,
        action,
        target_user_id: targetUserId,
        targetUserId,
        target_resource_type: targetResourceType,
        targetResourceType,
        target_resource_id: targetResourceId,
        targetResourceId,
        previous_state: prevState,
        previousState: prevState,
        new_state: newState,
        newState,
        reason,
        ip_address: ipAddress,
        ipAddress,
        user_agent: userAgent,
        userAgent,
        created_at: new Date(),
        createdAt: new Date(),
      };

      this.adminAuditLogs.push(log);
      return { rows: [log as T], rowCount: 1 };
    }

    // 7n. SELECT ... FROM admin_audit_logs
    if (/FROM\s+admin_audit_logs/i.test(trimmed)) {
      let filtered = [...this.adminAuditLogs];
      if (/admin_user_id\s*=\s*\$[0-9]+/i.test(trimmed)) {
        const adminId = params[0] as string;
        filtered = filtered.filter(l => l.adminUserId === adminId || l.admin_user_id === adminId);
      }
      if (/target_user_id\s*=\s*\$[0-9]+/i.test(trimmed)) {
        const targetId = params.find((p, idx) => {
          return new RegExp(`target_user_id\\s*=\\s*\\$${idx + 1}`, 'i').test(trimmed);
        }) as string;
        if (targetId) {
          filtered = filtered.filter(l => l.targetUserId === targetId || l.target_user_id === targetId);
        }
      }
      if (/action\s*=\s*\$[0-9]+/i.test(trimmed)) {
        const actionVal = params.find((p, idx) => {
          return new RegExp(`action\\s*=\\s*\\$${idx + 1}`, 'i').test(trimmed);
        }) as string;
        if (actionVal) {
          filtered = filtered.filter(l => l.action === actionVal);
        }
      }

      if (/SELECT\s+COUNT\(\*\)/i.test(trimmed)) {
        return { rows: [{ total: String(filtered.length) }] as T[], rowCount: 1 };
      }

      filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      if (/LIMIT\s+\$[0-9]+\s+OFFSET\s+\$[0-9]+/i.test(trimmed)) {
        const pageSize = (params[params.length - 2] as number) || 20;
        const offset = (params[params.length - 1] as number) || 0;
        filtered = filtered.slice(offset, offset + pageSize);
      }
      return { rows: filtered as T[], rowCount: filtered.length };
    }

    // 7o. Admin queries for users list & counts
    if (/SELECT\s+COUNT\(\*\)\s+AS\s+count\s+FROM\s+users\s+WHERE\s+role\s*=\s*'ADMIN'/i.test(trimmed)) {
      const activeAdmins = Array.from(this.users.values()).filter(u => u.role === 'ADMIN' && u.accountStatus === 'ACTIVE');
      return { rows: [{ count: String(activeAdmins.length) }] as T[], rowCount: 1 };
    }

    if (/SELECT\s+COUNT\(\*\)\s+AS\s+total\s+FROM\s+users/i.test(trimmed)) {
      return { rows: [{ total: String(this.users.size) }] as T[], rowCount: 1 };
    }

    if (/SELECT\s+u\.id,\s*u\.email[\s\S]*FROM\s+users\s+u/i.test(trimmed)) {
      const list: any[] = [];
      for (const u of this.users.values()) {
        const kyc = this.userKycProfiles.get(u.id);
        list.push({
          id: u.id,
          email: u.email,
          role: u.role,
          accountStatus: u.accountStatus,
          kycTier: kyc?.tier || 'TIER_0',
          kycStatus: kyc?.status || 'UNVERIFIED',
          createdAt: u.createdAt,
          updatedAt: u.updatedAt,
        });
      }
      list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return { rows: list as T[], rowCount: list.length };
    }

    // 7p. UPDATE users SET account_status = $1
    if (/UPDATE\s+users\s+SET\s+account_status\s*=/i.test(trimmed)) {
      const status = params[0] as 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
      const userId = params[1] as string;
      const user = this.users.get(userId);
      if (user) {
        user.accountStatus = status;
        user.updatedAt = new Date();
        return { rows: [user as T], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // 7q. UPDATE users SET role = $1
    if (/UPDATE\s+users\s+SET\s+role\s*=/i.test(trimmed)) {
      let role: 'USER' | 'ADMIN' | 'SYSTEM_BOT';
      let userId: string;
      if (/role\s*=\s*'ADMIN'/i.test(trimmed)) {
        role = 'ADMIN';
        userId = params[0] as string;
      } else if (/role\s*=\s*'SYSTEM_BOT'/i.test(trimmed)) {
        role = 'SYSTEM_BOT';
        userId = params[0] as string;
      } else if (/role\s*=\s*'USER'/i.test(trimmed)) {
        role = 'USER';
        userId = params[0] as string;
      } else {
        role = params[0] as 'USER' | 'ADMIN' | 'SYSTEM_BOT';
        userId = params[1] as string;
      }
      const user = this.users.get(userId);
      if (user) {
        user.role = role;
        user.updatedAt = new Date();
        return { rows: [user as T], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // 7r. Bulk session / api key revocation on suspension
    if (/UPDATE\s+user_sessions\s+SET\s+status\s*=\s*'REVOKED'[\s\S]*WHERE\s+user_id\s*=/i.test(trimmed)) {
      const userId = params[0] as string;
      let count = 0;
      for (const sess of this.userSessions.values()) {
        if (sess.userId === userId && sess.status === 'ACTIVE') {
          sess.status = 'REVOKED';
          sess.lastActiveAt = new Date();
          count++;
        }
      }
      return { rows: [], rowCount: count };
    }

    if (/UPDATE\s+api_keys\s+SET\s+status\s*=\s*'REVOKED'/i.test(trimmed) && params.length === 1) {
      const userId = params[0] as string;
      let count = 0;
      for (const key of this.apiKeys.values()) {
        if ((key.user_id === userId || key.userId === userId) && key.status === 'ACTIVE') {
          key.status = 'REVOKED';
          key.updated_at = new Date();
          key.updatedAt = new Date();
          count++;
        }
      }
      return { rows: [], rowCount: count };
    }

    // 7s. Count active user sessions / active api keys
    if (/SELECT\s+COUNT\(\*\)\s+AS\s+count\s+FROM\s+user_sessions\s+WHERE\s+user_id\s*=\s*\$1/i.test(trimmed)) {
      const userId = params[0] as string;
      const count = Array.from(this.userSessions.values()).filter(s => s.userId === userId && s.status === 'ACTIVE').length;
      return { rows: [{ count: String(count) }] as T[], rowCount: 1 };
    }

    if (/SELECT\s+COUNT\(\*\)\s+AS\s+count\s+FROM\s+api_keys\s+WHERE\s+user_id\s*=\s*\$1/i.test(trimmed)) {
      const userId = params[0] as string;
      const count = Array.from(this.apiKeys.values()).filter(k => (k.user_id === userId || k.userId === userId) && k.status === 'ACTIVE').length;
      return { rows: [{ count: String(count) }] as T[], rowCount: 1 };
    }

    // 7t. system_circuit_breakers queries
    if (/FROM\s+system_circuit_breakers/i.test(trimmed)) {
      if (!this.systemCircuitBreaker) {
        this.systemCircuitBreaker = {
          id: 'SYSTEM_GLOBAL',
          mode: 'SYSTEM_ACTIVE',
          is_spot_trading_enabled: true,
          isSpotTradingEnabled: true,
          is_futures_trading_enabled: true,
          isFuturesTradingEnabled: true,
          is_withdrawals_enabled: true,
          isWithdrawalsEnabled: true,
          is_deposits_enabled: true,
          isDepositsEnabled: true,
          halt_reason: null,
          haltReason: null,
          halted_by: null,
          haltedBy: null,
          updated_at: new Date(),
          updatedAt: new Date(),
        };
      }
      return { rows: [this.systemCircuitBreaker as T], rowCount: 1 };
    }

    if (/INSERT\s+INTO\s+system_circuit_breakers/i.test(trimmed)) {
      const mode = params[0] as string;
      const isSpot = Boolean(params[1]);
      const isFutures = Boolean(params[2]);
      const isWithdrawals = Boolean(params[3]);
      const isDeposits = Boolean(params[4]);
      const haltReason = (params[5] as string) || null;
      const haltedBy = (params[6] as string) || null;

      this.systemCircuitBreaker = {
        id: 'SYSTEM_GLOBAL',
        mode,
        is_spot_trading_enabled: isSpot,
        isSpotTradingEnabled: isSpot,
        is_futures_trading_enabled: isFutures,
        isFuturesTradingEnabled: isFutures,
        is_withdrawals_enabled: isWithdrawals,
        isWithdrawalsEnabled: isWithdrawals,
        is_deposits_enabled: isDeposits,
        isDepositsEnabled: isDeposits,
        halt_reason: haltReason,
        haltReason,
        halted_by: haltedBy,
        haltedBy,
        updated_at: new Date(),
        updatedAt: new Date(),
      };
      return { rows: [this.systemCircuitBreaker as T], rowCount: 1 };
    }

    // 7u. security_threat_alerts queries
    if (/INSERT\s+INTO\s+security_threat_alerts/i.test(trimmed)) {
      const id = (params[0] as string) || crypto.randomUUID();
      const severity = params[1] as string;
      const category = params[2] as string;
      const title = params[3] as string;
      const description = params[4] as string;
      const metadata = typeof params[5] === 'string' ? JSON.parse(params[5]) : params[5] || {};

      const alert = {
        id,
        severity,
        category,
        title,
        description,
        metadata,
        status: 'ACTIVE',
        resolved_by: null,
        resolvedBy: null,
        resolved_at: null,
        resolvedAt: null,
        resolution_notes: null,
        resolutionNotes: null,
        created_at: new Date(),
        createdAt: new Date(),
      };
      this.securityThreatAlerts.set(id, alert);
      return { rows: [alert as T], rowCount: 1 };
    }

    if (/UPDATE\s+security_threat_alerts/i.test(trimmed)) {
      const status = params[0] as string;
      const resolvedBy = params[1] as string;
      const resolutionNotes = params[2] as string;
      const id = params[3] as string;

      const alert = this.securityThreatAlerts.get(id);
      if (alert) {
        alert.status = status;
        alert.resolved_by = resolvedBy;
        alert.resolvedBy = resolvedBy;
        alert.resolved_at = new Date();
        alert.resolvedAt = new Date();
        alert.resolution_notes = resolutionNotes;
        alert.resolutionNotes = resolutionNotes;
        return { rows: [alert as T], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (/FROM\s+security_threat_alerts\s+WHERE\s+id\s*=\s*\$1/i.test(trimmed)) {
      const id = params[0] as string;
      const alert = this.securityThreatAlerts.get(id);
      return { rows: alert ? ([alert as T]) : [], rowCount: alert ? 1 : 0 };
    }

    if (/SELECT\s+COUNT\(\*\)\s+AS\s+count\s+FROM\s+security_threat_alerts/i.test(trimmed)) {
      let alerts = Array.from(this.securityThreatAlerts.values());
      if (params[0]) {
        alerts = alerts.filter(a => a.status === params[0] || a.severity === params[0] || a.category === params[0]);
      }
      return { rows: [{ count: String(alerts.length) }] as T[], rowCount: 1 };
    }

    if (/FROM\s+security_threat_alerts/i.test(trimmed)) {
      let alerts = Array.from(this.securityThreatAlerts.values()).sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
      if (params.length > 0 && typeof params[0] === 'string' && ['ACTIVE', 'RESOLVED', 'IGNORED'].includes(params[0])) {
        alerts = alerts.filter(a => a.status === params[0]);
      }
      return { rows: alerts as T[], rowCount: alerts.length };
    }

    // 7v. reconciliation_reports queries
    if (/INSERT\s+INTO\s+reconciliation_reports/i.test(trimmed)) {
      const id = (params[0] as string) || crypto.randomUUID();
      const status = params[1] as string;
      const accountsChecked = Number(params[2]);
      const discrepanciesCount = Number(params[3]);
      const details = typeof params[4] === 'string' ? JSON.parse(params[4]) : params[4] || [];
      const triggeredBy = (params[5] as string) || 'SYSTEM_WORKER';

      const report = {
        id,
        status,
        accounts_checked: accountsChecked,
        accountsChecked,
        discrepancies_count: discrepanciesCount,
        discrepanciesCount,
        details,
        triggered_by: triggeredBy,
        triggeredBy,
        created_at: new Date(),
        createdAt: new Date(),
      };
      this.reconciliationReports.unshift(report);
      return { rows: [report as T], rowCount: 1 };
    }

    if (/SELECT\s+COUNT\(\*\)\s+AS\s+count\s+FROM\s+reconciliation_reports/i.test(trimmed)) {
      let reports = this.reconciliationReports;
      if (params[0]) {
        reports = reports.filter(r => r.status === params[0]);
      }
      return { rows: [{ count: String(reports.length) }] as T[], rowCount: 1 };
    }

    if (/FROM\s+reconciliation_reports/i.test(trimmed)) {
      let reports = [...this.reconciliationReports];
      if (params.length > 0 && typeof params[0] === 'string' && ['PASSED', 'DISCREPANCY_DETECTED', 'ERROR'].includes(params[0])) {
        reports = reports.filter(r => r.status === params[0]);
      }
      return { rows: reports as T[], rowCount: reports.length };
    }

    // 7w. Reconciliation multi-account aggregation queries
    if (/SELECT\s+account_id\s+AS\s+"accountId",\s+asset,\s+available_balance/i.test(trimmed)) {
      const rows = Array.from(this.walletBalances.values()).map(wb => ({
        accountId: wb.accountId || (wb as any).account_id,
        asset: wb.asset,
        availableBalance: wb.availableBalance || (wb as any).available_balance || '0',
        lockedBalance: wb.lockedBalance || (wb as any).locked_balance || '0',
      }));
      return { rows: rows as T[], rowCount: rows.length };
    }

    if (/SELECT\s+account_id\s+AS\s+"accountId",\s+asset,\s+COALESCE\(SUM\(amount\),\s*0\)\s+AS\s+"totalCredits"\s+FROM\s+ledger_entries\s+WHERE\s+direction\s*=\s*'CREDIT'/i.test(trimmed)) {
      const creditsMap = new Map<string, { accountId: string; asset: string; totalCredits: string }>();
      for (const entry of this.ledgerEntries) {
        const accId = (entry as any).accountId || (entry as any).account_id;
        const dir = (entry as any).direction;
        const ast = (entry as any).asset;
        const amt = (entry as any).amount;
        if (dir === 'CREDIT') {
          const key = `${accId}:${ast}`;
          const current = creditsMap.get(key) || { accountId: accId, asset: ast, totalCredits: '0' };
          current.totalCredits = decimalAdd(current.totalCredits, amt);
          creditsMap.set(key, current);
        }
      }
      const rows = Array.from(creditsMap.values());
      return { rows: rows as T[], rowCount: rows.length };
    }

    if (/SELECT\s+account_id\s+AS\s+"accountId",\s+asset,\s+COALESCE\(SUM\(amount\),\s*0\)\s+AS\s+"totalDebits"\s+FROM\s+ledger_entries\s+WHERE\s+direction\s*=\s*'DEBIT'/i.test(trimmed)) {
      const debitsMap = new Map<string, { accountId: string; asset: string; totalDebits: string }>();
      for (const entry of this.ledgerEntries) {
        const accId = (entry as any).accountId || (entry as any).account_id;
        const dir = (entry as any).direction;
        const ast = (entry as any).asset;
        const amt = (entry as any).amount;
        if (dir === 'DEBIT') {
          const key = `${accId}:${ast}`;
          const current = debitsMap.get(key) || { accountId: accId, asset: ast, totalDebits: '0' };
          current.totalDebits = decimalAdd(current.totalDebits, amt);
          debitsMap.set(key, current);
        }
      }
      const rows = Array.from(debitsMap.values());
      return { rows: rows as T[], rowCount: rows.length };
    }

    if (/SELECT\s+lt\.id\s+AS\s+"transactionId"/i.test(trimmed)) {
      const txMap = new Map<string, { transactionId: string; asset: string; netDelta: string }>();
      const multiLegTxTypes = new Set([
        'INTERNAL_TRANSFER',
        'SPOT_TRADE_SETTLE',
        'SPOT_ORDER_LOCK',
        'SPOT_ORDER_UNLOCK',
        'FUTURES_MARGIN_LOCK',
        'FUTURES_MARGIN_RELEASE',
        'FUTURES_PNL_REALIZED',
        'FUTURES_FUNDING_PAYMENT',
        'FUTURES_LIQUIDATION',
        'TRADING_FEE',
      ]);
      for (const entry of this.ledgerEntries) {
        const txId = (entry as any).transactionId || (entry as any).transaction_id;
        const tx = this.ledgerTransactions.get(txId);
        if (tx && multiLegTxTypes.has(tx.transactionType)) {
          const ast = (entry as any).asset;
          const dir = (entry as any).direction;
          const amt = (entry as any).amount;
          const key = `${txId}:${ast}`;
          const current = txMap.get(key) || { transactionId: txId, asset: ast, netDelta: '0' };
          if (dir === 'CREDIT') {
            current.netDelta = decimalAdd(current.netDelta, amt);
          } else {
            current.netDelta = decimalSubtract(current.netDelta, amt);
          }
          txMap.set(key, current);
        }
      }
      const violations = Array.from(txMap.values()).filter(t => !decimalIsZero(t.netDelta));
      return { rows: violations as T[], rowCount: violations.length };
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

    // 9c. SELECT ... FROM accounts WHERE user_id = $1 (optional AND type = '...')
    if (/FROM\s+accounts.*WHERE\s+user_id\s*=/i.test(trimmed)) {
      const userId = params[0] as string;
      let userAccounts = Array.from(this.accounts.values()).filter(a => a.userId === userId);

      const typeMatch = trimmed.match(/AND\s+type\s*=\s*'([A-Z_]+)'/i);
      if (typeMatch) {
        const expectedType = typeMatch[1].toUpperCase();
        userAccounts = userAccounts.filter(a => a.type === expectedType);
      } else if (params[1] && typeof params[1] === 'string' && /type\s*=\s*\$2/i.test(trimmed)) {
        userAccounts = userAccounts.filter(a => a.type === (params[1] as string).toUpperCase());
      }
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
      if (params.length >= 4) {
        const available = params[0] as string;
        const locked = params[1] as string;
        const accId = params[2] as string;
        const asset = params[3] as string;
        const key = `${accId}:${asset}`;
        let wb = this.walletBalances.get(key);

        if (!wb) {
          wb = {
            id: crypto.randomUUID(),
            accountId: accId,
            asset,
            availableBalance: available,
            lockedBalance: locked,
            updatedAt: new Date(),
          };
          this.walletBalances.set(key, wb);
        } else {
          wb.availableBalance = available;
          wb.lockedBalance = locked;
          wb.updatedAt = new Date();
        }
        // Release lock after update
        this.lockedWallets.delete(key);
        return { rows: [wb as unknown as T], rowCount: 1 };
      }

      // Handle literal / 2-param update: UPDATE wallet_balances SET available_balance = '99999' WHERE account_id = $1 AND asset = 'USDT'
      const litMatch = trimmed.match(/available_balance\s*=\s*'([0-9.]+)'/i);
      const assetMatch = trimmed.match(/asset\s*=\s*'([A-Za-z0-9]+)'/i);
      if (litMatch && params.length >= 1) {
        const available = litMatch[1];
        const accId = params[0] as string;
        const asset = assetMatch ? assetMatch[1] : (params[1] as string);
        const key = `${accId}:${asset}`;
        let wb = this.walletBalances.get(key);
        if (!wb) {
          wb = {
            id: crypto.randomUUID(),
            accountId: accId,
            asset,
            availableBalance: available,
            lockedBalance: '0',
            updatedAt: new Date(),
          };
          this.walletBalances.set(key, wb);
        } else {
          wb.availableBalance = available;
          wb.updatedAt = new Date();
        }
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
      if (params.length === 6) {
        const [txId, accId, asset, direction, amount, balanceAfter] = params as string[];
        const entry: LedgerEntryEntity = {
          id: String(this.ledgerEntries.length + 1),
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

    // 26. SELECT ... FROM trading_pairs WHERE symbol = $1
    if (/FROM\s+trading_pairs.*WHERE\s+symbol\s*=/i.test(trimmed)) {
      const symbol = (params[0] as string)?.toUpperCase();
      const pair = this.tradingPairs.get(symbol);
      return { rows: pair ? [this.mapTradingPair(pair) as T] : [], rowCount: pair ? 1 : 0 };
    }

    // 27. SELECT ... FROM trading_pairs
    if (/FROM\s+trading_pairs/i.test(trimmed)) {
      let list = Array.from(this.tradingPairs.values());
      if (/WHERE\s+is_active\s*=\s*true/i.test(trimmed)) {
        list = list.filter(p => p.isActive);
      }
      return { rows: list.map(p => this.mapTradingPair(p)) as T[], rowCount: list.length };
    }

    // 28. INSERT INTO orders
    if (/INSERT\s+INTO\s+orders/i.test(trimmed)) {
      const id = (params[0] as string) || crypto.randomUUID();
      const clientOrderId = params[1] as string | undefined;
      const accountId = params[2] as string;
      const market = (params[3] as 'SPOT' | 'FUTURES') || 'SPOT';
      const symbol = (params[4] as string).toUpperCase();
      const side = params[5] as 'BUY' | 'SELL';
      const type = (params[6] as any) || 'LIMIT';
      const price = params[7] ? String(params[7]) : undefined;
      const stopPrice = params[8] ? String(params[8]) : undefined;
      const quantity = String(params[9]);
      const filledQuantity = params[10] ? String(params[10]) : '0';
      const remainingQuantity = params[11] ? String(params[11]) : quantity;
      const lockedAmount = params[12] ? String(params[12]) : '0';
      const lockedAsset = (params[13] as string).toUpperCase();
      const status = (params[14] as any) || 'NEW';
      const timeInForce = (params[15] as string) || 'GTC';

      if (clientOrderId) {
        const uniqueKey = `${accountId}:${clientOrderId}`;
        if (this.ordersByClientOrderId.has(uniqueKey)) {
          const err = new Error(`duplicate key value violates unique constraint "orders_account_client_order_id_key"`);
          (err as any).code = '23505';
          throw err;
        }
        this.ordersByClientOrderId.set(uniqueKey, id);
      }

      const order: OrderEntity = {
        id,
        clientOrderId,
        accountId,
        market,
        symbol,
        side,
        type,
        price,
        stopPrice,
        quantity,
        filledQuantity,
        remainingQuantity,
        lockedAmount,
        lockedAsset,
        status,
        timeInForce,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      this.orders.set(id, order);
      return { rows: [this.mapOrder(order) as T], rowCount: 1 };
    }

    // 29. SELECT ... FROM orders WHERE id = $1 AND account_id = $2
    if (/FROM\s+orders.*WHERE\s+id\s*=\s*\$1\s+AND\s+account_id\s*=\s*\$2/i.test(trimmed)) {
      const id = params[0] as string;
      const accountId = params[1] as string;
      const order = this.orders.get(id);
      if (order && order.accountId === accountId) {
        return { rows: [this.mapOrder(order) as T], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // 30. SELECT ... FROM orders WHERE account_id = $1 AND client_order_id = $2
    if (/FROM\s+orders.*WHERE\s+account_id\s*=\s*\$1\s+AND\s+client_order_id\s*=\s*\$2/i.test(trimmed)) {
      const accountId = params[0] as string;
      const clientOrderId = params[1] as string;
      const orderId = this.ordersByClientOrderId.get(`${accountId}:${clientOrderId}`);
      const order = orderId ? this.orders.get(orderId) : undefined;
      return { rows: order ? [this.mapOrder(order) as T] : [], rowCount: order ? 1 : 0 };
    }

    // 31. SELECT ... FROM orders WHERE id = $1
    if (/FROM\s+orders.*WHERE\s+id\s*=\s*\$1/i.test(trimmed)) {
      const id = params[0] as string;
      const order = this.orders.get(id);
      return { rows: order ? [this.mapOrder(order) as T] : [], rowCount: order ? 1 : 0 };
    }

    // 32. SELECT ... FROM orders WHERE status IN ('NEW', 'PARTIALLY_FILLED') (Engine Recovery)
    if (/FROM\s+orders.*WHERE\s+status\s+IN/i.test(trimmed) && !/account_id/i.test(trimmed)) {
      const openOrders = Array.from(this.orders.values())
        .filter(o => o.status === 'NEW' || o.status === 'PARTIALLY_FILLED')
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return { rows: openOrders.map(o => this.mapOrder(o)) as T[], rowCount: openOrders.length };
    }

    // 33. SELECT ... FROM orders WHERE account_id = $1 (Open orders or all orders)
    if (/FROM\s+orders.*WHERE\s+account_id\s*=/i.test(trimmed)) {
      const accountId = params[0] as string;
      let userOrders = Array.from(this.orders.values()).filter(o => o.accountId === accountId);

      if (/market\s*=\s*'FUTURES'/i.test(trimmed)) {
        userOrders = userOrders.filter(o => o.market === 'FUTURES');
      } else if (/market\s*=\s*'SPOT'/i.test(trimmed)) {
        userOrders = userOrders.filter(o => o.market === 'SPOT');
      }

      if (/status\s+IN\s*\('NEW',\s*'PARTIALLY_FILLED'\)/i.test(trimmed)) {
        userOrders = userOrders.filter(o => o.status === 'NEW' || o.status === 'PARTIALLY_FILLED');
      } else if (/status\s*=\s*\$/i.test(trimmed)) {
        const statusVal = params[1] as string;
        userOrders = userOrders.filter(o => o.status === statusVal);
      }

      if (/symbol\s*=\s*\$/i.test(trimmed)) {
        const sym = (params.find(p => typeof p === 'string' && p !== accountId && typeof p === 'string' && p.length >= 3) as string)?.toUpperCase();
        if (sym) {
          userOrders = userOrders.filter(o => o.symbol === sym);
        }
      }

      userOrders.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      // Pagination
      const limitIdx = params.findIndex(p => typeof p === 'number');
      if (limitIdx !== -1 && params[limitIdx + 1] !== undefined) {
        const limit = params[limitIdx] as number;
        const offset = params[limitIdx + 1] as number;
        userOrders = userOrders.slice(offset, offset + limit);
      }

      return { rows: userOrders.map(o => this.mapOrder(o)) as T[], rowCount: userOrders.length };
    }


    // 34. UPDATE orders SET ... WHERE id = ...
    if (/UPDATE\s+orders\s+SET/i.test(trimmed)) {
      if (/status\s*=\s*\$1\s*,\s*filled_quantity\s*=\s*\$2\s*,\s*remaining_quantity\s*=\s*\$3/i.test(trimmed)) {
        const status = params[0] as any;
        const filledQty = String(params[1]);
        const remQty = String(params[2]);
        const id = params[3] as string;
        const order = this.orders.get(id);
        if (order) {
          order.status = status;
          order.filledQuantity = filledQty;
          order.remainingQuantity = remQty;
          order.updatedAt = new Date();
          return { rows: [this.mapOrder(order) as T], rowCount: 1 };
        }
      } else if (/filled_quantity\s*=\s*\$1\s*,\s*remaining_quantity\s*=\s*\$2\s*,\s*status\s*=\s*\$3/i.test(trimmed)) {
        const filledQty = String(params[0]);
        const remQty = String(params[1]);
        const status = params[2] as any;
        const id = params[3] as string;
        const order = this.orders.get(id);
        if (order) {
          order.filledQuantity = filledQty;
          order.remainingQuantity = remQty;
          order.status = status;
          order.updatedAt = new Date();
          return { rows: [this.mapOrder(order) as T], rowCount: 1 };
        }
      } else if (/status\s*=\s*\$1/i.test(trimmed)) {
        const status = params[0] as any;
        const id = params[1] as string;
        const order = this.orders.get(id);
        if (order) {
          order.status = status;
          order.updatedAt = new Date();
          return { rows: [this.mapOrder(order) as T], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    }


    // 35. INSERT INTO trades
    if (/INSERT\s+INTO\s+trades/i.test(trimmed)) {
      const id = (params[0] as string) || crypto.randomUUID();
      const orderId = params[1] as string;
      const accountId = params[2] as string;
      const market = (params[3] as 'SPOT' | 'FUTURES') || 'SPOT';
      const symbol = (params[4] as string).toUpperCase();
      const side = params[5] as 'BUY' | 'SELL';
      const price = String(params[6]);
      const quantity = String(params[7]);
      const quoteQuantity = String(params[8]);
      const fee = params[9] ? String(params[9]) : '0';
      const feeAsset = (params[10] as string).toUpperCase();
      const isMaker = Boolean(params[11]);
      const counterpartyOrderId = params[12] as string | undefined;

      const trade: TradeEntity = {
        id,
        orderId,
        accountId,
        market,
        symbol,
        side,
        price,
        quantity,
        quoteQuantity,
        fee,
        feeAsset,
        isMaker,
        counterpartyOrderId,
        createdAt: new Date(),
      };

      this.trades.push(trade);
      return { rows: [this.mapTrade(trade) as T], rowCount: 1 };
    }

    // 36. SELECT ... FROM trades WHERE account_id = $1
    if (/FROM\s+trades.*WHERE\s+account_id\s*=/i.test(trimmed)) {
      const accountId = params[0] as string;
      let userTrades = this.trades.filter(t => t.accountId === accountId);

      if (/symbol\s*=\s*\$/i.test(trimmed) && params[1]) {
        const sym = (params[1] as string).toUpperCase();
        userTrades = userTrades.filter(t => t.symbol === sym);
      }

      userTrades.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      // Pagination
      const limitIdx = params.findIndex(p => typeof p === 'number');
      if (limitIdx !== -1 && params[limitIdx + 1] !== undefined) {
        const limit = params[limitIdx] as number;
        const offset = params[limitIdx + 1] as number;
        userTrades = userTrades.slice(offset, offset + limit);
      }

      return { rows: userTrades.map(t => this.mapTrade(t)) as T[], rowCount: userTrades.length };
    }

    // 37. SELECT ... FROM trades WHERE order_id = $1
    if (/FROM\s+trades.*WHERE\s+order_id\s*=/i.test(trimmed)) {
      const orderId = params[0] as string;
      const orderTrades = this.trades.filter(t => t.orderId === orderId);
      return { rows: orderTrades.map(t => this.mapTrade(t)) as T[], rowCount: orderTrades.length };
    }

    // 38. SELECT ... FROM trades WHERE symbol = $1
    if (/FROM\s+trades.*WHERE\s+symbol\s*=/i.test(trimmed)) {
      const symbol = (params[0] as string).toUpperCase();
      let pairTrades = this.trades.filter(t => t.symbol === symbol);
      pairTrades.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      if (typeof params[1] === 'number') {
        pairTrades = pairTrades.slice(0, params[1]);
      }
      return { rows: pairTrades.map(t => this.mapTrade(t)) as T[], rowCount: pairTrades.length };
    }

    // 39. INSERT INTO futures_positions
    if (/^INSERT\s+INTO\s+futures_positions/i.test(trimmed)) {
      const [
        id,
        accountId,
        symbol,
        side,
        quantity,
        entryPrice,
        markPrice,
        liquidationPrice,
        leverage,
        marginMode,
        initialMargin,
        maintenanceMargin,
        realizedPnl,
        status,
        createdAt,
        updatedAt,
      ] = params as [
        string,
        string,
        string,
        any,
        string,
        string,
        string,
        string,
        number,
        any,
        string,
        string,
        string,
        any,
        Date,
        Date
      ];

      const position: FuturesPositionEntity = {
        id,
        accountId,
        symbol: symbol.toUpperCase(),
        side,
        quantity,
        entryPrice,
        markPrice,
        liquidationPrice,
        leverage: Number(leverage),
        marginMode,
        initialMargin,
        maintenanceMargin,
        realizedPnl: realizedPnl || '0',
        status: status || 'OPEN',
        createdAt: createdAt instanceof Date ? createdAt : new Date(createdAt),
        updatedAt: updatedAt instanceof Date ? updatedAt : new Date(updatedAt),
      };

      this.futuresPositions.set(position.id, position);
      return { rows: [this.mapFuturesPosition(position) as T], rowCount: 1 };
    }

    // 40. UPDATE futures_positions
    if (/^UPDATE\s+futures_positions/i.test(trimmed)) {
      if (/WHERE\s+id\s*=\s*\$7/i.test(trimmed)) {
        // Increase position: quantity, entry_price, mark_price, liquidation_price, initial_margin, maintenance_margin, id
        const [quantity, entryPrice, markPrice, liquidationPrice, initialMargin, maintenanceMargin, id] = params as [
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ];
        const pos = this.futuresPositions.get(id);
        if (pos) {
          pos.quantity = quantity;
          pos.entryPrice = entryPrice;
          pos.markPrice = markPrice;
          pos.liquidationPrice = liquidationPrice;
          pos.initialMargin = initialMargin;
          pos.maintenanceMargin = maintenanceMargin;
          pos.updatedAt = new Date();
          return { rows: [this.mapFuturesPosition(pos) as T], rowCount: 1 };
        }
      } else if (/WHERE\s+id\s*=\s*\$8/i.test(trimmed)) {
        // Reduce position: quantity, mark_price, initial_margin, maintenance_margin, liquidation_price, realized_pnl, status, id
        const [quantity, markPrice, initialMargin, maintenanceMargin, liquidationPrice, realizedPnl, status, id] = params as [
          string,
          string,
          string,
          string,
          string,
          string,
          any,
          string
        ];
        const pos = this.futuresPositions.get(id);
        if (pos) {
          pos.quantity = quantity;
          pos.markPrice = markPrice;
          pos.initialMargin = initialMargin;
          pos.maintenanceMargin = maintenanceMargin;
          pos.liquidationPrice = liquidationPrice;
          pos.realizedPnl = realizedPnl;
          pos.status = status;
          pos.updatedAt = new Date();
          return { rows: [this.mapFuturesPosition(pos) as T], rowCount: 1 };
        }
      } else if (/WHERE\s+id\s*=\s*\$3/i.test(trimmed)) {
        // Liquidate position: mark_price, realized_pnl, id
        const [markPrice, realizedPnl, id] = params as [string, string, string];
        const pos = this.futuresPositions.get(id);
        if (pos) {
          pos.status = 'LIQUIDATED';
          pos.markPrice = markPrice;
          pos.realizedPnl = realizedPnl;
          pos.initialMargin = '0';
          pos.maintenanceMargin = '0';
          pos.updatedAt = new Date();
          return { rows: [this.mapFuturesPosition(pos) as T], rowCount: 1 };
        }
      }
      return { rows: [] as T[], rowCount: 0 };
    }

    // 41. SELECT ... FROM futures_positions WHERE account_id = $1 AND symbol = $2 AND side = $3 AND status = 'OPEN'
    if (/FROM\s+futures_positions.*WHERE\s+account_id\s*=\s*\$1\s+AND\s+symbol\s*=\s*\$2\s+AND\s+side\s*=\s*\$3/i.test(trimmed)) {
      const accountId = params[0] as string;
      const symbol = (params[1] as string).toUpperCase();
      const side = params[2] as string;

      const pos = Array.from(this.futuresPositions.values()).find(
        p => p.accountId === accountId && p.symbol === symbol && p.side === side && p.status === 'OPEN'
      );
      if (!pos) return { rows: [] as T[], rowCount: 0 };
      return { rows: [this.mapFuturesPosition(pos) as T], rowCount: 1 };
    }

    // 42. SELECT ... FROM futures_positions WHERE account_id = $1 AND status = 'OPEN'
    if (/FROM\s+futures_positions.*WHERE\s+account_id\s*=\s*\$1\s+AND\s+status\s*=\s*'OPEN'/i.test(trimmed)) {
      const accountId = params[0] as string;
      const positions = Array.from(this.futuresPositions.values()).filter(
        p => p.accountId === accountId && p.status === 'OPEN'
      );
      return { rows: positions.map(p => this.mapFuturesPosition(p)) as T[], rowCount: positions.length };
    }

    // 43. SELECT ... FROM futures_positions WHERE id = $1
    if (/FROM\s+futures_positions.*WHERE\s+id\s*=\s*\$1/i.test(trimmed)) {
      const id = params[0] as string;
      const pos = this.futuresPositions.get(id);
      if (!pos) return { rows: [] as T[], rowCount: 0 };
      return { rows: [this.mapFuturesPosition(pos) as T], rowCount: 1 };
    }

    // 44. SELECT ... FROM futures_positions WHERE status = 'OPEN'
    if (/FROM\s+futures_positions.*WHERE\s+status\s*=\s*'OPEN'/i.test(trimmed)) {
      const positions = Array.from(this.futuresPositions.values()).filter(p => p.status === 'OPEN');
      return { rows: positions.map(p => this.mapFuturesPosition(p)) as T[], rowCount: positions.length };
    }

    // 45. INSERT INTO futures_orders
    if (/^INSERT\s+INTO\s+futures_orders/i.test(trimmed)) {
      const [
        id,
        orderId,
        accountId,
        symbol,
        positionSide,
        leverage,
        marginMode,
        reduceOnly,
        closePosition,
        createdAt,
      ] = params as [string, string, string, string, any, number, any, boolean, boolean, Date];

      const fo: FuturesOrderEntity = {
        id,
        orderId,
        accountId,
        symbol: symbol.toUpperCase(),
        positionSide,
        leverage: Number(leverage),
        marginMode,
        reduceOnly: Boolean(reduceOnly),
        closePosition: Boolean(closePosition),
        createdAt: createdAt instanceof Date ? createdAt : new Date(createdAt),
      };

      this.futuresOrders.set(fo.id, fo);
      return { rows: [this.mapFuturesOrder(fo) as T], rowCount: 1 };
    }

    // 46. SELECT ... FROM futures_orders WHERE order_id = $1
    if (/FROM\s+futures_orders.*WHERE\s+order_id\s*=\s*\$1/i.test(trimmed)) {
      const orderId = params[0] as string;
      const fo = Array.from(this.futuresOrders.values()).find(f => f.orderId === orderId);
      if (!fo) return { rows: [] as T[], rowCount: 0 };
      return { rows: [this.mapFuturesOrder(fo) as T], rowCount: 1 };
    }

    // 47. INSERT INTO futures_tpsl_configs
    if (/^INSERT\s+INTO\s+futures_tpsl_configs/i.test(trimmed)) {
      const [
        id,
        positionId,
        accountId,
        symbol,
        positionSide,
        takeProfitEnabled,
        takeProfitPrice,
        stopLossEnabled,
        stopLossPrice,
        createdAt,
        updatedAt,
      ] = params as [string, string, string, string, any, boolean, string | undefined, boolean, string | undefined, Date, Date];

      const cfg: FuturesTpSlConfigEntity = {
        id,
        positionId,
        accountId,
        symbol: symbol.toUpperCase(),
        positionSide,
        takeProfitEnabled: Boolean(takeProfitEnabled),
        takeProfitPrice,
        stopLossEnabled: Boolean(stopLossEnabled),
        stopLossPrice,
        createdAt: createdAt instanceof Date ? createdAt : new Date(createdAt),
        updatedAt: updatedAt instanceof Date ? updatedAt : new Date(updatedAt),
      };

      this.futuresTpSlConfigs.set(cfg.id, cfg);
      return { rows: [this.mapFuturesTpSl(cfg) as T], rowCount: 1 };
    }

    // 48. UPDATE futures_tpsl_configs
    if (/^UPDATE\s+futures_tpsl_configs/i.test(trimmed)) {
      const [takeProfitEnabled, takeProfitPrice, stopLossEnabled, stopLossPrice, id] = params as [
        boolean,
        string | undefined,
        boolean,
        string | undefined,
        string
      ];
      const cfg = this.futuresTpSlConfigs.get(id);
      if (cfg) {
        cfg.takeProfitEnabled = Boolean(takeProfitEnabled);
        cfg.takeProfitPrice = takeProfitPrice;
        cfg.stopLossEnabled = Boolean(stopLossEnabled);
        cfg.stopLossPrice = stopLossPrice;
        cfg.updatedAt = new Date();
        return { rows: [this.mapFuturesTpSl(cfg) as T], rowCount: 1 };
      }
      return { rows: [] as T[], rowCount: 0 };
    }

    // 49. SELECT ... FROM futures_tpsl_configs WHERE position_id = $1
    if (/FROM\s+futures_tpsl_configs.*WHERE\s+position_id\s*=\s*\$1/i.test(trimmed)) {
      const positionId = params[0] as string;
      const cfg = Array.from(this.futuresTpSlConfigs.values()).find(c => c.positionId === positionId);
      if (!cfg) return { rows: [] as T[], rowCount: 0 };
      return { rows: [this.mapFuturesTpSl(cfg) as T], rowCount: 1 };
    }

    // 50. INSERT INTO futures_liquidations
    if (/^INSERT\s+INTO\s+futures_liquidations/i.test(trimmed)) {
      const [
        id,
        positionId,
        accountId,
        symbol,
        side,
        quantity,
        bankruptcyPrice,
        liquidationPrice,
        lossAmount,
        insuranceFundDelta,
        createdAt,
      ] = params as [string, string, string, string, any, string, string, string, string, string, Date];

      const liq: FuturesLiquidationEntity = {
        id,
        positionId,
        accountId,
        symbol: symbol.toUpperCase(),
        side,
        quantity,
        bankruptcyPrice,
        liquidationPrice,
        lossAmount,
        insuranceFundDelta: insuranceFundDelta || '0',
        createdAt: createdAt instanceof Date ? createdAt : new Date(createdAt),
      };

      this.futuresLiquidations.push(liq);
      return { rows: [this.mapFuturesLiquidation(liq) as T], rowCount: 1 };
    }

    // 51. SELECT ... FROM futures_liquidations WHERE account_id = $1
    if (/FROM\s+futures_liquidations.*WHERE\s+account_id\s*=\s*\$1/i.test(trimmed)) {
      const accountId = params[0] as string;
      const liqs = this.futuresLiquidations.filter(l => l.accountId === accountId);
      liqs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return { rows: liqs.map(l => this.mapFuturesLiquidation(l)) as T[], rowCount: liqs.length };
    }

    // 52. INSERT INTO futures_funding_history
    if (/^INSERT\s+INTO\s+futures_funding_history/i.test(trimmed)) {
      const [id, symbol, fundingRate, markPrice, indexPrice, settledAt] = params as [
        string,
        string,
        string,
        string,
        string | undefined,
        Date
      ];

      const fh: FuturesFundingHistoryEntity = {
        id,
        symbol: symbol.toUpperCase(),
        fundingRate,
        markPrice,
        indexPrice,
        settledAt: settledAt instanceof Date ? settledAt : new Date(settledAt),
      };

      this.futuresFundingHistory.push(fh);
      return { rows: [fh as T], rowCount: 1 };
    }

    // 53. SELECT ... FROM futures_funding_history
    if (/FROM\s+futures_funding_history/i.test(trimmed)) {
      return { rows: [...this.futuresFundingHistory] as T[], rowCount: this.futuresFundingHistory.length };
    }

    if (/^INSERT\s+INTO\s+k_lines/i.test(trimmed)) {
      const [market, symbol, interval, open_time, close_time, open_price, high_price, low_price, close_price, base_volume, quote_volume, trades_count, is_final] = params;
      this.kLines.push({
        market, symbol, interval, open_time, close_time, open_price, high_price, low_price, close_price, base_volume, quote_volume, trades_count, is_final
      });
      return { rows: [], rowCount: 1 };
    }

    if (/^UPDATE\s+k_lines[\s\S]*SET\s+high_price/i.test(trimmed)) {
      const [high_price, low_price, close_price, base_volume, quote_volume, trades_count, market, symbol, interval, open_time] = params;
      const kline = this.kLines.find(k => k.market === market && k.symbol === symbol && k.interval === interval && k.open_time === open_time);
      if (kline) {
        Object.assign(kline, { high_price, low_price, close_price, base_volume, quote_volume, trades_count });
      }
      return { rows: [], rowCount: 1 };
    }

    if (/^UPDATE\s+k_lines[\s\S]*SET\s+is_final/i.test(trimmed)) {
      const [market, symbol, interval, open_time] = params;
      const kline = this.kLines.find(k => k.market === market && k.symbol === symbol && k.interval === interval && k.open_time === open_time);
      if (kline) {
        kline.is_final = true;
      }
      return { rows: [], rowCount: 1 };
    }

    if (/^SELECT\s+\*\s+FROM\s+k_lines[\s\S]*WHERE[\s\S]*is_final\s*=\s*false/i.test(trimmed)) {
      const active = this.kLines.filter(k => !k.is_final);
      return { rows: active as T[], rowCount: active.length };
    }

    if (/^SELECT\s+\*\s+FROM\s+k_lines[\s\S]*ORDER\s+BY\s+open_time/i.test(trimmed)) {
      const [market, symbol, interval, end_time, limit] = params;
      let matched = this.kLines.filter(k => k.market === market && k.symbol === symbol && k.interval === interval && Number(k.open_time) <= Number(end_time));
      matched.sort((a, b) => Number(b.open_time) - Number(a.open_time));
      matched = matched.slice(0, Number(limit));
      return { rows: matched as T[], rowCount: matched.length };
    }

    if (/^SELECT\s+is_final\s+FROM\s+k_lines/i.test(trimmed)) {
      const [market, symbol, interval, open_time] = params;
      const kline = this.kLines.find(k => k.market === market && k.symbol === symbol && k.interval === interval && k.open_time === open_time);
      if (kline) return { rows: [{ is_final: kline.is_final }] as T[], rowCount: 1 };
      return { rows: [] as T[], rowCount: 0 };
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
      waitingClients: 0,
      error: this.connectionError || undefined,
      config: {
        min: this.config.DB_POOL_MIN,
        max: this.config.DB_POOL_MAX,
        idleTimeoutMillis: this.config.DB_IDLE_TIMEOUT_MS,
        connectionTimeoutMillis: this.config.DB_CONNECTION_TIMEOUT_MS,
        queryTimeoutMillis: this.config.DB_QUERY_TIMEOUT_MS,
      },
    };
  }
}

export { InMemoryDatabasePool as DatabasePool };

export const db: IDatabaseConnection =
  process.env.NODE_ENV === 'test' && process.env.USE_REAL_PG !== 'true'
    ? new InMemoryDatabasePool()
    : new PostgresDatabasePool();

