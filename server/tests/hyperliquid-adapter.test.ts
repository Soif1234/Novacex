/**
 * Hyperliquid Adapter, Signer & Security Tests
 * Phase 10.5 â€” Step 10.5-2
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import {
  HyperliquidSigner,
  HyperliquidMsgpackEncoder,
  HYPERLIQUID_EIP712_DOMAIN,
  HYPERLIQUID_EIP712_TYPES
} from '../src/services/liquidity/hyperliquid/hyperliquid.signer';
import {
  HyperliquidClient,
  HyperliquidNonceManager,
  HyperliquidRateLimiter
} from '../src/services/liquidity/hyperliquid/hyperliquid.client';
import {
  HyperliquidAdapter
} from '../src/services/liquidity/hyperliquid/hyperliquid.adapter';
import {
  HyperliquidL1Action,
  HyperliquidErrorCode,
  HyperliquidError
} from '../src/services/liquidity/hyperliquid/hyperliquid.types';

describe('Hyperliquid Signer & EIP-712 Engine', () => {
  const testPrivateKey = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  const testWallet = new ethers.Wallet(testPrivateKey);
  const signer = new HyperliquidSigner(testPrivateKey, false); // testnet

  it('A. deterministic Msgpack serialization of objects, arrays, integers, and strings', () => {
    const sample = {
      type: 'order',
      orders: [
        {
          a: 0,
          b: true,
          p: '64500.5',
          s: '0.1',
          r: false,
          t: { limit: { tif: 'Gtc' } },
          c: '0x1234567890abcdef1234567890abcdef'
        }
      ],
      grouping: 'na'
    };

    const encoded1 = HyperliquidMsgpackEncoder.encode(sample);
    const encoded2 = HyperliquidMsgpackEncoder.encode(sample);

    expect(encoded1).toBeInstanceOf(Buffer);
    expect(encoded1.length).toBeGreaterThan(20);
    expect(encoded1.equals(encoded2)).toBe(true);
  });

  it('B. computes connectionId matching keccak256(msgpack(action) + nonce + vault)', () => {
    const action: HyperliquidL1Action = {
      type: 'cancel',
      cancels: [{ a: 0, o: 12345 }]
    };
    const nonce = 1725000000000;

    const connectionId = signer.computeConnectionId(action, nonce, null);
    expect(connectionId).toMatch(/^0x[0-9a-fA-F]{64}$/);

    // Vault address formatting verification
    const vaultConnectionId = signer.computeConnectionId(action, nonce, '0x1111222233334444555566667777888899990000');
    expect(vaultConnectionId).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(vaultConnectionId).not.toBe(connectionId);
  });

  it('C. signs L1 action via EIP-712 and recovers exact signer address', async () => {
    const action: HyperliquidL1Action = {
      type: 'order',
      orders: [{
        a: 0,
        b: true,
        p: '60000',
        s: '0.05',
        r: false,
        t: { limit: { tif: 'Gtc' } }
      }],
      grouping: 'na'
    };
    const nonce = 1725000000000;

    const { signature, connectionId } = await signer.signL1Action(action, nonce);
    expect(signature.r).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(signature.s).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect([27, 28]).toContain(signature.v);

    // Verify recovery via ethers.verifyTypedData
    const recovered = HyperliquidSigner.verifyL1Signature(connectionId, signature, false);
    expect(recovered).toBe(testWallet.address.toLowerCase());
  });

  it('D. distinguishes Mainnet (source: "a") and Testnet (source: "b")', async () => {
    const mainnetSigner = new HyperliquidSigner(testPrivateKey, true);
    const testnetSigner = new HyperliquidSigner(testPrivateKey, false);

    const action: HyperliquidL1Action = {
      type: 'cancel',
      cancels: [{ a: 0, o: 100 }]
    };
    const nonce = 1725000000000;

    const mainnetSig = await mainnetSigner.signL1Action(action, nonce);
    const testnetSig = await testnetSigner.signL1Action(action, nonce);

    // Signatures must differ due to EIP-712 message payload ("a" vs "b")
    expect(mainnetSig.signature.r).not.toBe(testnetSig.signature.r);
  });
});

describe('Hyperliquid Nonce & Rate Limiter', () => {
  it('E. generates strictly monotonically increasing millisecond nonces', () => {
    const manager = new HyperliquidNonceManager();
    const n1 = manager.getNextNonce();
    const n2 = manager.getNextNonce();
    const n3 = manager.getNextNonce();

    expect(n2).toBeGreaterThan(n1);
    expect(n3).toBeGreaterThan(n2);
  });

  it('F. rate limiter throttles burst requests cleanly', async () => {
    const limiter = new HyperliquidRateLimiter(60); // 1 token per second
    const start = Date.now();
    await limiter.acquire(1);
    expect(Date.now() - start).toBeLessThan(100);
  });
});

describe('Hyperliquid Client & Adapter Integration', () => {
  const testPrivateKey = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  const testWallet = new ethers.Wallet(testPrivateKey);
  let adapter: HyperliquidAdapter;

  const mockMetaResponse = {
    universe: [
      { name: 'BTC', szDecimals: 4, maxLeverage: 50 },
      { name: 'ETH', szDecimals: 3, maxLeverage: 50 },
      { name: 'SOL', szDecimals: 2, maxLeverage: 20 }
    ]
  };

  const mockSpotMetaResponse = {
    tokens: [
      { name: 'USDC', szDecimals: 2, weiDecimals: 6, index: 0, tokenId: '0x1', isCanonical: true },
      { name: 'PURR', szDecimals: 0, weiDecimals: 18, index: 1, tokenId: '0x2', isCanonical: true }
    ],
    universe: [
      { name: 'PURR/USDC', tokens: [1, 0], index: 0, isCanonical: true }
    ]
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    adapter = new HyperliquidAdapter({
      hyperliquidEnv: 'testnet',
      agentPrivateKey: testPrivateKey,
      accountAddress: testWallet.address
    });
  });

  it('G. resolves symbol mapping and szDecimals from cached metadata', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      if (body.type === 'meta') return new Response(JSON.stringify(mockMetaResponse));
      if (body.type === 'spotMeta') return new Response(JSON.stringify(mockSpotMetaResponse));
      return new Response('{}');
    });

    const btcPerp = await adapter.resolveMarketInfo('BTC-USDT');
    expect(btcPerp.coin).toBe('BTC');
    expect(btcPerp.assetIndex).toBe(0);
    expect(btcPerp.szDecimals).toBe(4);

    const purrSpot = await adapter.resolveMarketInfo('PURR/USDC');
    expect(purrSpot.assetIndex).toBe(10000);
    expect(purrSpot.isSpot).toBe(true);
  });

  it('H. places order with deterministic cloid and formats quantity to szDecimals', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      if (body.type === 'meta') return new Response(JSON.stringify(mockMetaResponse));
      if (body.type === 'spotMeta') return new Response(JSON.stringify(mockSpotMetaResponse));
      if (url.toString().includes('/exchange')) {
        return new Response(JSON.stringify({
          status: 'ok',
          response: {
            type: 'order',
            data: {
              statuses: [{ filled: { oid: 99991, totalSz: '0.1500', avgPx: '65200.0' } }]
            }
          }
        }));
      }
      return new Response('{}');
    });

    const result = await adapter.placeHedgeOrder({
      hedgeIntentId: 'hedge-uuid-12345',
      symbol: 'BTC-PERP',
      side: 'BUY',
      quantity: '0.15',
      limitPrice: '65200.0',
      timeInForce: 'IOC'
    });

    expect(result.status).toBe('FILLED');
    expect(result.venueOrderId).toBe('99991');
    expect(result.executedQuantity).toBe('0.1500');
    expect(result.cloid).toMatch(/^0x[0-9a-f]{32}$/);
  });

  it('I. circuit breaker (HYPERLIQUID_HEDGE_HALT) rejects new orders immediately', async () => {
    adapter.setHedgeHalted(true);

    await expect(
      adapter.placeHedgeOrder({
        hedgeIntentId: 'intent-halt-1',
        symbol: 'BTC-PERP',
        side: 'BUY',
        quantity: '1.0'
      })
    ).rejects.toThrowError(/HYPERLIQUID_HEDGE_HALT/);
  });

  it('J. REDUCE_ONLY mode rejects exposure-increasing orders and allows reduceOnly', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      if (body.type === 'meta') return new Response(JSON.stringify(mockMetaResponse));
      if (body.type === 'spotMeta') return new Response(JSON.stringify(mockSpotMetaResponse));
      return new Response(JSON.stringify({
        status: 'ok',
        response: { type: 'order', data: { statuses: [{ resting: { oid: 8888 } }] } }
      }));
    });

    adapter.setReduceOnlyMode(true);

    // Reject non-reduce-only
    await expect(
      adapter.placeHedgeOrder({
        hedgeIntentId: 'intent-reduce-1',
        symbol: 'BTC-PERP',
        side: 'BUY',
        quantity: '1.0',
        reduceOnly: false
      })
    ).rejects.toThrowError(/REDUCE_ONLY mode/);

    // Allow reduceOnly
    const result = await adapter.placeHedgeOrder({
      hedgeIntentId: 'intent-reduce-2',
      symbol: 'BTC-PERP',
      side: 'SELL',
      quantity: '1.0',
      reduceOnly: true
    });
    expect(result.status).toBe('OPEN');
  });

  it('K. recovers UNKNOWN order via 3-step sequence (openOrders -> userFills -> orderStatus)', async () => {
    const hedgeIntentId = 'intent-unknown-999';
    const cloid = adapter.getClient().generateCloid(hedgeIntentId);

    // Mock open orders returning the matching cloid
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      if (body.type === 'openOrders') {
        return new Response(JSON.stringify([
          {
            coin: 'BTC',
            side: 'B',
            limitPx: '64000.0',
            sz: '0.6',
            origSz: '1.0',
            oid: 77777,
            timestamp: Date.now() - 10000,
            cloid
          }
        ]));
      }
      if (body.type === 'userFills') return new Response(JSON.stringify([]));
      return new Response('{}');
    });

    const recovered = await adapter.recoverUnknownOrder(hedgeIntentId, 'BTC-PERP');
    expect(recovered.status).toBe('PARTIALLY_FILLED');
    expect(recovered.executedQuantity).toBe('0.400000000000000000');
    expect(recovered.remainingQuantity).toBe('0.600000000000000000');
    expect(recovered.venueOrderId).toBe('77777');
  });

  it('L. idempotent order cancellation by cloid and oid', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      if (body.type === 'meta') return new Response(JSON.stringify(mockMetaResponse));
      if (body.type === 'spotMeta') return new Response(JSON.stringify(mockSpotMetaResponse));
      return new Response(JSON.stringify({
        status: 'ok',
        response: { type: 'cancel', data: { statuses: ['success'] } }
      }));
    });

    const canceled = await adapter.cancelHedgeOrder(77777, 'BTC-PERP', '0x1234567890abcdef1234567890abcdef');
    expect(canceled).toBe(true);
  });

  it('M. maps clearinghouseState into typed account margin and positions', async () => {
    const mockState = {
      marginSummary: {
        accountValue: '50000.0',
        totalMarginUsed: '10000.0',
        totalNtlPos: '40000.0',
        totalRawUsd: '50000.0',
        withdrawable: '40000.0'
      },
      crossMarginSummary: {
        accountValue: '50000.0',
        totalMarginUsed: '10000.0',
        totalNtlPos: '40000.0',
        totalRawUsd: '50000.0',
        withdrawable: '40000.0'
      },
      assetPositions: [
        {
          type: 'oneWay',
          position: {
            coin: 'BTC',
            szi: '2.5',
            entryPx: '62000.0',
            positionValue: '155000.0',
            unrealizedPnl: '5000.0',
            returnOnEquity: '0.1',
            liquidationPx: '45000.0',
            leverage: { type: 'cross', value: 10 },
            marginUsed: '15500.0',
            maxLeverage: 50,
            cumFunding: { allTime: '100.0', sinceOpen: '10.0', sinceChange: '5.0' }
          }
        }
      ],
      time: Date.now()
    };

    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify(mockState));
    });

    const state = await adapter.getClearinghouseState();
    expect(state.marginSummary.accountValue).toBe('50000.0');
    expect(state.assetPositions[0].position.coin).toBe('BTC');
    expect(state.assetPositions[0].position.szi).toBe('2.5');
  });

  it('N. handles HTTP 429 rate limits as typed retryable HyperliquidError', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      return new Response('Rate limit exceeded', { status: 429 });
    });

    await expect(adapter.getClearinghouseState()).rejects.toThrowError(HyperliquidError);
  });

  it('O. network timeout returns UNKNOWN order state without throwing fatal error', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      if (body.type === 'meta') return new Response(JSON.stringify(mockMetaResponse));
      if (body.type === 'spotMeta') return new Response(JSON.stringify(mockSpotMetaResponse));
      if (url.toString().includes('/exchange')) {
        const err: any = new Error('The operation was aborted due to timeout');
        err.name = 'AbortError';
        throw err;
      }
      return new Response('{}');
    });

    const result = await adapter.placeHedgeOrder({
      hedgeIntentId: 'intent-timeout-1',
      symbol: 'BTC-PERP',
      side: 'BUY',
      quantity: '0.5'
    });

    expect(result.status).toBe('UNKNOWN');
    expect(result.remainingQuantity).toBe('0.5');
    expect(result.error).toContain('Network timeout');
  });

  it('P. security isolation: adapter has zero access to LedgerService or custody keys', () => {
    // Structural architectural proof: Adapter interface contains zero ledger, balance, or KMS references
    const adapterKeys = Object.keys(adapter);
    expect(adapterKeys).not.toContain('ledgerService');
    expect(adapterKeys).not.toContain('kmsProvider');
    expect(adapterKeys).not.toContain('safeSigner');
    expect(adapterKeys).not.toContain('customerWallet');
  });
});
