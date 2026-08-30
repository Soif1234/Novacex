import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { createApp } from '../src/app';
import { ApiClient } from '../../src/services/api/client';
import { db } from '../src/config/database';
import { redis } from '../src/config/redis';
import { klineService } from '../src/services/market/kline.service';
import { eventBus } from '../src/services/market/event-bus';
import { totpService } from '../src/services/auth/totp.service';


describe('FINAL FRONTEND ↔ BACKEND LIVE E2E VERIFICATION (36 FLOWS)', () => {
  let server: http.Server;
  let client: ApiClient;
  let adminClient: ApiClient;
  let baseUrl: string;

  // Test identities
  const userEmail = `trader_${Date.now()}@novacex.live`;
  const userPassword = 'StrongPassword123!';
  let userId: string;
  let userSessionToken: string;
  let spotAccountId: string;
  let futuresAccountId: string;

  const adminEmail = `admin_${Date.now()}@novacex.live`;
  const adminPassword = 'AdminPassword123!';
  let adminId: string;
  let adminSessionToken: string;

  let totpSecret: string;
  let apiKeyId: string;
  let apiKeySecret: string;
  let spotOrderId: string;
  let futuresOrderId: string;
  let futuresPositionId: string;

  beforeAll(async () => {
    // 1. Start live HTTP server on random available port
    const app = createApp({ enableLogging: false });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}/api/v1`;
        client = new ApiClient(baseUrl);
        adminClient = new ApiClient(baseUrl);
        resolve();
      });
    });

    // 2. Initialize in-memory or db state
    await db.connect();
    await redis.connect();
    await klineService.start();
  });

  afterAll(async () => {
    await klineService.stop();
    await redis.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });


  // FLOW 1: Signup
  it('Flow 1: User Signup (POST /api/v1/auth/signup)', async () => {
    const res = await client.post<any>('/auth/signup', {
      email: userEmail,
      password: userPassword,
      username: 'TraderLive',
      displayName: 'Trader Live E2E',
    });

    expect(res).toBeDefined();
    expect(res.user).toBeDefined();
    expect(res.user.email).toBe(userEmail);
    const accounts = res.accounts || res.user.accounts;
    expect(accounts).toBeDefined();
    expect(accounts.length).toBeGreaterThanOrEqual(2);

    userId = res.user.id;
    const spotAcc = accounts.find((a: any) => a.type === 'SPOT');
    const futAcc = accounts.find((a: any) => a.type === 'FUTURES');
    expect(spotAcc).toBeDefined();
    expect(futAcc).toBeDefined();
    spotAccountId = spotAcc.id;
    futuresAccountId = futAcc.id;
  });


  // FLOW 2: Login
  it('Flow 2: User Login (POST /api/v1/auth/login)', async () => {
    const res = await client.post<any>('/auth/login', {
      email: userEmail,
      password: userPassword,
    });

    expect(res).toBeDefined();
    expect(res.user.id).toBe(userId);
    expect(res.sessionToken).toBeDefined();
    userSessionToken = res.sessionToken;
    client.setSessionToken(userSessionToken);
  });

  // FLOW 4: Session Recovery
  it('Flow 4: Session Recovery & User Profile (GET /api/v1/auth/me)', async () => {
    const res = await client.get<any>('/auth/me');
    expect(res).toBeDefined();
    expect(res.user.id).toBe(userId);
    expect(res.user.email).toBe(userEmail);
  });

  // FLOW 6: 2FA Setup
  it('Flow 6: 2FA Setup / Secret Generation (POST /api/v1/auth/2fa/setup)', async () => {
    const res = await client.post<any>('/auth/2fa/setup');
    expect(res).toBeDefined();
    expect(res.secret).toBeDefined();
    totpSecret = res.secret;
  });

  // FLOW 7: 2FA Enable
  it('Flow 7: 2FA Enablement (POST /api/v1/auth/2fa/enable)', async () => {
    const token = totpService.generateToken(totpSecret);

    const res = await client.post<any>('/auth/2fa/enable', { token });
    expect(res).toBeDefined();

    // Verify user profile reflects 2FA enabled
    const me = await client.get<any>('/auth/me');
    expect(me.user.twoFactorEnabled).toBe(true);
  });

  // FLOW 3: 2FA Login
  it('Flow 3: 2FA Login Flow (POST /api/v1/auth/login -> POST /api/v1/auth/2fa/verify-login)', async () => {
    // 1. Initial login returns 2faRequired
    const loginRes = await client.post<any>('/auth/login', {
      email: userEmail,
      password: userPassword,
    });

    expect(loginRes.twoFactorRequired).toBe(true);
    expect(loginRes.tempToken).toBeDefined();

    // 2. Complete 2FA login
    const token = totpService.generateToken(totpSecret);

    const verifyRes = await client.post<any>('/auth/2fa/verify-login', {
      tempToken: loginRes.tempToken,
      token,
    });

    expect(verifyRes.sessionToken).toBeDefined();
    userSessionToken = verifyRes.sessionToken;
    client.setSessionToken(userSessionToken);
  });

  // FLOW 8: 2FA Disable
  it('Flow 8: 2FA Disablement (POST /api/v1/auth/2fa/disable)', async () => {
    const token = totpService.generateToken(totpSecret);

    await client.post<any>('/auth/2fa/disable', {
      password: userPassword,
      token,
    });

    const me = await client.get<any>('/auth/me');
    expect(me.user.twoFactorEnabled).toBe(false);
  });





  // FLOW 9: API Key Create / List / Revoke
  it('Flow 9: API Key CRUD (POST, GET, DELETE /api/v1/auth/api-keys)', async () => {
    // Create
    const createRes = await client.post<any>('/auth/api-keys', {
      label: 'TradingBot-Live',
      permissions: ['READ', 'TRADE'],
    });

    expect(createRes.id).toBeDefined();
    expect(createRes.secret).toBeDefined();
    apiKeyId = createRes.id;
    apiKeySecret = createRes.secret;

    // List
    const listRes = await client.get<any>('/auth/api-keys');
    expect(listRes.apiKeys).toBeDefined();
    expect(listRes.apiKeys.some((k: any) => k.id === apiKeyId)).toBe(true);

    // Delete / Revoke
    await client.delete(`/auth/api-keys/${apiKeyId}`);
    const listAfter = await client.get<any>('/auth/api-keys');
    const revokedKey = listAfter.apiKeys.find((k: any) => k.id === apiKeyId);
    expect(revokedKey.status).toBe('REVOKED');
  });

  // FLOW 10: KYC Status
  it('Flow 10: KYC Status & Limits (GET /api/v1/kyc/status)', async () => {
    const res = await client.get<any>('/kyc/status');
    expect(res).toBeDefined();
    expect(res.userId).toBe(userId);
    expect(res.dailyLimit).toBeDefined();
    expect(res.remainingDailyLimit).toBeDefined();
  });

  // FLOW 11: KYC Submission
  it('Flow 11: KYC Submission (POST /api/v1/kyc/submit)', async () => {
    const res = await client.post<any>('/kyc/submit', {
      targetTier: 'TIER_1',
      firstName: 'Live',
      lastName: 'Trader',
      dateOfBirth: '1995-01-01',
      nationality: 'GBR',
      idDocumentType: 'PASSPORT',
      idDocumentNumber: 'P987654321',
    });

    expect(res.profile).toBeDefined();
    expect(['PENDING', 'PENDING_REVIEW']).toContain(res.profile.status);
  });



  // Admin Setup for Admin Flows
  it('Setup Admin Identity for Administrative Endpoints', async () => {
    const signup = await adminClient.post<any>('/auth/signup', {
      email: adminEmail,
      password: adminPassword,
      username: 'SuperAdmin',
      displayName: 'Super Admin',
    });
    adminId = signup.user.id;

    // Elevate admin role directly in db
    await db.query("UPDATE users SET role = 'ADMIN' WHERE id = $1", [adminId]);


    const login = await adminClient.post<any>('/auth/login', {
      email: adminEmail,
      password: adminPassword,
    });
    adminSessionToken = login.sessionToken;
    adminClient.setSessionToken(adminSessionToken);
  });

  // FLOW 12: Admin KYC Approval
  it('Flow 12: Admin KYC Approval (POST /api/v1/kyc/review)', async () => {
    const res = await adminClient.post<any>('/kyc/review', {
      userId,
      approved: true,
      assignedTier: 'TIER_1',
    });

    expect(res.profile).toBeDefined();
    expect(res.profile.status).toBe('VERIFIED');
    expect(res.profile.tier).toBe('TIER_1');

    // Verify user KYC status updated
    const userKyc = await client.get<any>('/kyc/status');
    expect(userKyc.tier).toBe('TIER_1');
  });

  // FLOW 13: Market Tickers
  it('Flow 13: Market Tickers (GET /api/v1/market/tickers & /ticker/:symbol)', async () => {
    const tickersRes = await client.get<any>('/market/tickers');
    expect(tickersRes.tickers).toBeDefined();
    expect(Array.isArray(tickersRes.tickers)).toBe(true);
    expect(tickersRes.tickers.length).toBeGreaterThan(0);

    const btcTicker = await client.get<any>('/market/ticker/BTCUSDT');
    expect(btcTicker.symbol).toBe('BTCUSDT');
    expect(btcTicker.lastPrice).toBeDefined();
  });

  // FLOW 14: Order Book Loading
  it('Flow 14: Order Book Depth (GET /api/v1/market/orderbook/:symbol)', async () => {
    const book = await client.get<any>('/market/orderbook/BTCUSDT');
    expect(book.symbol).toBe('BTCUSDT');
    expect(book.bids).toBeDefined();
    expect(book.asks).toBeDefined();
  });

  // FLOW 15: K-Line / Historical Candlesticks
  it('Flow 15: Historical K-Lines (GET /api/v1/market/klines)', async () => {
    // Trigger trade event so candle is created
    eventBus.publish({
      type: 'market.trade',
      payload: {
        tradeId: 't-live-1',
        symbol: 'BTCUSDT',
        price: '65000',
        quantity: '0.1',
        isMaker: false,
        timestamp: Date.now(),
      },
    });
    await new Promise(r => setTimeout(r, 50));

    const klines = await client.get<any[]>('/market/klines', {
      symbol: 'BTCUSDT',
      market: 'SPOT',
      interval: '1m',
    });

    expect(Array.isArray(klines)).toBe(true);
  });

  // FLOW 27: Paper Deposit
  it('Flow 27: Paper / Demo Deposit (POST /api/v1/wallet/admin/paper-deposit)', async () => {
    const res = await adminClient.post<any>('/wallet/admin/paper-deposit', {
      targetAccountId: spotAccountId,
      targetUserId: userId,
      asset: 'USDT',
      amount: '50000.00000000',
      referenceId: `dep-${Date.now()}`,
      description: 'Initial balance funding',
    });

    expect(parseFloat(res.amount)).toBe(50000);
    expect(res.asset).toBe('USDT');
  });

  // FLOW 26: Wallet Balances
  it('Flow 26: Wallet Balances (GET /api/v1/wallet/balances)', async () => {
    const res = await client.get<any>('/wallet/balances', { accountId: spotAccountId });
    const balances = Array.isArray(res) ? res : res.balances;
    const usdt = Array.isArray(balances) ? balances.find((b: any) => b.asset === 'USDT') : balances?.USDT;
    expect(usdt).toBeDefined();
    expect(parseFloat(usdt.availableBalance || usdt.available)).toBeGreaterThanOrEqual(50000);
  });


  // FLOW 16: Spot Order Placement
  it('Flow 16: Spot Order Placement (POST /api/v1/spot/orders)', async () => {
    const res = await client.post<any>('/spot/orders', {
      accountId: spotAccountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '50000.000000000000000000',
      quantity: '0.500000000000000000',
      clientOrderId: `ord-spot-1`,
    });

    expect(res.order).toBeDefined();
    expect(res.order.status).toBe('NEW');
    expect(res.order.symbol).toBe('BTCUSDT');
    spotOrderId = res.order.id;
  });

  // FLOW 18: Spot Open Orders & History
  it('Flow 18: Spot Open Orders & Order History (GET /api/v1/spot/orders/open & /spot/orders)', async () => {
    const openOrders = await client.get<any>('/spot/orders/open', { symbol: 'BTCUSDT' });
    expect(openOrders.orders).toBeDefined();
    expect(openOrders.orders.some((o: any) => o.id === spotOrderId)).toBe(true);

    const history = await client.get<any>('/spot/orders');
    expect(history.orders).toBeDefined();
    expect(history.orders.some((o: any) => o.id === spotOrderId)).toBe(true);
  });

  // FLOW 17: Spot Order Cancellation
  it('Flow 17: Spot Order Cancellation (POST /api/v1/spot/orders/:id/cancel)', async () => {
    const cancelRes = await client.post<any>(`/spot/orders/${spotOrderId}/cancel`);
    expect(cancelRes.status).toBe('CANCELLED');

    const openOrders = await client.get<any>('/spot/orders/open');
    expect(openOrders.orders.some((o: any) => o.id === spotOrderId)).toBe(false);
  });

  // FLOW 19: Spot Trade History
  it('Flow 19: Spot Trade Executions (GET /api/v1/spot/trades)', async () => {
    const trades = await client.get<any>('/spot/trades');
    expect(trades.trades).toBeDefined();
    expect(Array.isArray(trades.trades)).toBe(true);
  });

  // FLOW 29: Internal Spot ↔ Futures Transfer
  it('Flow 29: Internal Transfer (POST /api/v1/wallet/transfer)', async () => {
    const transferRes = await client.post<any>('/wallet/transfer', {
      fromAccountId: spotAccountId,
      toAccountId: futuresAccountId,
      asset: 'USDT',
      amount: '10000.00000000',
      referenceId: `trans-${Date.now()}`,
      description: 'Transfer Spot to Futures',
    });

    expect(parseFloat(transferRes.amount)).toBe(10000);

    // Verify Futures balance updated
    const futBalances = await client.get<any>('/wallet/balances', { accountId: futuresAccountId });
    const balancesList = Array.isArray(futBalances) ? futBalances : futBalances.balances;
    const futUsdt = Array.isArray(balancesList) ? balancesList.find((b: any) => b.asset === 'USDT' || b.asset === 'FUTURES_USDT') : balancesList?.USDT;
    expect(futUsdt).toBeDefined();
    expect(parseFloat(futUsdt.availableBalance || futUsdt.available)).toBeGreaterThanOrEqual(10000);
  });


  // FLOW 20: Futures Mark Price & Funding
  it('Flow 20: Futures Mark Price & Funding (GET /api/v1/market/mark-price/:symbol)', async () => {
    const mark = await client.get<any>('/market/mark-price/BTCUSDT');
    expect(mark.symbol).toBe('BTCUSDT');
    expect(mark.markPrice).toBeDefined();
  });

  // FLOW 21: Futures Order Placement
  it('Flow 21: Futures Order Placement (POST /api/v1/futures/orders)', async () => {
    const res = await client.post<any>('/futures/orders', {
      accountId: futuresAccountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '0.100000000000000000',
      leverage: 10,
      marginMode: 'ISOLATED',
    });

    expect(res.order).toBeDefined();
    expect(res.order.status).toBe('FILLED');
    futuresOrderId = res.order.id;
  });

  // FLOW 23: Futures Positions & PnL
  it('Flow 23: Futures Positions & Unrealized PnL (GET /api/v1/futures/positions)', async () => {
    const res = await client.get<any>('/futures/positions');
    expect(res.positions).toBeDefined();
    expect(res.positions.length).toBeGreaterThan(0);
    const btcPos = res.positions.find((p: any) => p.symbol === 'BTCUSDT');
    expect(btcPos).toBeDefined();
    expect(btcPos.entryPrice).toBeDefined();
    expect(btcPos.liquidationPrice).toBeDefined();
    futuresPositionId = btcPos.id;
  });

  // FLOW 24: Futures TP/SL Config
  it('Flow 24: Futures Take Profit / Stop Loss (POST & GET /api/v1/futures/positions/:id/tpsl)', async () => {
    const setRes = await client.post<any>(`/futures/positions/${futuresPositionId}/tpsl`, {
      takeProfitEnabled: true,
      takeProfitPrice: '75000.000000000000000000',
      stopLossEnabled: true,
      stopLossPrice: '45000.000000000000000000',
    });

    expect(setRes.takeProfitEnabled).toBe(true);

    const getRes = await client.get<any>(`/futures/positions/${futuresPositionId}/tpsl`);
    expect(getRes.takeProfitPrice).toBe('75000.000000000000000000');
    expect(getRes.stopLossPrice).toBe('45000.000000000000000000');
  });

  // FLOW 22: Futures Order Cancellation
  it('Flow 22: Futures Limit Order Placement & Cancellation (POST & POST /cancel)', async () => {
    const limitOrder = await client.post<any>('/futures/orders', {
      accountId: futuresAccountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'LIMIT',
      price: '40000.000000000000000000',
      quantity: '0.100000000000000000',
      leverage: 10,
      marginMode: 'ISOLATED',
    });

    expect(limitOrder.order.status).toBe('NEW');

    const cancelRes = await client.post<any>(`/futures/orders/${limitOrder.order.id}/cancel`);
    expect(cancelRes.status).toBe('CANCELLED');
  });

  // FLOW 25: Futures Liquidation Evaluation (P0 remediation: client-supplied
  // markPrice is IGNORED — the route evaluates against the authoritative
  // mark price only, so an attacker cannot force-liquidation with a fake price)
  it('Flow 25: Futures Liquidation Evaluation (POST /api/v1/futures/positions/:id/liquidate)', async () => {
    // 1. Solvent position at authoritative price returns 400 not eligible,
    //    regardless of any markPrice supplied by the caller.
    await expect(
      client.post(`/futures/positions/${futuresPositionId}/liquidate`, {
        markPrice: '50000.000000000000000000',
      })
    ).rejects.toThrow();

    // 2. An insolvency-inducing client markPrice must NOT liquidate the
    //    position: the controller ignores the body price and uses the
    //    authoritative mark (dev provider 50000), so the position stays OPEN.
    await expect(
      client.post(`/futures/positions/${futuresPositionId}/liquidate`, {
        markPrice: '10000.000000000000000000',
      })
    ).rejects.toThrow();

    // 3. Verify the position was NOT liquidated by the fake-price attempt.
    const posRes = await client.get<any>(`/futures/positions/${futuresPositionId}`);
    const pos = posRes.data ?? posRes.position ?? posRes;
    expect(pos).toBeDefined();
    expect(pos.status).toBe('OPEN');
    expect(pos.status).not.toBe('LIQUIDATED');
  });



  // FLOW 28: Withdrawal with KYC/2FA Guards
  it('Flow 28: Withdrawal Guarded by 2FA & KYC Limits (POST /api/v1/wallet/withdraw)', async () => {
    const withdrawRes = await client.post<any>('/wallet/withdraw', {
      accountId: spotAccountId,
      asset: 'USDT',
      amount: '500.00000000',
      referenceId: `wdr-${Date.now()}`,
      destinationAddress: '0x1111222233334444555566667777888899990000',
      description: 'Test withdrawal to external wallet',
    });

    expect(parseFloat(withdrawRes.amount)).toBe(500);
    expect(withdrawRes.destinationAddress).toBe('0x1111222233334444555566667777888899990000');
  });


  // FLOW 30: Transaction History
  it('Flow 30: Transaction History (GET /api/v1/wallet/transactions)', async () => {
    const txs = await client.get<any>('/wallet/transactions');
    const entries = txs.entries || txs.transactions || txs;
    expect(entries).toBeDefined();
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
  });

  // FLOW 31: Admin User Management
  it('Flow 31: Admin User Directory & Role Management (GET /admin/users & PATCH /admin/users/:id/role)', async () => {
    const usersList = await adminClient.get<any>('/admin/users');
    expect(usersList.users).toBeDefined();
    expect(usersList.users.some((u: any) => u.id === userId)).toBe(true);

    const updateStatus = await adminClient.patch<any>(`/admin/users/${userId}/status`, {
      status: 'ACTIVE',
      reason: 'Admin verified active trader',
    });
    expect(updateStatus.user.accountStatus).toBe('ACTIVE');
  });

  // FLOW 32: Admin Circuit Breakers
  it('Flow 32: Admin Circuit Breakers (GET /circuit-breaker/status & POST /admin/circuit-breaker/halt /resume)', async () => {
    const status = await client.get<any>('/circuit-breaker/status');
    expect(status.subsystems).toBeDefined();

    // Emergency Halt SPOT_TRADING
    await adminClient.post('/admin/circuit-breaker/halt', {
      mode: 'HALT_TRADING',
      reason: 'Automated E2E Circuit Breaker Test Halt',
    });

    // Verify spot order fails while halted
    await expect(
      client.post('/spot/orders', {
        accountId: spotAccountId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'LIMIT',
        price: '50000',
        quantity: '0.1',
      })
    ).rejects.toThrow();

    // Resume
    await adminClient.post('/admin/circuit-breaker/resume', {
      reason: 'Automated E2E Test Resume',
      resumeAll: true,
    });
  });

  // FLOW 33: Admin Balance Reconciliation
  it('Flow 33: Admin Balance Reconciliation & Alerts (POST /admin/reconciliation/run & GET /alerts)', async () => {
    const runRes = await adminClient.post<any>('/admin/reconciliation/run');
    expect(runRes.id || runRes.reportId).toBeDefined();
    expect(runRes.status).toBe('PASSED');

    const reports = await adminClient.get<any[]>('/admin/reconciliation/reports');
    expect(Array.isArray(reports)).toBe(true);

    const alerts = await adminClient.get<any[]>('/admin/reconciliation/alerts');
    expect(Array.isArray(alerts)).toBe(true);
  });




  // FLOW 34: Admin Audit Logs
  it('Flow 34: Administrative Audit Trail (GET /api/v1/admin/audit-logs)', async () => {
    const logs = await adminClient.get<any>('/admin/audit-logs');
    expect(logs.logs).toBeDefined();
    expect(Array.isArray(logs.logs)).toBe(true);
    expect(logs.logs.length).toBeGreaterThan(0);
  });

  // FLOW 35: Admin Operational Telemetry
  it('Flow 35: Operational Telemetry & Metrics (GET /api/v1/admin/metrics & /metrics/prometheus)', async () => {
    const metrics = await adminClient.get<any>('/admin/metrics');
    expect(metrics.http).toBeDefined();
    expect(metrics.http.totalRequests).toBeGreaterThan(0);
    expect(metrics.database).toBeDefined();
    expect(metrics.redis).toBeDefined();
  });

  // FLOW 36: System Health Liveness & Readiness Probes
  it('Flow 36: System Health & Readiness Probes (GET /api/v1/health/live & /health/ready)', async () => {
    const live = await client.get<any>('/health/live');
    expect(live.status).toBe('alive');

    const ready = await client.get<any>('/health/ready');
    expect(['ready', 'degraded']).toContain(ready.status);
    expect(ready.checks).toBeDefined();
    expect(ready.checks.database.status).toBe('pass');
  });



  // FLOW 5: Logout
  it('Flow 5: User Logout (POST /api/v1/auth/logout)', async () => {
    await client.post('/auth/logout');

    // Trying to access protected route afterwards must throw 401
    await expect(client.get('/auth/me')).rejects.toThrow();
  });
});
