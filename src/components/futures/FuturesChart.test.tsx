import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { FuturesChart } from './FuturesChart';

// Mock lightweight-charts
vi.mock('lightweight-charts', () => {
  const mockSeries = {
    setData: vi.fn(),
    update: vi.fn(),
  };
  const mockChart = {
    addCandlestickSeries: vi.fn(() => mockSeries),
    timeScale: vi.fn(() => ({ fitContent: vi.fn() })),
    applyOptions: vi.fn(),
    remove: vi.fn(),
  };
  return {
    createChart: vi.fn(() => mockChart),
    ColorType: { Solid: 'Solid' },
  };
});

// Historical klines come from the authoritative backend REST (empty in this test).
vi.mock('../../services/api/client', () => ({
  apiClient: { get: vi.fn().mockResolvedValue([]) },
}));

// Capture backend WebSocket kline subscriptions + their unsubscribe handles.
const subscriptions: string[] = [];
const unsubSpies: Array<ReturnType<typeof vi.fn>> = [];
vi.mock('../../services/websocket/wsClient', () => ({
  wsClient: {
    subscribe: vi.fn((channel: string) => {
      subscriptions.push(channel);
      const unsub = vi.fn();
      unsubSpies.push(unsub);
      return unsub;
    }),
  },
}));

describe('FuturesChart backend kline subscription & symbol switching', () => {
  beforeEach(() => {
    subscriptions.length = 0;
    unsubSpies.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const flush = async () => {
    // Flush the async loadDataAndConnect() chain (await apiClient.get -> subscribe).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it('subscribes to the backend kline channel per symbol and never uses Binance', async () => {
    render(<FuturesChart market={{ symbol: 'BTCUSDT' } as any} />);
    await flush();

    expect(subscriptions.length).toBe(1);
    expect(subscriptions[0]).toMatch(/^kline:(futures|spot):btcusdt:(1m|5m|1h|1d)$/);
    expect(subscriptions[0]).not.toContain('binance');
  });

  it('unsubscribes the previous channel and resubscribes on symbol switch', async () => {
    const { rerender } = render(<FuturesChart market={{ symbol: 'BTCUSDT' } as any} />);
    await flush();
    expect(subscriptions.length).toBe(1);

    rerender(<FuturesChart market={{ symbol: 'ETHUSDT' } as any} />);
    await flush();

    expect(unsubSpies[0]).toHaveBeenCalled(); // previous subscription cleaned up
    expect(subscriptions.length).toBe(2);
    expect(subscriptions[1]).toMatch(/^kline:(futures|spot):ethusdt:(1m|5m|1h|1d)$/);

    rerender(<FuturesChart market={{ symbol: 'SOLUSDT' } as any} />);
    await flush();

    expect(unsubSpies[1]).toHaveBeenCalled();
    expect(subscriptions.length).toBe(3);
    expect(subscriptions[2]).toMatch(/^kline:(futures|spot):solusdt:(1m|5m|1h|1d)$/);
  });
});
