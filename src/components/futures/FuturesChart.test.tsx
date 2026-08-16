import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
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
    ColorType: { Solid: 'Solid' }
  };
});

describe('FuturesChart Symbol Switching', () => {
  let wsInstances: any[] = [];
  
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', class MockWS {
      url: string;
      constructor(url: string) {
        this.url = url;
        wsInstances.push(this);
      }
      close() {
        this.url += '_CLOSED';
      }
    });
    
    // Mock fetch
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([])
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    wsInstances = [];
  });

  it('4. Chart symbol update & 5. WebSocket cleanup & 16. Rapid pair switching', async () => {
    const { rerender } = render(<FuturesChart market={{ symbol: 'BTCUSDT' } as any} />);
    
    // Wait for fetch and WS
    await act(async () => {
      vi.runAllTimers();
      await Promise.resolve();
    });
    
    expect(wsInstances.length).toBe(1);
    expect(wsInstances[0].url).toContain('btcusdt@kline');
    
    // Switch to ETH
    rerender(<FuturesChart market={{ symbol: 'ETHUSDT' } as any} />);
    
    await act(async () => {
      vi.runAllTimers();
      await Promise.resolve();
    });
    
    expect(wsInstances.length).toBe(2);
    expect(wsInstances[0].url).toContain('CLOSED'); // First WS should be closed
    expect(wsInstances[1].url).toContain('ethusdt@kline'); // New WS
    
    // Switch to SOL
    rerender(<FuturesChart market={{ symbol: 'SOLUSDT' } as any} />);
    
    await act(async () => {
      vi.runAllTimers();
      await Promise.resolve();
    });
    
    expect(wsInstances.length).toBe(3);
    expect(wsInstances[1].url).toContain('CLOSED');
    expect(wsInstances[2].url).toContain('solusdt@kline');
    expect(wsInstances[2].url).not.toContain('CLOSED');
  });
});
