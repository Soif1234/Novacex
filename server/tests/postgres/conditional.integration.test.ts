import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgresDatabasePool } from '../../src/config/database';
import { SchemaMigrator } from '../../src/config/migrator';
import { eventBus } from '../../src/services/market/event-bus';
import { ConditionalTriggerService } from '../../src/services/market/conditional.service';
import { FuturesService } from '../../src/services/futures/futures.service';
import { FuturesPositionService } from '../../src/services/futures/position.service';
import { FuturesRiskService } from '../../src/services/futures/risk.service';
import { FuturesFeeService } from '../../src/services/futures/fee.service';
import { LedgerService } from '../../src/services/ledger/ledger.service';
import { DevelopmentMarkPriceProvider } from '../../src/services/futures/mark-price.provider';
import { decimalCompare } from '../../src/services/ledger/decimal';
import crypto from 'crypto';

describe('Phase 6.1: Conditional Orders Integration', () => {
  let db: PostgresDatabasePool;
  let ledgerService: LedgerService;
  let riskService: FuturesRiskService;
  let feeService: FuturesFeeService;
  let markPrices: DevelopmentMarkPriceProvider;
  let positionService: FuturesPositionService;
  let futuresService: FuturesService;
  let conditionalTriggerService: ConditionalTriggerService;
  let userA: { id: string; email: string; futuresId: string; spotId: string };

  beforeAll(async () => {
    db = new PostgresDatabasePool();
    await db.connect();
    const migrator = new SchemaMigrator(undefined, db);
    await migrator.runMigrations();

    ledgerService = new LedgerService(db);
    riskService = new FuturesRiskService();
    feeService = new FuturesFeeService();
    markPrices = new DevelopmentMarkPriceProvider();
    positionService = new FuturesPositionService(db, riskService);
    futuresService = new FuturesService(
      db,
      ledgerService,
      riskService,
      positionService,
      feeService,
      markPrices
    );
    conditionalTriggerService = new ConditionalTriggerService(db, futuresService);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    const userId = crypto.randomUUID();
    const email = `cond_user_${userId.slice(0, 8)}@example.com`;
    await db.query(
      'INSERT INTO users (id, email, role, account_status) VALUES ($1, $2, $3, $4)',
      [userId, email, 'USER', 'ACTIVE']
    );

    const futuresRes = await db.query<any>(
      `INSERT INTO accounts (user_id, type) VALUES ($1, 'FUTURES') RETURNING id`,
      [userId]
    );
    const spotRes = await db.query<any>(
      `INSERT INTO accounts (user_id, type) VALUES ($1, 'SPOT') RETURNING id`,
      [userId]
    );

    userA = {
      id: userId,
      email,
      futuresId: futuresRes.rows[0].id,
      spotId: spotRes.rows[0].id,
    };

    // Ensure assets exist
    await db.query(`INSERT INTO assets (symbol, name, decimals, is_active, is_fiat) VALUES ('FUTURES_USDT', 'Futures USDT', 8, true, false) ON CONFLICT DO NOTHING`);
    await db.query(`INSERT INTO assets (symbol, name, decimals, is_active, is_fiat) VALUES ('USDT', 'USDT', 8, true, false) ON CONFLICT DO NOTHING`);
    await db.query(`INSERT INTO assets (symbol, name, decimals, is_active, is_fiat) VALUES ('BTC', 'BTC', 8, true, false) ON CONFLICT DO NOTHING`);

    // Ensure trading pair exists
    await db.query(`INSERT INTO trading_pairs (symbol, base_asset, quote_asset, market_type, tick_size, lot_size, min_notional, maker_fee_rate, taker_fee_rate, is_active)
      VALUES ('BTCUSDT', 'BTC', 'USDT', 'FUTURES', '0.01', '0.0001', '5.0', '0.0002', '0.0005', true)
      ON CONFLICT (symbol) DO NOTHING`);

    // Fund accounts
    await ledgerService.credit(userA.futuresId, 'FUTURES_USDT', '100000', 'DEPOSIT' as any, `DEP-FUT-${userA.futuresId}`, 'Initial deposit');
    await ledgerService.credit(userA.spotId, 'USDT', '100000', 'DEPOSIT' as any, `DEP-SPOT-${userA.spotId}`, 'Initial deposit');

    markPrices.setMarkPrice('BTCUSDT', '50000');
    (conditionalTriggerService as any).activeTriggers.clear();
  });

  it('1. STOP_LIMIT BUY should trigger when price rises >= stopPrice', async () => {
    const res = await futuresService.placeOrder({
      userId: userA.id,
      accountId: userA.futuresId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'STOP_LIMIT',
      quantity: '1',
      price: '52500',
      stopPrice: '52000',
      leverage: 10,
      marginMode: 'CROSS',
    });

    expect(res.order.status).toBe('UNTRIGGERED');

    (conditionalTriggerService as any).activeTriggers.set('BTCUSDT', [
      {
        id: res.order.id,
        symbol: 'BTCUSDT',
        market: 'FUTURES',
        side: 'BUY',
        type: 'STOP_LIMIT',
        stopPrice: '52000',
      },
    ]);

    const o1 = await db.query<any>('SELECT status FROM orders WHERE id = $1', [res.order.id]);
    expect(o1.rows[0].status).toBe('UNTRIGGERED');

    await eventBus.publish({ type: 'market.trade', payload: { symbol: 'BTCUSDT', price: '52000' } });
    let o2: any;
    for (let i = 0; i < 40; i++) {
      o2 = await db.query<any>('SELECT status FROM orders WHERE id = $1', [res.order.id]);
      if (o2.rows[0]?.status === 'NEW') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(o2.rows[0].status).toBe('NEW');
  });

  it('2. TAKE_PROFIT_LIMIT SELL should trigger when price rises >= stopPrice', async () => {
    const res = await futuresService.placeOrder({
      userId: userA.id,
      accountId: userA.futuresId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      positionSide: 'SHORT',
      type: 'TAKE_PROFIT_LIMIT',
      quantity: '1',
      price: '48000',
      stopPrice: '55000',
      leverage: 10,
      marginMode: 'CROSS',
    });

    expect(res.order.status).toBe('UNTRIGGERED');

    (conditionalTriggerService as any).activeTriggers.set('BTCUSDT', [
      {
        id: res.order.id,
        symbol: 'BTCUSDT',
        market: 'FUTURES',
        side: 'SELL',
        type: 'TAKE_PROFIT_LIMIT',
        stopPrice: '55000',
      },
    ]);

    const o1 = await db.query<any>('SELECT status FROM orders WHERE id = $1', [res.order.id]);
    expect(o1.rows[0].status).toBe('UNTRIGGERED');

    await eventBus.publish({ type: 'market.trade', payload: { symbol: 'BTCUSDT', price: '56000' } });
    let o2: any;
    for (let i = 0; i < 40; i++) {
      o2 = await db.query<any>('SELECT status FROM orders WHERE id = $1', [res.order.id]);
      if (o2.rows[0]?.status === 'NEW') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(o2.rows[0].status).toBe('NEW');
  });

  it('3. Should reconstruct triggers from database on startup', async () => {
    const orderId = crypto.randomUUID();
    await db.query(
      `INSERT INTO orders (id, account_id, market, symbol, side, type, status, price, quantity, remaining_quantity, locked_asset, locked_amount, stop_price, created_at, updated_at)
       VALUES ($1, $2, 'FUTURES', 'BTCUSDT', 'SELL', 'STOP_LIMIT', 'UNTRIGGERED', 48000, 1, 1, 'FUTURES_USDT', 0, 45000, NOW(), NOW())`,
      [orderId, userA.futuresId]
    );

    await conditionalTriggerService.loadFromDatabase();

    const active = (conditionalTriggerService as any).activeTriggers.get('BTCUSDT');
    expect(active.length).toBeGreaterThan(0);
    const loaded = active.find((a: any) => decimalCompare(String(a.stopPrice), '45000') === 0);
    expect(loaded).toBeDefined();
  });

  it('4. Should reject duplicate triggers (idempotency)', async () => {
    const res = await futuresService.placeOrder({
      userId: userA.id,
      accountId: userA.futuresId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      positionSide: 'SHORT',
      type: 'STOP_LIMIT',
      quantity: '1',
      price: '48000',
      stopPrice: '45000',
      leverage: 10,
      marginMode: 'CROSS',
    });

    const first = await futuresService.triggerOrder(res.order.id);
    expect(first).toBe(true);

    const second = await futuresService.triggerOrder(res.order.id);
    expect(second).toBe(false);
  });
});
