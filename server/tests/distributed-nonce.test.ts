import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HyperliquidNonceManager } from '../src/services/liquidity/hyperliquid/hyperliquid.client';

describe('HyperliquidNonceManager (P3-1 Distributed Nonce)', () => {
  it('should generate monotonic nonces without Redis (fallback)', async () => {
    const manager = new HyperliquidNonceManager();
    const n1 = await manager.getNextNonce();
    const n2 = await manager.getNextNonce();
    const n3 = await manager.getNextNonce();

    expect(n1).toBeGreaterThan(0);
    expect(n2).toBeGreaterThan(n1);
    expect(n3).toBeGreaterThan(n2);
  });

  it('should use Redis Lua script if Redis is provided', async () => {
    const mockRedis: any = {
      eval: vi.fn().mockResolvedValue('1700000000000')
    };

    const manager = new HyperliquidNonceManager(mockRedis, '0xAgent');
    const nonce = await manager.getNextNonce();

    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
    expect(nonce).toBe(1700000000000);

    // Verify script structure
    const callArgs = mockRedis.eval.mock.calls[0];
    expect(callArgs[0]).toContain('redis.call(\'set\', KEYS[1], now)');
    expect(callArgs[2]).toBe('hyperliquid:nonce:0xagent');
  });
});
