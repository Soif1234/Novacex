import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'crypto';
import { PostgresDatabasePool } from '../../src/config/database';
import { LedgerService } from '../../src/services/ledger/ledger.service';
import { AuthService } from '../../src/services/auth/auth.service';
import { WalletService } from '../../src/services/wallet/wallet.service';
import { SpotService } from '../../src/services/spot/spot.service';
import { MatchingEngine } from '../../src/services/spot/matching.engine';
import { SchemaMigrator } from '../../src/config/migrator';

describe('Real PostgreSQL Financial Integration — Spot Engine (server/tests/postgres/spot.integration.test.ts)', () => {
  let db: PostgresDatabasePool;
  let ledgerService: LedgerService;
  let authService: AuthService;
  let walletService: WalletService;
  let spotService: SpotService;

  beforeAll(async () => {
    db = new PostgresDatabasePool();
    await db.connect();
    const migrator = new SchemaMigrator(undefined, db);
    await migrator.runMigrations();

    ledgerService = new LedgerService(db);
    authService = new AuthService(db);
    walletService = new WalletService(db, ledgerService);
  });

  beforeEach(async () => {
    await db.query('TRUNCATE TABLE orders CASCADE');
    await db.query('TRUNCATE TABLE wallet_balances CASCADE');
    // Isolate in-memory order books per test so resting orders do not cross tests
    spotService = new SpotService(db, ledgerService, new MatchingEngine());
  });

  afterAll(async () => {
    await db.close();
  });

  async function createTestTrader(prefix = 'trader'): Promise<{ userId: string; spotAccountId: string }> {
    const email = `${prefix}_${crypto.randomUUID().substring(0, 8)}@test.novacex.io`;
    const reg = await authService.signup({
      email,
      password: 'StrongPassword123!',
      username: `t_${crypto.randomUUID().substring(0, 8)}`,
      displayName: 'Test Trader',
    });

    const spotAcc = reg.user.accounts.find(a => a.type === 'SPOT')!;

    return {
      userId: reg.user.id,
      spotAccountId: spotAcc.id,
    };
  }

  // ── 1. Order Creation & Balance Reservation ──────────────────────────────

  it('1. Spot BUY order reserves quote asset (USDT) in PostgreSQL', async () => {
    const buyer = await createTestTrader('buyer_1');
    await ledgerService.credit(buyer.spotAccountId, 'USDT', '100000.000000000000000000', 'DEPOSIT', `dep_${crypto.randomUUID()}`, 'Deposit');

    // Place BUY 1 BTC @ 50,000 USDT (requires 50,000 USDT lock)
    const result = await spotService.placeOrder({
      userId: buyer.userId,
      accountId: buyer.spotAccountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '50000.000000000000000000',
      quantity: '1.000000000000000000',
    });

    expect(result.order.status).toBe('NEW');
    expect(result.order.lockedAmount).toBe('50000.000000000000000000');
    expect(result.order.lockedAsset).toBe('USDT');

    // Verify in PostgreSQL
    const bal = await ledgerService.getBalance(buyer.spotAccountId, 'USDT');
    expect(bal.availableBalance).toBe('50000.000000000000000000');
    expect(bal.lockedBalance).toBe('50000.000000000000000000');

    const dbOrder = await db.query<any>('SELECT status, locked_amount FROM orders WHERE id = $1', [result.order.id]);
    expect(dbOrder.rows[0].status).toBe('NEW');
  });

  it('2. Spot SELL order reserves base asset (BTC) in PostgreSQL', async () => {
    const seller = await createTestTrader('seller_1');
    await ledgerService.credit(seller.spotAccountId, 'BTC', '5.000000000000000000', 'DEPOSIT', `dep_${crypto.randomUUID()}`, 'Deposit');

    // Place SELL 2 BTC @ 55,000 USDT (requires 2 BTC lock)
    const result = await spotService.placeOrder({
      userId: seller.userId,
      accountId: seller.spotAccountId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'LIMIT',
      price: '55000.000000000000000000',
      quantity: '2.000000000000000000',
    });

    expect(result.order.status).toBe('NEW');
    expect(result.order.lockedAmount).toBe('2.000000000000000000');
    expect(result.order.lockedAsset).toBe('BTC');

    const bal = await ledgerService.getBalance(seller.spotAccountId, 'BTC');
    expect(bal.availableBalance).toBe('3.000000000000000000');
    expect(bal.lockedBalance).toBe('2.000000000000000000');
  });

  // ── 2. Order Cancellation & Release ──────────────────────────────────────

  it('3. Order cancellation releases locked balance back to available balance', async () => {
    const buyer = await createTestTrader('cancel_buyer');
    await ledgerService.credit(buyer.spotAccountId, 'USDT', '10000.000000000000000000', 'DEPOSIT', `dep_${crypto.randomUUID()}`, 'Deposit');

    const result = await spotService.placeOrder({
      userId: buyer.userId,
      accountId: buyer.spotAccountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '40000.000000000000000000',
      quantity: '0.100000000000000000', // 4,000 USDT locked
    });

    const canceled = await spotService.cancelOrder(buyer.userId, result.order.id);
    expect(canceled.status).toBe('CANCELLED');

    const bal = await ledgerService.getBalance(buyer.spotAccountId, 'USDT');
    expect(bal.availableBalance).toBe('10000.000000000000000000');
    expect(bal.lockedBalance).toBe('0.000000000000000000');

    // Direct SQL check
    const dbOrder = await db.query<any>('SELECT status FROM orders WHERE id = $1', [result.order.id]);
    expect(dbOrder.rows[0].status).toBe('CANCELLED');
  });

  // ── 3. Real Matching, Trade Persistence & Ledger Settlement ─────────────

  it('4. Full Fill Matching: BUY + SELL persists trade & settles balance in PostgreSQL', async () => {
    const seller = await createTestTrader('match_seller');
    const buyer = await createTestTrader('match_buyer');

    // Fund seller with 1 BTC
    await ledgerService.credit(seller.spotAccountId, 'BTC', '1.000000000000000000', 'DEPOSIT', `dep_s_${crypto.randomUUID()}`, 'Fund Seller');
    // Fund buyer with 60,000 USDT
    await ledgerService.credit(buyer.spotAccountId, 'USDT', '60000.000000000000000000', 'DEPOSIT', `dep_b_${crypto.randomUUID()}`, 'Fund Buyer');

    // 1. Maker SELL 1 BTC @ 50,000 USDT
    const sellResult = await spotService.placeOrder({
      userId: seller.userId,
      accountId: seller.spotAccountId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'LIMIT',
      price: '50000.000000000000000000',
      quantity: '1.000000000000000000',
    });

    // 2. Taker BUY 1 BTC @ 50,000 USDT
    const buyResult = await spotService.placeOrder({
      userId: buyer.userId,
      accountId: buyer.spotAccountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '50000.000000000000000000',
      quantity: '1.000000000000000000',
    });

    expect(buyResult.order.status).toBe('FILLED');

    // Check PostgreSQL Trades table
    const trades = await db.query<any>('SELECT * FROM trades WHERE order_id = $1 OR order_id = $2', [buyResult.order.id, sellResult.order.id]);
    expect(trades.rows.length).toBe(2); // Buyer trade + Seller trade

    // Check Buyer balances: received 1 BTC, spent 50,000 USDT
    const buyerBtc = await ledgerService.getBalance(buyer.spotAccountId, 'BTC');
    const buyerUsdt = await ledgerService.getBalance(buyer.spotAccountId, 'USDT');
    expect(buyerBtc.availableBalance).toBe('0.999000000000000000');
    expect(buyerUsdt.availableBalance).toBe('10000.000000000000000000');

    // Check Seller balances: received 50,000 USDT, spent 1 BTC
    const sellerUsdt = await ledgerService.getBalance(seller.spotAccountId, 'USDT');
    const sellerBtc = await ledgerService.getBalance(seller.spotAccountId, 'BTC');
    expect(sellerUsdt.availableBalance).toBe('49950.000000000000000000');
    expect(sellerBtc.availableBalance).toBe('0.000000000000000000');
    expect(sellerBtc.lockedBalance).toBe('0.000000000000000000');
  });

  it('5. Partial Fill Matching: partial trade persists and updates remaining quantities in PostgreSQL', async () => {
    const seller = await createTestTrader('partial_seller');
    const buyer = await createTestTrader('partial_buyer');

    await ledgerService.credit(seller.spotAccountId, 'BTC', '2.000000000000000000', 'DEPOSIT', `dep_s_${crypto.randomUUID()}`, 'Fund Seller');
    await ledgerService.credit(buyer.spotAccountId, 'USDT', '100000.000000000000000000', 'DEPOSIT', `dep_b_${crypto.randomUUID()}`, 'Fund Buyer');

    // Maker SELL 2 BTC @ 50,000
    const sellResult = await spotService.placeOrder({
      userId: seller.userId,
      accountId: seller.spotAccountId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'LIMIT',
      price: '50000.000000000000000000',
      quantity: '2.000000000000000000',
    });

    // Taker BUY 0.5 BTC @ 50,000
    const buyResult = await spotService.placeOrder({
      userId: buyer.userId,
      accountId: buyer.spotAccountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '50000.000000000000000000',
      quantity: '0.500000000000000000',
    });

    expect(buyResult.order.status).toBe('FILLED');

    // Verify Maker SELL is now PARTIALLY_FILLED in PostgreSQL
    const updatedSell = await spotService.getOrder(seller.userId, sellResult.order.id);
    expect(updatedSell.status).toBe('PARTIALLY_FILLED');
    expect(updatedSell.filledQuantity).toBe('0.500000000000000000');
    expect(updatedSell.remainingQuantity).toBe('1.500000000000000000');
  });

  // ── 4. Concurrency & Idempotency ─────────────────────────────────────────

  it('6. Client Order ID Idempotency: duplicate submission returns existing order', async () => {
    const buyer = await createTestTrader('cid_buyer');
    await ledgerService.credit(buyer.spotAccountId, 'USDT', '20000.000000000000000000', 'DEPOSIT', `dep_${crypto.randomUUID()}`, 'Deposit');

    const clientOrderId = `cid_${crypto.randomUUID()}`;

    const res1 = await spotService.placeOrder({
      userId: buyer.userId,
      accountId: buyer.spotAccountId,
      clientOrderId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '40000.000000000000000000',
      quantity: '0.100000000000000000',
    });

    const res2 = await spotService.placeOrder({
      userId: buyer.userId,
      accountId: buyer.spotAccountId,
      clientOrderId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '40000.000000000000000000',
      quantity: '0.100000000000000000',
    });

    expect(res1.order.id).toBe(res2.order.id);

    // Verify exactly 1 order row in PostgreSQL
    const orderCount = await db.query<any>('SELECT COUNT(*) as count FROM orders WHERE client_order_id = $1', [clientOrderId]);
    expect(Number(orderCount.rows[0].count)).toBe(1);
  });
});
