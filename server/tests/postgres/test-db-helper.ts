import crypto from 'crypto';
import { db, PostgresDatabasePool } from '../../src/config/database';
import { SchemaMigrator } from '../../src/config/migrator';
import { ledgerService } from '../../src/services/ledger/ledger.service';

export class TestDbHelper {
  private pool: PostgresDatabasePool;

  constructor() {
    this.pool = (db instanceof PostgresDatabasePool) ? db : new PostgresDatabasePool();
  }

  public async init(): Promise<void> {
    await db.connect();
    await this.pool.connect();
    const migrator = new SchemaMigrator(undefined, this.pool);
    await migrator.runMigrations();
  }

  public async close(): Promise<void> {
    if (this.pool !== db) {
      await this.pool.close();
    }
    await db.close();
  }

  public async query<T = unknown>(sql: string, params: unknown[] = []): Promise<any> {
    return this.pool.query<T>(sql, params);
  }

  public async cleanup(): Promise<void> {
    // Clear test data in correct FK order
    await this.pool.query('DELETE FROM futures_adl_events');
    await this.pool.query('DELETE FROM futures_liquidations');
    await this.pool.query('DELETE FROM futures_tpsl_configs');
    await this.pool.query('DELETE FROM futures_funding_history');
    await this.pool.query('DELETE FROM futures_orders');
    await this.pool.query('DELETE FROM trades');
    await this.pool.query('DELETE FROM orders');
    await this.pool.query('DELETE FROM futures_positions');
    await this.pool.query('DELETE FROM ledger_entries');
    await this.pool.query('DELETE FROM ledger_transactions');
    await this.pool.query('DELETE FROM wallet_balances WHERE account_id NOT IN (\'11111111-1111-1111-1111-111111111111\', \'22222222-2222-2222-2222-222222222222\')');
    await this.pool.query('DELETE FROM accounts WHERE user_id != \'00000000-0000-0000-0000-000000000000\'');
    await this.pool.query('DELETE FROM users WHERE id != \'00000000-0000-0000-0000-000000000000\'');
  }

  public async createUser(email: string): Promise<{ id: string; email: string; futuresId: string; spotId: string }> {
    const userId = crypto.randomUUID();
    await this.pool.query(
      'INSERT INTO users (id, email, role, account_status) VALUES ($1, $2, $3, $4)',
      [userId, email, 'USER', 'ACTIVE']
    );

    const futuresRes = await this.pool.query<any>(
      `INSERT INTO accounts (user_id, type) VALUES ($1, 'FUTURES') RETURNING id`,
      [userId]
    );
    const spotRes = await this.pool.query<any>(
      `INSERT INTO accounts (user_id, type) VALUES ($1, 'SPOT') RETURNING id`,
      [userId]
    );

    return {
      id: userId,
      email,
      futuresId: futuresRes.rows[0].id,
      spotId: spotRes.rows[0].id,
    };
  }

  public async createAsset(symbol: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO assets (symbol, name, decimals, is_active, is_fiat)
       VALUES ($1, $1, 8, true, false)
       ON CONFLICT (symbol) DO NOTHING`,
      [symbol]
    );
  }

  public async createTradingPair(symbol: string, market: 'SPOT' | 'FUTURES'): Promise<void> {
    await this.pool.query(
      `INSERT INTO trading_pairs (symbol, base_asset, quote_asset, market_type, tick_size, lot_size, min_notional, maker_fee_rate, taker_fee_rate, is_active)
       VALUES ($1, 'BTC', 'USDT', $2, '0.01', '0.0001', '5.0', '0.0002', '0.0005', true)
       ON CONFLICT (symbol) DO NOTHING`,
      [symbol, market]
    );
  }

  public async deposit(accountId: string, asset: string, amount: string): Promise<void> {
    const targetAsset = asset === 'USDT' ? 'FUTURES_USDT' : asset;
    // ensure asset exists
    await this.createAsset(targetAsset);

    await this.pool.query(
      `INSERT INTO wallet_balances (account_id, asset, available_balance, locked_balance)
       VALUES ($1, $2, $3, 0)
       ON CONFLICT (account_id, asset) DO UPDATE SET available_balance = wallet_balances.available_balance + EXCLUDED.available_balance`,
      [accountId, targetAsset, amount]
    );
  }
}

export const testDbHelper = new TestDbHelper();
