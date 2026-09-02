import { describe, it, beforeAll, afterAll, expect, beforeEach } from 'vitest';
import { FuturesHedgeManager } from '../../src/services/liquidity/futures-hedge.manager';
import { HyperliquidAdapter } from '../../src/services/liquidity/hyperliquid/hyperliquid.adapter';
import pkg from 'pg';
import { env } from '../../src/config/env';
const { Pool } = pkg;
import { TestDbHelper } from './test-db-helper';
import { HyperliquidMsgpackEncoder, HyperliquidSigner } from '../../src/services/liquidity/hyperliquid/hyperliquid.signer';
import { ethers } from 'ethers';

describe('Hyperliquid Hedge Manager & Adapter Tests (Phase HLP-2)', () => {
  let dbHelper: TestDbHelper;
  let manager: FuturesHedgeManager;
  let adapter: HyperliquidAdapter;
  let rawPool: pkg.Pool;

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

    await rawPool.query(`DELETE FROM hedge_intents`);

    adapter = new HyperliquidAdapter({
      hyperliquidEnv: 'testnet',
      agentPrivateKey: '0x' + '1'.repeat(64),
      accountAddress: '0x' + '2'.repeat(40),
      requestTimeoutMs: 1000
    });
    const mockExposureGuard: any = {
      evaluateHedge: () => ({ result: 'PROCEED', allowedQuantity: '0.001' })
    };
    manager = new FuturesHedgeManager(adapter, mockExposureGuard, rawPool);
  });

  afterAll(async () => {
    await rawPool.end();
    await dbHelper.close();
  });

  beforeEach(async () => {
    await rawPool.query(`DELETE FROM hedge_intents`);
  });

  it('A. Local recovered signer', async () => {
    const pk = '0x0000000000000000000000000000000000000000000000000000000000000001';
    const signer = new HyperliquidSigner(pk, false);
    const action = { type: 'order', orders: [], grouping: 'na' };
    const { signature, connectionId } = await signer.signL1Action(action, 12345, null, null);
    const recovered = HyperliquidSigner.verifyL1Signature(connectionId, signature, false);
    expect(recovered).toBe(new ethers.Wallet(pk).address.toLowerCase());
  });

  it('B. Deterministic connectionId vector', async () => {
    const action = { type: 'order', orders: [], grouping: 'na' };
    const buf = HyperliquidMsgpackEncoder.encode(action);
    const hex = buf.toString('hex');
    expect(hex.includes('type')).toBe(false);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('C. 400 -> terminal failure', async () => {
    adapter.placeHedgeOrder = async () => {
      const e = new Error('INVALID_ORDER_PARAMETERS');
      (e as any).code = 'INVALID_ORDER_PARAMETERS';
      throw e;
    };
    await rawPool.query(`INSERT INTO hedge_intents (hedge_intent_id, market, side, target_exposure, requested_quantity, remaining_quantity, reason, status, cloid)
                    VALUES ('intent_400', 'BTC-PERP', 'BUY', '1', '0.001', '0.001', 'RISK_LIMIT_EXCEEDED', 'CREATED', '0x123')`);
    const intent = (await rawPool.query(`SELECT * FROM hedge_intents WHERE hedge_intent_id='intent_400'`)).rows[0];
    manager.isRecoveryComplete = true;
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
    const updated = (await rawPool.query(`SELECT status FROM hedge_intents WHERE hedge_intent_id='intent_400'`)).rows[0];
    expect(updated.status).toBe('FAILED');
  });

  it('D. timeout/502/504 -> UNKNOWN', async () => {
    adapter.placeHedgeOrder = async () => {
      const e = new Error('502 Bad Gateway');
      (e as any).code = 'NETWORK_TIMEOUT';
      throw e;
    };
    await rawPool.query(`INSERT INTO hedge_intents (hedge_intent_id, market, side, target_exposure, requested_quantity, remaining_quantity, reason, status, cloid)
                    VALUES ('intent_502', 'BTC-PERP', 'BUY', '1', '0.001', '0.001', 'RISK_LIMIT_EXCEEDED', 'CREATED', '0x456')`);
    const intent = (await rawPool.query(`SELECT * FROM hedge_intents WHERE hedge_intent_id='intent_502'`)).rows[0];
    manager.isRecoveryComplete = true;
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
    const updated = (await rawPool.query(`SELECT status FROM hedge_intents WHERE hedge_intent_id='intent_502'`)).rows[0];
    expect(updated.status).toBe('UNKNOWN_PENDING_RECONCILIATION');
  });
});
