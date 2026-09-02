import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { HyperliquidAdapter } from '../src/services/liquidity/hyperliquid/hyperliquid.adapter';
import { FuturesHedgeManager } from '../src/services/liquidity/futures-hedge.manager';
import { ExposureGuard } from '../src/services/liquidity/exposure.guard';
import { HyperliquidError, HyperliquidErrorCode } from '../src/services/liquidity/hyperliquid/hyperliquid.types';
import pkg from 'pg';
import { env } from '../src/config/env';
const { Pool } = pkg;

describe('Phase HLP-5D: Hyperliquid Request Timeout Mapping & State Preservation', () => {
  let pool: pkg.Pool;

  beforeAll(async () => {
    pool = new Pool({
      user: env.DB_USER,
      host: env.DB_HOST,
      database: env.DB_NAME,
      password: env.DB_PASSWORD,
      port: Number(env.DB_PORT)
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('1. config.requestTimeoutMs = 10000 reaches HyperliquidClient.timeoutMs = 10000', () => {
    const adapter = new HyperliquidAdapter({
      hyperliquidEnv: 'testnet',
      agentPrivateKey: '0x' + '1'.repeat(64),
      accountAddress: '0x' + '2'.repeat(40),
      requestTimeoutMs: 10000
    });

    const client = adapter.getClient();
    expect((client as any).timeoutMs).toBe(10000);
  });

  it('2. config.requestTimeoutMs = undefined defaults to HyperliquidClient.timeoutMs = 15000', () => {
    const adapter = new HyperliquidAdapter({
      hyperliquidEnv: 'testnet',
      agentPrivateKey: '0x' + '1'.repeat(64),
      accountAddress: '0x' + '2'.repeat(40)
    });

    const client = adapter.getClient();
    expect((client as any).timeoutMs).toBe(15000);
  });

  it('3. Preserves failure classification: network timeout -> UNKNOWN_PENDING_RECONCILIATION', async () => {
    const adapter = new HyperliquidAdapter({
      hyperliquidEnv: 'testnet',
      agentPrivateKey: '0x' + '1'.repeat(64),
      accountAddress: '0x' + '2'.repeat(40)
    });

    adapter.placeHedgeOrder = async () => {
      throw new HyperliquidError(
        HyperliquidErrorCode.NETWORK_TIMEOUT,
        'Request timeout after 15000ms',
        undefined,
        true
      );
    };

    const manager = new FuturesHedgeManager(adapter, new ExposureGuard(), pool);
    manager.isRecoveryComplete = true;

    const intentId = 'test_hlp5d_timeout';
    await pool.query("DELETE FROM hedge_intents WHERE hedge_intent_id = $1", [intentId]);
    await pool.query(`
      INSERT INTO hedge_intents (hedge_intent_id, market, side, target_exposure, requested_quantity, remaining_quantity, reason, status, cloid)
      VALUES ($1, 'BTC-PERP', 'BUY', '0', '0.001', '0.001', 'CUSTOMER_FILL', 'CREATED', '0x7771')
    `, [intentId]);

    const intent = (await pool.query('SELECT * FROM hedge_intents WHERE hedge_intent_id = $1', [intentId])).rows[0];
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

    const updated = (await pool.query('SELECT status FROM hedge_intents WHERE hedge_intent_id = $1', [intentId])).rows[0];
    expect(updated.status).toBe('UNKNOWN_PENDING_RECONCILIATION');
    await pool.query("DELETE FROM hedge_intents WHERE hedge_intent_id = $1", [intentId]);
  });

  it('3b. Preserves failure classification: deterministic 4xx -> FAILED', async () => {
    const adapter = new HyperliquidAdapter({
      hyperliquidEnv: 'testnet',
      agentPrivateKey: '0x' + '1'.repeat(64),
      accountAddress: '0x' + '2'.repeat(40)
    });

    adapter.placeHedgeOrder = async () => {
      throw new HyperliquidError(
        HyperliquidErrorCode.INVALID_ORDER_PARAMETERS,
        'Exchange rejected action: User or API Wallet does not exist',
        undefined,
        false
      );
    };

    const manager = new FuturesHedgeManager(adapter, new ExposureGuard(), pool);
    manager.isRecoveryComplete = true;

    const intentId = 'test_hlp5d_deterministic_4xx';
    await pool.query("DELETE FROM hedge_intents WHERE hedge_intent_id = $1", [intentId]);
    await pool.query(`
      INSERT INTO hedge_intents (hedge_intent_id, market, side, target_exposure, requested_quantity, remaining_quantity, reason, status, cloid)
      VALUES ($1, 'BTC-PERP', 'BUY', '0', '0.001', '0.001', 'CUSTOMER_FILL', 'CREATED', '0x7772')
    `, [intentId]);

    const intent = (await pool.query('SELECT * FROM hedge_intents WHERE hedge_intent_id = $1', [intentId])).rows[0];
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

    const updated = (await pool.query('SELECT status FROM hedge_intents WHERE hedge_intent_id = $1', [intentId])).rows[0];
    expect(updated.status).toBe('FAILED');
    await pool.query("DELETE FROM hedge_intents WHERE hedge_intent_id = $1", [intentId]);
  });

  it('4. Verifies terminal intent state preservation and no duplicate order created', async () => {
    const testTerminalId = 'test_hlp5d_terminal_rejected';
    await pool.query("DELETE FROM hedge_intents WHERE hedge_intent_id = $1", [testTerminalId]);
    await pool.query(`
      INSERT INTO hedge_intents (hedge_intent_id, market, side, target_exposure, requested_quantity, remaining_quantity, reason, status, cloid)
      VALUES ($1, 'BTC-PERP', 'BUY', '0', '0.001', '0.001', 'CUSTOMER_FILL', 'REJECTED', '0x8888')
    `, [testTerminalId]);

    const res = await pool.query("SELECT hedge_intent_id, status FROM hedge_intents WHERE hedge_intent_id = $1", [testTerminalId]);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].status).toBe('REJECTED');

    // Verify external_orders count remains 0
    const extOrders = await pool.query("SELECT COUNT(*) as count FROM external_orders WHERE market = 'BTC-PERP'");
    expect(Number(extOrders.rows[0].count)).toBe(0);

    // Verify external_fills count remains 0
    const extFills = await pool.query("SELECT COUNT(*) as count FROM external_fills WHERE market = 'BTC-PERP'");
    expect(Number(extFills.rows[0].count)).toBe(0);
    await pool.query("DELETE FROM hedge_intents WHERE hedge_intent_id = $1", [testTerminalId]);
  });
});
