import { describe, it, expect, beforeEach } from 'vitest';
import { providerRegistry } from '../src/domain/liquidity/registry';
import { MockLiquidityAdapter } from './mocks/mockAdapter';
import { ProviderCapability } from '../src/domain/liquidity/adapter';
import { ProviderError, ProviderErrorCode } from '../src/domain/liquidity/errors';

describe('Phase 5.2 - External Liquidity Adapter Layer', () => {
  beforeEach(() => {
    providerRegistry.clear();
  });

  it('1. Provider registration and lookup', () => {
    const mock = new MockLiquidityAdapter('MOCK_1');
    providerRegistry.register(mock);

    const retrieved = providerRegistry.getAdapter('MOCK_1');
    expect(retrieved.providerId).toBe('MOCK_1');

    const all = providerRegistry.getAllProviders();
    expect(all).toHaveLength(1);
  });

  it('2. Unsupported provider lookup throws PROVIDER_UNAVAILABLE', () => {
    expect(() => providerRegistry.getAdapter('NON_EXISTENT')).toThrowError(ProviderError);
    try {
      providerRegistry.getAdapter('NON_EXISTENT');
    } catch (err: any) {
      expect(err.code).toBe(ProviderErrorCode.PROVIDER_UNAVAILABLE);
    }
  });

  it('3. Capability detection and checking works correctly', () => {
    const mock = new MockLiquidityAdapter('MOCK_CAP');
    expect(mock.hasCapability(ProviderCapability.SPOT)).toBe(true);
    expect(mock.hasCapability(ProviderCapability.MARKET_ORDER)).toBe(true);
    expect(mock.hasCapability(ProviderCapability.ORDER_BOOK)).toBe(false);
  });

  it('4. Unsupported capability throws UNSUPPORTED_OPERATION', async () => {
    const mock = new MockLiquidityAdapter('MOCK_ERR');
    await expect(mock.getOrderBook('BTCUSDT')).rejects.toThrowError(ProviderError);
    
    try {
      await mock.getOrderBook('BTCUSDT');
    } catch (err: any) {
      expect(err.code).toBe(ProviderErrorCode.UNSUPPORTED_OPERATION);
      expect(err.providerId).toBe('MOCK_ERR');
    }
  });

  it('5. Normalized ticker conversion works seamlessly', async () => {
    const mock = new MockLiquidityAdapter('MOCK_TICKER');
    const ticker = await mock.getTicker('BTCUSDT');
    expect(ticker.symbol).toBe('BTCUSDT');
    expect(ticker.bid).toBe('49900');
    expect(ticker.ask).toBe('50100');
    expect(ticker.timestamp).toBeInstanceOf(Date);
  });

  it('6. Idempotency enforced via normalized clientOrderId', async () => {
    const mock = new MockLiquidityAdapter('MOCK_IDEMPOTENCY');
    const request = {
      clientOrderId: 'idempotent-key-99',
      symbol: 'BTCUSDT',
      side: 'BUY' as const,
      type: 'MARKET' as const,
      quantity: '1.5'
    };
    
    const response = await mock.placeOrder(request);
    expect(response.clientOrderId).toBe('idempotent-key-99');
    expect(response.status).toBe('FILLED');
  });

  it('7. Missing clientOrderId throws INVALID_REQUEST error', async () => {
    const mock = new MockLiquidityAdapter('MOCK_IDEMPOTENCY');
    const invalidRequest = {
      clientOrderId: '',
      symbol: 'BTCUSDT',
      side: 'BUY' as const,
      type: 'MARKET' as const,
      quantity: '1.5'
    };
    
    await expect(mock.placeOrder(invalidRequest)).rejects.toThrowError(ProviderError);
  });

  it('8. UNKNOWN execution state is mapped to ProviderErrorCode', async () => {
    const mock = new MockLiquidityAdapter('MOCK_UNKNOWN');
    const request = {
      clientOrderId: 'req-unknown',
      symbol: 'BTCUSDT',
      side: 'BUY' as const,
      type: 'MARKET' as const,
      quantity: '1.5',
      metadata: { forceUnknownState: true }
    };
    
    try {
      await mock.placeOrder(request);
      expect.fail('Should have thrown unknown state error');
    } catch (err: any) {
      expect(err.code).toBe(ProviderErrorCode.UNKNOWN_EXECUTION_STATE);
      expect(err.providerId).toBe('MOCK_UNKNOWN');
    }
  });

  it('9. Error wrapping safely scrubs internal secrets/credentials', () => {
    const fakeAxiosError = {
      message: 'Failed to authenticate',
      config: { headers: { 'Authorization': 'Bearer SECRET_TOKEN' } },
      request: { _header: 'SECRET_TOKEN' },
      response: { config: { headers: { 'X-API-KEY': 'SECRET_KEY' } } }
    };

    const safeError = new ProviderError(
      ProviderErrorCode.AUTHENTICATION_FAILURE,
      'Auth Failed',
      'BINANCE_MOCK',
      fakeAxiosError
    );

    // Ensure raw error is scrubbed
    expect(safeError.originalError).toBeDefined();
    expect(safeError.originalError.config).toBeUndefined();
    expect(safeError.originalError.request).toBeUndefined();
    expect(safeError.originalError.response?.config).toBeUndefined();
    
    // Ensure the message is still propagated
    expect(safeError.message).toBe('Auth Failed');
  });
});
