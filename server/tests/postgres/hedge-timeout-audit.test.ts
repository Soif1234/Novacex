import { describe, it, beforeAll, afterAll, expect, beforeEach, vi } from 'vitest';
import { FuturesHedgeManager } from '../../src/services/liquidity/futures-hedge.manager';
import { HyperliquidAdapter } from '../../src/services/liquidity/hyperliquid/hyperliquid.adapter';
import pkg from 'pg';
import { env } from '../../src/config/env';
const { Pool } = pkg;
import { TestDbHelper } from './test-db-helper';
import { ExposureGuard } from '../../src/services/liquidity/exposure.guard';

describe('Hedge Timeout & Reconciliation State Machine Audit (Phase HLP-5C)', () => {
  let dbHelper: TestDbHelper;
  let manager: FuturesHedgeManager;
  let adapter: HyperliquidAdapter;
  let rawPool: pkg.Pool;
  let exposureGuard: ExposureGuard;

  beforeAll(async () => {
    dbHelper = new TestDbHelper();
    await dbHelper.init();
    rawPool = new Pool({
      user: env.DB_USER,
      host: env.DB_HOST,
      database: env.DB_NAME,
      password: env.DB_PASSWORD,
      port: Number(env.DB_PORT)
    });

    adapter = new HyperliquidAdapter({
      hyperliquidEnv: 'testnet',
      agentPrivateKey: '0x' + '1'.repeat(64),
      accountAddress: '0x' + '2'.repeat(40),
      requestTimeoutMs: 1000
    });
    exposureGuard = new ExposureGuard();
    manager = new FuturesHedgeManager(adapter, exposureGuard, rawPool);
  });

  afterAll(async () => {
    await rawPool.end();
    await dbHelper.close();
  });

  beforeEach(async () => {
    await rawPool.query("DELETE FROM hedge_intents WHERE hedge_intent_id LIKE 'test_audit_%'");
    await rawPool.query("DELETE FROM house_exposure_events WHERE event_id LIKE 'test_ev_%'");
  });

  it('1. Timeout after submission leads to UNKNOWN_PENDING_RECONCILIATION', async () => {
    adapter.placeHedgeOrder = async () => {
      const err = new Error('Request timeout after 5000ms');
      (err as any).code = 'NETWORK_TIMEOUT';
      throw err;
    };

    const intentId = 'test_audit_timeout_post';
    await rawPool.query(`
      INSERT INTO hedge_intents (hedge_intent_id, market, side, target_exposure, requested_quantity, remaining_quantity, reason, status, cloid)
      VALUES ($1, 'BTC-PERP', 'BUY', '0', '0.001', '0.001', 'CUSTOMER_FILL', 'CREATED', '0x9991')
    `, [intentId]);

    manager.isRecoveryComplete = true;
    const intent = (await rawPool.query('SELECT * FROM hedge_intents WHERE hedge_intent_id = $1', [intentId])).rows[0];

    await manager.executeHedgeIntent({
      hedgeIntentId: intent.hedge_intent_id,
      market: intent.market,
      side: intent.side,
      targetExposure: intent.target_exposure,
      remainingQuantity: intent.remaining_quantity,
      reason: intent.reason,
      status: intent.status,
      cloid: intent.cloid
    });

    const res = (await rawPool.query('SELECT status FROM hedge_intents WHERE hedge_intent_id = $1', [intentId])).rows[0];
    expect(res.status).toBe('UNKNOWN_PENDING_RECONCILIATION');
  });

  it('2. Timeout / connection reset before submission leads to UNKNOWN_PENDING_RECONCILIATION', async () => {
    adapter.placeHedgeOrder = async () => {
      const err = new Error('ECONNRESET: socket hang up');
      (err as any).code = 'ECONNRESET';
      throw err;
    };

    const intentId = 'test_audit_timeout_pre';
    await rawPool.query(`
      INSERT INTO hedge_intents (hedge_intent_id, market, side, target_exposure, requested_quantity, remaining_quantity, reason, status, cloid)
      VALUES ($1, 'BTC-PERP', 'BUY', '0', '0.001', '0.001', 'CUSTOMER_FILL', 'CREATED', '0x9992')
    `, [intentId]);

    manager.isRecoveryComplete = true;
    const intent = (await rawPool.query('SELECT * FROM hedge_intents WHERE hedge_intent_id = $1', [intentId])).rows[0];

    await manager.executeHedgeIntent({
      hedgeIntentId: intent.hedge_intent_id,
      market: intent.market,
      side: intent.side,
      targetExposure: intent.target_exposure,
      remainingQuantity: intent.remaining_quantity,
      reason: intent.reason,
      status: intent.status,
      cloid: intent.cloid
    });

    const res = (await rawPool.query('SELECT status FROM hedge_intents WHERE hedge_intent_id = $1', [intentId])).rows[0];
    expect(res.status).toBe('UNKNOWN_PENDING_RECONCILIATION');
  });

  it('3. UNKNOWN reconciliation when venue returns unknownOid transitions to REJECTED', async () => {
    const intentId = 'test_audit_recon_rejected';
    await rawPool.query(`
      INSERT INTO hedge_intents (hedge_intent_id, market, side, target_exposure, requested_quantity, remaining_quantity, reason, status, cloid)
      VALUES ($1, 'BTC-PERP', 'BUY', '0', '0.001', '0.001', 'CUSTOMER_FILL', 'UNKNOWN_PENDING_RECONCILIATION', '0x9993')
    `, [intentId]);

    // Mock adapter recovery returning REJECTED (absent from venue)
    adapter.recoverUnknownOrder = async () => ({
      hedgeIntentId: intentId,
      status: 'REJECTED',
      requestedQuantity: '0.001',
      executedQuantity: '0',
      remainingQuantity: '0.001',
      timestamps: { submittedAt: new Date() }
    });

    await manager.initializeAndRecover();

    const res = (await rawPool.query('SELECT status FROM hedge_intents WHERE hedge_intent_id = $1', [intentId])).rows[0];
    expect(res.status).toBe('REJECTED');
  });

  it('4. UNKNOWN_PENDING_RECONCILIATION intent prevents duplicate hedge during evaluateNettingWindow', async () => {
    // Set house exposure to -0.005 (short 0.005)
    await rawPool.query("UPDATE house_exposure SET signed_exposure = '-0.005' WHERE market = 'BTC-PERP'");

    // Create an UNKNOWN intent that already covers the 0.005 exposure
    const intentId = 'test_audit_existing_unknown';
    await rawPool.query(`
      INSERT INTO hedge_intents (hedge_intent_id, market, side, target_exposure, requested_quantity, remaining_quantity, reason, status, cloid)
      VALUES ($1, 'BTC-PERP', 'BUY', '0', '0.005', '0.005', 'CUSTOMER_FILL', 'UNKNOWN_PENDING_RECONCILIATION', '0x9994')
    `, [intentId]);

    // Count intents before netting evaluation
    const preCount = (await rawPool.query("SELECT COUNT(*) as count FROM hedge_intents WHERE market = 'BTC-PERP'")).rows[0].count;

    manager.isRecoveryComplete = true;
    await manager.evaluateNettingWindow();

    // Count intents after netting evaluation
    const postCount = (await rawPool.query("SELECT COUNT(*) as count FROM hedge_intents WHERE market = 'BTC-PERP'")).rows[0].count;

    // Effective exposure is -0.005 + 0.005 = 0. NO duplicate hedge must be created!
    expect(postCount).toBe(preCount);

    // Reset exposure
    await rawPool.query("UPDATE house_exposure SET signed_exposure = '-0.001' WHERE market = 'BTC-PERP'");
  });

  it('5. House exposure consistency and idempotency', async () => {
    const tradeId = 'test_ev_idempotency_1';

    // Process customer fill: BUY 0.002 BTC (house goes short 0.002)
    const expBefore = (await rawPool.query("SELECT signed_exposure FROM house_exposure WHERE market = 'BTC-PERP'")).rows[0].signed_exposure;

    await manager.processCustomerFill('BTC-PERP', 'BUY', '0.002', '75000', tradeId);
    const expAfter = (await rawPool.query("SELECT signed_exposure FROM house_exposure WHERE market = 'BTC-PERP'")).rows[0].signed_exposure;

    // Reprocess the same tradeId (idempotent replay)
    await manager.processCustomerFill('BTC-PERP', 'BUY', '0.002', '75000', tradeId);
    const expReplay = (await rawPool.query("SELECT signed_exposure FROM house_exposure WHERE market = 'BTC-PERP'")).rows[0].signed_exposure;

    expect(expReplay).toBe(expAfter);

    // Revert the exposure change
    await rawPool.query("UPDATE house_exposure SET signed_exposure = $1 WHERE market = 'BTC-PERP'", [expBefore]);
  });
});
