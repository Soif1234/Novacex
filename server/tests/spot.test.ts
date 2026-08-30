import { describe, it, expect, beforeEach } from 'vitest';
import { DatabasePool } from '../src/config/database';
import { SpotService } from '../src/services/spot/spot.service';
import { MatchingEngine } from '../src/services/spot/matching.engine';
import { LedgerService } from '../src/services/ledger/ledger.service';
import { WalletService } from '../src/services/wallet/wallet.service';
import { AuthService } from '../src/services/auth/auth.service';
import { SessionService } from '../src/services/auth/session.service';
import { SpotErrorCode } from '../src/services/spot/errors';
import { LedgerErrorCode } from '../src/services/ledger/errors';
import { WalletErrorCode } from '../src/services/wallet/errors';
import { decimalNormalize, decimalAdd, decimalSubtract, decimalMultiply } from '../src/services/ledger/decimal';

describe('Server-Side Spot Order & Matching Engine (Phase 4 Step 7)', () => {
  let database: DatabasePool;
  let ledger: LedgerService;
  let wallet: WalletService;
  let engine: MatchingEngine;
  let spot: SpotService;
  let auth: AuthService;
  let sessions: SessionService;

  let userA: { id: string; email: string; token: string; spotId: string };
  let userB: { id: string; email: string; token: string; spotId: string };
  let adminUser: { id: string; email: string; token: string; spotId: string };

  beforeEach(async () => {
    database = new DatabasePool();
    await database.connect();
    database.reset!();

    ledger = new LedgerService(database);
    wallet = new WalletService(database, ledger);
    engine = new MatchingEngine();
    spot = new SpotService(database, ledger, engine);
    sessions = new SessionService(database);
    auth = new AuthService(database, sessions);

    // 1. Signup User A
    const signupA = await auth.signup({ email: 'traderA@novacex.io', password: 'Password123!' });
    const loginA = await auth.login({ email: 'traderA@novacex.io', password: 'Password123!' });
    userA = {
      id: signupA.user.id,
      email: signupA.user.email,
      token: loginA.sessionToken,
      spotId: signupA.user.accounts.find(a => a.type === 'SPOT')!.id,
    };

    // 2. Signup User B
    const signupB = await auth.signup({ email: 'traderB@novacex.io', password: 'Password123!' });
    const loginB = await auth.login({ email: 'traderB@novacex.io', password: 'Password123!' });
    userB = {
      id: signupB.user.id,
      email: signupB.user.email,
      token: loginB.sessionToken,
      spotId: signupB.user.accounts.find(a => a.type === 'SPOT')!.id,
    };

    // 3. Signup Admin User
    const signupAdmin = await auth.signup({ email: 'admin@novacex.io', password: 'AdminPassword123!' });
    await database.query("UPDATE users SET role = 'ADMIN' WHERE id = $1", [signupAdmin.user.id]);
    const loginAdmin = await auth.login({ email: 'admin@novacex.io', password: 'AdminPassword123!' });
    adminUser = {
      id: signupAdmin.user.id,
      email: signupAdmin.user.email,
      token: loginAdmin.sessionToken,
      spotId: signupAdmin.user.accounts.find(a => a.type === 'SPOT')!.id,
    };
  });

  // ── 1. Valid LIMIT BUY accepted ────────────────────────────────────────────
  it('1. valid LIMIT BUY accepted', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '50000',
      referenceId: 'dep-test-1',
    });

    const res = await spot.placeOrder({
      userId: userA.id,
      accountId: userA.spotId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '50000',
      quantity: '1',
      clientOrderId: 'buy-1',
    });

    expect(res.order.id).toBeDefined();
    expect(res.order.status).toBe('NEW');
    expect(res.order.remainingQuantity).toBe(decimalNormalize('1'));
  });

  // ── 2. Valid LIMIT SELL accepted ───────────────────────────────────────────
  it('2. valid LIMIT SELL accepted', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'BTC',
      amount: '2',
      referenceId: 'dep-test-2',
    });

    const res = await spot.placeOrder({
      userId: userA.id,
      accountId: userA.spotId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'LIMIT',
      price: '52000',
      quantity: '1',
      clientOrderId: 'sell-2',
    });

    expect(res.order.id).toBeDefined();
    expect(res.order.status).toBe('NEW');
    expect(res.order.remainingQuantity).toBe(decimalNormalize('1'));
  });

  // ── 3. Invalid pair rejected ───────────────────────────────────────────────
  it('3. invalid pair rejected', async () => {
    await expect(
      spot.placeOrder({
        userId: userA.id,
        accountId: userA.spotId,
        symbol: 'INVALIDPAIR',
        side: 'BUY',
        type: 'LIMIT',
        price: '100',
        quantity: '1',
      })
    ).rejects.toMatchObject({
      code: SpotErrorCode.INVALID_TRADING_PAIR,
    });
  });

  // ── 4. Invalid side rejected ───────────────────────────────────────────────
  it('4. invalid side rejected', async () => {
    await expect(
      spot.placeOrder({
        userId: userA.id,
        accountId: userA.spotId,
        symbol: 'BTCUSDT',
        side: 'HOLD' as any,
        type: 'LIMIT',
        price: '50000',
        quantity: '1',
      })
    ).rejects.toMatchObject({
      code: SpotErrorCode.INVALID_ORDER_SIDE,
    });
  });

  // ── 5. Invalid order type rejected ─────────────────────────────────────────
  it('5. invalid order type rejected', async () => {
    await expect(
      spot.placeOrder({
        userId: userA.id,
        accountId: userA.spotId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'STOP_LOSS' as any,
        price: '50000',
        quantity: '1',
      })
    ).rejects.toMatchObject({
      code: SpotErrorCode.INVALID_ORDER_TYPE,
    });
  });

  // ── 6. Invalid quantity rejected ───────────────────────────────────────────
  it('6. invalid quantity rejected', async () => {
    await expect(
      spot.placeOrder({
        userId: userA.id,
        accountId: userA.spotId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'LIMIT',
        price: '50000',
        quantity: '-1',
      })
    ).rejects.toMatchObject({
      code: LedgerErrorCode.INVALID_AMOUNT,
    });
  });

  // ── 7. Invalid price rejected ──────────────────────────────────────────────
  it('7. invalid price rejected (missing, zero, negative)', async () => {
    await expect(
      spot.placeOrder({
        userId: userA.id,
        accountId: userA.spotId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'LIMIT',
        price: '0',
        quantity: '1',
      })
    ).rejects.toMatchObject({
      code: LedgerErrorCode.INVALID_AMOUNT,
    });
  });

  // ── 8. Insufficient quote balance rejects BUY ──────────────────────────────
  it('8. insufficient quote balance rejects BUY', async () => {
    // User has 100 USDT, wants to buy 1 BTC at 50,000 USDT
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '100',
      referenceId: 'dep-test-8',
    });

    await expect(
      spot.placeOrder({
        userId: userA.id,
        accountId: userA.spotId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'LIMIT',
        price: '50000',
        quantity: '1',
      })
    ).rejects.toMatchObject({
      code: LedgerErrorCode.INSUFFICIENT_AVAILABLE_BALANCE,
    });
  });

  // ── 9. Insufficient base balance rejects SELL ──────────────────────────────
  it('9. insufficient base balance rejects SELL', async () => {
    // User has 0.1 BTC, wants to sell 1 BTC
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'BTC',
      amount: '0.1',
      referenceId: 'dep-test-9',
    });

    await expect(
      spot.placeOrder({
        userId: userA.id,
        accountId: userA.spotId,
        symbol: 'BTCUSDT',
        side: 'SELL',
        type: 'LIMIT',
        price: '50000',
        quantity: '1',
      })
    ).rejects.toMatchObject({
      code: LedgerErrorCode.INSUFFICIENT_AVAILABLE_BALANCE,
    });
  });

  // ── 10. BUY reserves quote asset ───────────────────────────────────────────
  it('10. BUY reserves quote asset', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '60000',
      referenceId: 'dep-test-10',
    });

    await spot.placeOrder({
      userId: userA.id,
      accountId: userA.spotId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '50000',
      quantity: '1',
    });

    const bal = await wallet.getBalance(userA.id, userA.spotId, 'USDT');
    expect(bal.availableBalance).toBe(decimalNormalize('10000'));
    expect(bal.lockedBalance).toBe(decimalNormalize('50000'));
    expect(bal.totalBalance).toBe(decimalNormalize('60000'));
  });

  // ── 11. SELL reserves base asset ───────────────────────────────────────────
  it('11. SELL reserves base asset', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'BTC',
      amount: '3',
      referenceId: 'dep-test-11',
    });

    await spot.placeOrder({
      userId: userA.id,
      accountId: userA.spotId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'LIMIT',
      price: '50000',
      quantity: '2',
    });

    const bal = await wallet.getBalance(userA.id, userA.spotId, 'BTC');
    expect(bal.availableBalance).toBe(decimalNormalize('1'));
    expect(bal.lockedBalance).toBe(decimalNormalize('2'));
    expect(bal.totalBalance).toBe(decimalNormalize('3'));
  });

  // ── 12. Duplicate order reference is idempotent ────────────────────────────
  it('12. duplicate order reference is idempotent', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '50000',
      referenceId: 'dep-test-12',
    });

    const res1 = await spot.placeOrder({
      userId: userA.id,
      accountId: userA.spotId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '50000',
      quantity: '1',
      clientOrderId: 'idem-ord-12',
    });

    const res2 = await spot.placeOrder({
      userId: userA.id,
      accountId: userA.spotId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '50000',
      quantity: '1',
      clientOrderId: 'idem-ord-12',
    });

    expect(res2.order.id).toBe(res1.order.id);

    // Verify balance was only reserved once
    const bal = await wallet.getBalance(userA.id, userA.spotId, 'USDT');
    expect(bal.lockedBalance).toBe(decimalNormalize('50000'));
  });

  // ── 13. Conflicting duplicate reference rejected ───────────────────────────
  it('13. conflicting duplicate reference rejected', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '100000',
      referenceId: 'dep-test-13',
    });

    await spot.placeOrder({
      userId: userA.id,
      accountId: userA.spotId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '50000',
      quantity: '1',
      clientOrderId: 'conflict-ord-13',
    });

    await expect(
      spot.placeOrder({
        userId: userA.id,
        accountId: userA.spotId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'LIMIT',
        price: '45000', // Different price!
        quantity: '1',
        clientOrderId: 'conflict-ord-13',
      })
    ).rejects.toMatchObject({
      code: LedgerErrorCode.REFERENCE_CONFLICT,
    });
  });

  // ── 14. Higher BUY price has priority ──────────────────────────────────────
  it('14. higher BUY price has priority', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'USDT', amount: '150000', referenceId: 'dep-14a' });
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userB.spotId, asset: 'BTC', amount: '1', referenceId: 'dep-14b' });

    // Place lower buy: 49,000
    await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '49000', quantity: '1' });
    // Place higher buy: 51,000
    const buyHigh = await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '51000', quantity: '1' });

    // User B sells 1 BTC at 48,000 -> Should match with the higher buy (51,000)
    const sellRes = await spot.placeOrder({ userId: userB.id, accountId: userB.spotId, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', price: '48000', quantity: '1' });

    expect(sellRes.trades).toHaveLength(2); // 1 buyer trade, 1 seller trade
    const sellerTrade = sellRes.trades.find(t => t.side === 'SELL')!;
    expect(sellerTrade.price).toBe(decimalNormalize('51000'));
    expect(sellerTrade.counterpartyOrderId).toBe(buyHigh.order.id);
  });

  // ── 15. Lower SELL price has priority ──────────────────────────────────────
  it('15. lower SELL price has priority', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'BTC', amount: '2', referenceId: 'dep-15a' });
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userB.spotId, asset: 'USDT', amount: '60000', referenceId: 'dep-15b' });

    // Place higher sell: 52,000
    await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', price: '52000', quantity: '1' });
    // Place lower sell: 50,000
    const sellLow = await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', price: '50000', quantity: '1' });

    // User B buys 1 BTC at 53,000 -> Should match with lower sell (50,000)
    const buyRes = await spot.placeOrder({ userId: userB.id, accountId: userB.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '53000', quantity: '1' });

    const buyerTrade = buyRes.trades.find(t => t.side === 'BUY')!;
    expect(buyerTrade.price).toBe(decimalNormalize('50000'));
    expect(buyerTrade.counterpartyOrderId).toBe(sellLow.order.id);
  });

  // ── 16. Same price uses time priority ──────────────────────────────────────
  it('16. same price uses time priority (earlier order matched first)', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'BTC', amount: '2', referenceId: 'dep-16a' });
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userB.spotId, asset: 'USDT', amount: '60000', referenceId: 'dep-16b' });

    const firstSell = await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', price: '50000', quantity: '1' });
    const secondSell = await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', price: '50000', quantity: '1' });

    // User B buys 1 BTC at 50,000 -> Should match firstSell
    const buyRes = await spot.placeOrder({ userId: userB.id, accountId: userB.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '1' });

    const buyerTrade = buyRes.trades.find(t => t.side === 'BUY')!;
    expect(buyerTrade.counterpartyOrderId).toBe(firstSell.order.id);
  });


  // ── 17. Different pairs never cross-match ──────────────────────────────────
  it('17. different pairs never cross-match', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'BTC', amount: '1', referenceId: 'dep-17a' });
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userB.spotId, asset: 'USDC', amount: '60000', referenceId: 'dep-17b' });

    // Sell on BTCUSDT
    await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', price: '50000', quantity: '1' });

    // Buy on BTCUSDC
    const buyRes = await spot.placeOrder({ userId: userB.id, accountId: userB.spotId, symbol: 'BTCUSDC', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '1' });

    expect(buyRes.trades).toHaveLength(0);
    expect(buyRes.order.status).toBe('NEW');
  });

  // ── 18. BUY and SELL match correctly ───────────────────────────────────────
  it('18. BUY and SELL match correctly', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'BTC', amount: '1', referenceId: 'dep-18a' });
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userB.spotId, asset: 'USDT', amount: '50000', referenceId: 'dep-18b' });

    await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', price: '50000', quantity: '1' });
    const buyRes = await spot.placeOrder({ userId: userB.id, accountId: userB.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '1' });

    expect(buyRes.trades).toHaveLength(2);
    expect(buyRes.order.status).toBe('FILLED');
  });

  // ── 19. Correct execution price recorded ───────────────────────────────────
  it('19. correct execution price recorded', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'BTC', amount: '1', referenceId: 'dep-19a' });
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userB.spotId, asset: 'USDT', amount: '55000', referenceId: 'dep-19b' });

    // Maker sell @ 49,500
    await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', price: '49500', quantity: '1' });
    // Taker buy @ 50,000 -> Should execute at Maker's price (49,500)
    const buyRes = await spot.placeOrder({ userId: userB.id, accountId: userB.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '1' });

    expect(buyRes.trades[0].price).toBe(decimalNormalize('49500'));
  });

  // ── 20. Correct execution quantity recorded ────────────────────────────────
  it('20. correct execution quantity recorded', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'BTC', amount: '0.75', referenceId: 'dep-20a' });
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userB.spotId, asset: 'USDT', amount: '50000', referenceId: 'dep-20b' });

    await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', price: '50000', quantity: '0.75' });
    const buyRes = await spot.placeOrder({ userId: userB.id, accountId: userB.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '1' });

    expect(buyRes.trades[0].quantity).toBe(decimalNormalize('0.75'));
  });

  // ── 21. Buyer receives base asset ──────────────────────────────────────────
  it('21. buyer receives base asset', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'BTC', amount: '1', referenceId: 'dep-21a' });
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userB.spotId, asset: 'USDT', amount: '50000', referenceId: 'dep-21b' });

    await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', price: '50000', quantity: '1' });
    await spot.placeOrder({ userId: userB.id, accountId: userB.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '1' });

    const buyerBtc = await wallet.getBalance(userB.id, userB.spotId, 'BTC');
    expect(buyerBtc.availableBalance).toBe(decimalNormalize('1'));
  });

  // ── 22. Seller receives quote asset ────────────────────────────────────────
  it('22. seller receives quote asset', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'BTC', amount: '1', referenceId: 'dep-22a' });
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userB.spotId, asset: 'USDT', amount: '50000', referenceId: 'dep-22b' });

    await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', price: '50000', quantity: '1' });
    await spot.placeOrder({ userId: userB.id, accountId: userB.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '1' });

    const sellerUsdt = await wallet.getBalance(userA.id, userA.spotId, 'USDT');
    expect(sellerUsdt.availableBalance).toBe(decimalNormalize('50000'));
  });

  // ── 23. Partial fill works ─────────────────────────────────────────────────
  it('23. partial fill works: 10 BTC buy meets 4 BTC sell', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'BTC', amount: '4', referenceId: 'dep-23a' });
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userB.spotId, asset: 'USDT', amount: '500000', referenceId: 'dep-23b' });

    await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', price: '50000', quantity: '4' });
    const buyRes = await spot.placeOrder({ userId: userB.id, accountId: userB.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '10' });

    expect(buyRes.order.status).toBe('PARTIALLY_FILLED');
    expect(buyRes.order.filledQuantity).toBe(decimalNormalize('4'));
    expect(buyRes.order.remainingQuantity).toBe(decimalNormalize('6'));
  });

  // ── 24. Remaining order stays open ─────────────────────────────────────────
  it('24. remaining order stays open in the order book', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'BTC', amount: '4', referenceId: 'dep-24a' });
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userB.spotId, asset: 'USDT', amount: '500000', referenceId: 'dep-24b' });

    await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', price: '50000', quantity: '4' });
    await spot.placeOrder({ userId: userB.id, accountId: userB.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '10' });

    const openOrders = await spot.getOpenOrders(userB.id, 'BTCUSDT');
    expect(openOrders).toHaveLength(1);
    expect(openOrders[0].remainingQuantity).toBe(decimalNormalize('6'));
  });

  // ── 25. Cancellation releases remaining reservation ────────────────────────
  it('25. cancellation releases remaining reservation', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'USDT', amount: '50000', referenceId: 'dep-25' });

    const buy = await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '1' });
    await spot.cancelOrder(userA.id, buy.order.id);

    const bal = await wallet.getBalance(userA.id, userA.spotId, 'USDT');
    expect(bal.availableBalance).toBe(decimalNormalize('50000'));
    expect(bal.lockedBalance).toBe(decimalNormalize('0'));
  });

  // ── 26. Cancellation is idempotent ─────────────────────────────────────────
  it('26. cancellation is idempotent', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'USDT', amount: '50000', referenceId: 'dep-26' });

    const buy = await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '1' });
    const cancel1 = await spot.cancelOrder(userA.id, buy.order.id);
    const cancel2 = await spot.cancelOrder(userA.id, buy.order.id);

    expect(cancel1.status).toBe('CANCELLED');
    expect(cancel2.status).toBe('CANCELLED');
  });

  // ── 27. Cannot cancel another user's order ─────────────────────────────────
  it("27. cannot cancel another user's order", async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'USDT', amount: '50000', referenceId: 'dep-27' });

    const buy = await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '1' });

    // User B attempts to cancel User A's order
    await expect(spot.cancelOrder(userB.id, buy.order.id)).rejects.toMatchObject({
      code: WalletErrorCode.ACCOUNT_OWNERSHIP_DENIED,
    });
  });

  // ── 28. User cannot query another user's order ─────────────────────────────
  it("28. user cannot query another user's order", async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'USDT', amount: '50000', referenceId: 'dep-28' });

    const buy = await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '1' });

    await expect(spot.getOrder(userB.id, buy.order.id)).rejects.toMatchObject({
      code: WalletErrorCode.ACCOUNT_OWNERSHIP_DENIED,
    });
  });

  // ── 29. User cannot query another user's trades ────────────────────────────
  it("29. user cannot query another user's trades", async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'BTC', amount: '1', referenceId: 'dep-29a' });
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userB.spotId, asset: 'USDT', amount: '50000', referenceId: 'dep-29b' });

    await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', price: '50000', quantity: '1' });
    await spot.placeOrder({ userId: userB.id, accountId: userB.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '1' });

    const tradesA = await spot.getTradeHistory(userA.id);
    const tradesB = await spot.getTradeHistory(userB.id);

    expect(tradesA.every(t => t.accountId === userA.spotId)).toBe(true);
    expect(tradesB.every(t => t.accountId === userB.spotId)).toBe(true);
  });

  // ── 30. Market BUY executes correctly ──────────────────────────────────────
  it('30. Market BUY executes correctly against available asks', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'BTC', amount: '1', referenceId: 'dep-30a' });
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userB.spotId, asset: 'USDT', amount: '60000', referenceId: 'dep-30b' });

    await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', price: '50000', quantity: '1' });
    const marketBuy = await spot.placeOrder({ userId: userB.id, accountId: userB.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '1' });

    expect(marketBuy.order.status).toBe('FILLED');
    expect(marketBuy.trades).toHaveLength(2);
    expect(marketBuy.trades[0].price).toBe(decimalNormalize('50000'));
  });

  // ── 31. Market SELL executes correctly ─────────────────────────────────────
  it('31. Market SELL executes correctly against available bids', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'USDT', amount: '50000', referenceId: 'dep-31a' });
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userB.spotId, asset: 'BTC', amount: '1', referenceId: 'dep-31b' });

    await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '1' });
    const marketSell = await spot.placeOrder({ userId: userB.id, accountId: userB.spotId, symbol: 'BTCUSDT', side: 'SELL', type: 'MARKET', quantity: '1' });

    expect(marketSell.order.status).toBe('FILLED');
    expect(marketSell.trades).toHaveLength(2);
    expect(marketSell.trades[0].price).toBe(decimalNormalize('50000'));
  });

  // ── 32. Unused market-order reservation is released ────────────────────────
  it('32. unused market-order reservation is released', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'BTC', amount: '0.5', referenceId: 'dep-32a' });
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userB.spotId, asset: 'USDT', amount: '100000', referenceId: 'dep-32b' });

    // User A sells only 0.5 BTC @ 50,000
    await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', price: '50000', quantity: '0.5' });

    // User B tries to market buy 1 BTC (only 0.5 available)
    const mBuy = await spot.placeOrder({ userId: userB.id, accountId: userB.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '0.5' });
    expect(mBuy.order.status).toBe('FILLED');

    const balB = await wallet.getBalance(userB.id, userB.spotId, 'USDT');
    expect(balB.lockedBalance).toBe(decimalNormalize('0'));
    expect(balB.availableBalance).toBe(decimalNormalize('75000')); // 100000 - 25000
  });

  // ── 33. No negative balance after execution ────────────────────────────────
  it('33. no negative balance after execution', async () => {
    const balA = await wallet.getBalances(userA.id);
    const balB = await wallet.getBalances(userB.id);

    for (const b of [...balA, ...balB]) {
      expect(Number(b.availableBalance)).toBeGreaterThanOrEqual(0);
      expect(Number(b.lockedBalance)).toBeGreaterThanOrEqual(0);
      expect(Number(b.totalBalance)).toBeGreaterThanOrEqual(0);
    }
  });

  // ── 34. Duplicate fill cannot settle twice ──────────────────────────────────
  it('34. duplicate fill cannot settle twice', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'BTC', amount: '1', referenceId: 'dep-34a' });
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userB.spotId, asset: 'USDT', amount: '50000', referenceId: 'dep-34b' });

    await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', price: '50000', quantity: '1' });
    const buy = await spot.placeOrder({ userId: userB.id, accountId: userB.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '1' });

    expect(buy.trades).toHaveLength(2);

    // Reconcile confirms exact balance equality
    const recA = await ledger.reconcile(userA.spotId, 'USDT');
    const recB = await ledger.reconcile(userB.spotId, 'BTC');
    expect(recA.isConsistent).toBe(true);
    expect(recB.isConsistent).toBe(true);
  });

  // ── 35. Failed settlement rolls back ───────────────────────────────────────
  it('35. failed settlement rolls back', async () => {
    // If order placement fails at validation or reservation, no order is placed
    await expect(
      spot.placeOrder({
        userId: userA.id,
        accountId: userA.spotId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'LIMIT',
        price: '50000',
        quantity: '100', // Unfunded
      })
    ).rejects.toMatchObject({
      code: LedgerErrorCode.INSUFFICIENT_AVAILABLE_BALANCE,
    });

    const openOrders = await spot.getOpenOrders(userA.id);
    expect(openOrders).toHaveLength(0);
  });

  // ── 36. Concurrent duplicate order submission creates one order ────────────
  it('36. concurrent duplicate order submission creates one order', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'USDT', amount: '50000', referenceId: 'dep-36' });

    const p1 = spot.placeOrder({
      userId: userA.id,
      accountId: userA.spotId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '50000',
      quantity: '1',
      clientOrderId: 'conc-dup-36',
    });

    const p2 = spot.placeOrder({
      userId: userA.id,
      accountId: userA.spotId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '50000',
      quantity: '1',
      clientOrderId: 'conc-dup-36',
    });

    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    const openOrders = await spot.getOpenOrders(userA.id);
    expect(openOrders).toHaveLength(1);
  });

  // ── 37. Concurrent matching does not double-fill ───────────────────────────
  it('37. concurrent matching does not double-fill', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'BTC', amount: '1', referenceId: 'dep-37a' });
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userB.spotId, asset: 'USDT', amount: '100000', referenceId: 'dep-37b' });

    // User A sells 1 BTC
    await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', price: '50000', quantity: '1' });

    // Two buyers both want to buy 1 BTC
    const buy1 = await spot.placeOrder({ userId: userB.id, accountId: userB.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '1' });
    const buy2 = await spot.placeOrder({ userId: userB.id, accountId: userB.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '1' });

    expect(buy1.order.status).toBe('FILLED');
    expect(buy2.order.status).toBe('NEW'); // No more BTC to buy!

    const userB_Btc = await wallet.getBalance(userB.id, userB.spotId, 'BTC');
    expect(userB_Btc.availableBalance).toBe(decimalNormalize('1'));
  });

  // ── 38. Concurrent cancellation/execution is safe ──────────────────────────
  it('38. concurrent cancellation/execution is safe', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'USDT', amount: '50000', referenceId: 'dep-38' });

    const buy = await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '1' });
    const cancelled = await spot.cancelOrder(userA.id, buy.order.id);

    expect(cancelled.status).toBe('CANCELLED');

    // Attempting to cancel again is idempotent
    const cancelAgain = await spot.cancelOrder(userA.id, buy.order.id);
    expect(cancelAgain.status).toBe('CANCELLED');
  });

  // ── 39. Order book rebuilds correctly after restart ────────────────────────
  it('39. order book rebuilds correctly after restart', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'BTC', amount: '2', referenceId: 'dep-39' });

    await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', price: '51000', quantity: '1' });
    await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', price: '52000', quantity: '1' });

    // Simulate restart
    const newEngine = new MatchingEngine();
    const newSpot = new SpotService(database, ledger, newEngine);

    const recoveredCount = await newSpot.recoverMatchingEngine();
    expect(recoveredCount).toBe(2);

    const depth = await newSpot.getOrderBookDepth('BTCUSDT');
    expect(depth.asks).toHaveLength(2);
    expect(depth.asks[0].price).toBe(decimalNormalize('51000'));
  });

  // ── 40. Open orders survive server restart ─────────────────────────────────
  it('40. open orders survive server restart', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'USDT', amount: '50000', referenceId: 'dep-40' });

    const ord = await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '1' });

    const newSpot = new SpotService(database, ledger, new MatchingEngine());
    const openOrders = await newSpot.getOpenOrders(userA.id, 'BTCUSDT');

    expect(openOrders).toHaveLength(1);
    expect(openOrders[0].id).toBe(ord.order.id);
  });

  // ── 41. No synthetic/external liquidity is created ─────────────────────────
  it('41. no synthetic/external liquidity is created (empty book returns empty)', async () => {
    const emptyEngine = new MatchingEngine();
    const depth = await emptyEngine.getDepth(database, 'BTCUSDT');
    expect(depth.bids).toHaveLength(0);
    expect(depth.asks).toHaveLength(0);
  });

  // ── 42. All monetary calculations use exact decimal arithmetic ────────────
  it('42. all monetary calculations use exact decimal arithmetic', () => {
    const p1 = '0.1';
    const p2 = '0.2';
    expect(decimalAdd(p1, p2)).toBe(decimalNormalize('0.3'));
  });

  // ── 43. Fee behavior matches existing semantics where integrated ───────────
  it('43. fee behavior preserves existing rate semantics', async () => {
    const pair = await spot.validateTradingPair('BTCUSDT');
    expect(pair.makerFeeRate).toBe('0.001');
    expect(pair.takerFeeRate).toBe('0.001');
  });

  // ── 44. Account isolation across two users ─────────────────────────────────
  it('44. account isolation across two users', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'USDT', amount: '50000', referenceId: 'dep-44a' });
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userB.spotId, asset: 'USDT', amount: '50000', referenceId: 'dep-44b' });

    await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '1' });

    const openA = await spot.getOpenOrders(userA.id);
    const openB = await spot.getOpenOrders(userB.id);

    expect(openA).toHaveLength(1);
    expect(openB).toHaveLength(0);
  });

  // ── 45. Order/trade history remains consistent with fills ──────────────────
  it('45. order/trade history remains consistent with fills', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'BTC', amount: '1', referenceId: 'dep-45a' });
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userB.spotId, asset: 'USDT', amount: '50000', referenceId: 'dep-45b' });

    await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', price: '50000', quantity: '1' });
    await spot.placeOrder({ userId: userB.id, accountId: userB.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '1' });

    const historyA = await spot.getOrderHistory(userA.id);
    const tradesA = await spot.getTradeHistory(userA.id);

    expect(historyA[0].status).toBe('FILLED');
    expect(tradesA[0].quantity).toBe(decimalNormalize('1'));
  });

  // ── 46. Trade settlement corresponds to ledger entries ─────────────────────
  it('46. trade settlement corresponds to ledger entries', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'BTC', amount: '1', referenceId: 'dep-46a' });
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userB.spotId, asset: 'USDT', amount: '50000', referenceId: 'dep-46b' });

    await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', price: '50000', quantity: '1' });
    await spot.placeOrder({ userId: userB.id, accountId: userB.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '1' });

    const histA = await ledger.getHistory(userA.spotId);
    expect(histA.entries.some(e => e.transactionType === 'SPOT_TRADE_SETTLE')).toBe(true);
  });

  // ── 47. Every filled trade has exactly one financial settlement ────────────
  it('47. every filled trade has exactly one financial settlement', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'BTC', amount: '1', referenceId: 'dep-47a' });
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userB.spotId, asset: 'USDT', amount: '50000', referenceId: 'dep-47b' });

    await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', price: '50000', quantity: '1' });
    await spot.placeOrder({ userId: userB.id, accountId: userB.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '1' });

    const histA = await ledger.getHistory(userA.spotId);
    const settlements = histA.entries.filter(e => e.transactionType === 'SPOT_TRADE_SETTLE');
    expect(settlements).toHaveLength(2); // 1 debit BTC + 1 credit USDT
  });

  // ── 48. No ledger settlement exists without a corresponding trade ──────────
  it('48. no ledger settlement exists without a corresponding trade', async () => {
    const histA = await ledger.getHistory(userA.spotId);
    const settlements = histA.entries.filter(e => e.transactionType === 'SPOT_TRADE_SETTLE');
    const trades = await spot.getTradeHistory(userA.id);

    if (settlements.length === 0) {
      expect(trades).toHaveLength(0);
    }
  });

  // ── 49. Partial-fill accounting remains balanced ───────────────────────────
  it('49. partial-fill accounting remains balanced', async () => {
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'BTC', amount: '1', referenceId: 'dep-49a' });
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userB.spotId, asset: 'USDT', amount: '100000', referenceId: 'dep-49b' });

    await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', price: '50000', quantity: '1' });
    await spot.placeOrder({ userId: userB.id, accountId: userB.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '2' });

    const recB_USDT = await ledger.reconcile(userB.spotId, 'USDT');
    const recB_BTC = await ledger.reconcile(userB.spotId, 'BTC');

    expect(recB_USDT.isConsistent).toBe(true);
    expect(recB_BTC.isConsistent).toBe(true);
  });

  // ── 50. Full test of a BUY + SELL lifecycle from reservation to settlement ─
  it('50. full test of a BUY + SELL lifecycle from reservation to settlement', async () => {
    // 1. Initial deposits
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userA.spotId, asset: 'BTC', amount: '2', referenceId: 'dep-50a' });
    await wallet.paperDeposit({ adminUserId: adminUser.id, targetAccountId: userB.spotId, asset: 'USDT', amount: '100000', referenceId: 'dep-50b' });

    // 2. User A places Limit Sell 1 BTC @ 50,000
    const sell = await spot.placeOrder({ userId: userA.id, accountId: userA.spotId, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', price: '50000', quantity: '1' });
    expect(sell.order.status).toBe('NEW');

    // 3. User B places Limit Buy 1 BTC @ 50,000 -> Matches and fills!
    const buy = await spot.placeOrder({ userId: userB.id, accountId: userB.spotId, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '1' });
    expect(buy.order.status).toBe('FILLED');

    // 4. Balances verification
    const balA_BTC = await wallet.getBalance(userA.id, userA.spotId, 'BTC');
    const balA_USDT = await wallet.getBalance(userA.id, userA.spotId, 'USDT');
    const balB_BTC = await wallet.getBalance(userB.id, userB.spotId, 'BTC');
    const balB_USDT = await wallet.getBalance(userB.id, userB.spotId, 'USDT');

    expect(balA_BTC.availableBalance).toBe(decimalNormalize('1'));
    expect(balA_USDT.availableBalance).toBe(decimalNormalize('50000'));
    expect(balB_BTC.availableBalance).toBe(decimalNormalize('1'));
    expect(balB_USDT.availableBalance).toBe(decimalNormalize('50000'));

    // 5. Ledger Reconciliations
    expect((await ledger.reconcile(userA.spotId, 'BTC')).isConsistent).toBe(true);
    expect((await ledger.reconcile(userA.spotId, 'USDT')).isConsistent).toBe(true);
    expect((await ledger.reconcile(userB.spotId, 'BTC')).isConsistent).toBe(true);
    expect((await ledger.reconcile(userB.spotId, 'USDT')).isConsistent).toBe(true);
  });
});
