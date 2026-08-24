import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, screen } from '@testing-library/react';
import { FuturesChart } from './FuturesChart';
import { apiClient } from '../../services/api/client';

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
    vi.clearAllMocks();
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
    render(<FuturesChart market={{ symbol: 'BTCUSDT' } as any} marketType="FUTURES" />);
    await flush();

    expect(subscriptions.length).toBe(1);
    expect(subscriptions[0]).toBe('kline:futures:btcusdt:5m');
    expect(subscriptions[0]).not.toContain('binance');
    expect(apiClient.get).toHaveBeenCalledWith('/market/klines', expect.objectContaining({
      market: 'FUTURES',
      symbol: 'BTCUSDT',
    }));
  });

  it('correctly resolves Spot market from market.id and marketType=SPOT', async () => {
    render(<FuturesChart market={{ id: 'BTCUSDT' } as any} marketType="SPOT" />);
    await flush();

    expect(subscriptions.length).toBe(1);
    expect(subscriptions[0]).toBe('kline:spot:btcusdt:5m');
    expect(apiClient.get).toHaveBeenCalledWith('/market/klines', expect.objectContaining({
      market: 'SPOT',
      symbol: 'BTCUSDT',
    }));
    expect(screen.getByText('Spot')).toBeTruthy();
  });

  it('unsubscribes the previous channel and resubscribes on symbol switch', async () => {
    const { rerender } = render(<FuturesChart market={{ symbol: 'BTCUSDT' } as any} marketType="FUTURES" />);
    await flush();
    expect(subscriptions.length).toBe(1);

    rerender(<FuturesChart market={{ symbol: 'ETHUSDT' } as any} marketType="FUTURES" />);
    await flush();

    expect(unsubSpies[0]).toHaveBeenCalled(); // previous subscription cleaned up
    expect(subscriptions.length).toBe(2);
    expect(subscriptions[1]).toBe('kline:futures:ethusdt:5m');

    rerender(<FuturesChart market={{ symbol: 'SOLUSDT' } as any} marketType="FUTURES" />);
    await flush();

    expect(unsubSpies[1]).toHaveBeenCalled();
    expect(subscriptions.length).toBe(3);
    expect(subscriptions[2]).toBe('kline:futures:solusdt:5m');
  });
});
