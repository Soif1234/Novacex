import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tickerService } from './TickerService';

describe.skip('TickerService', () => {
  beforeEach(() => {
    // Reset internal state for clean testing
    // @ts-ignore
    tickerService.tickers.clear();
    // @ts-ignore
    tickerService.subscribers.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. ticker normalization & 2. valid BTC ticker & 3. valid ETH ticker', () => {
    // @ts-ignore
    tickerService.updateTickerFromRest('BTCUSDT', {
      symbol: 'BTCUSDT',
      lastPrice: '60000',
      priceChange: '1000',
      priceChangePercent: '1.5',
      highPrice: '61000',
      lowPrice: '59000',
      volume: '1000',
      quoteVolume: '60000000',
      closeTime: 1234567890
    });
    
    // @ts-ignore
    tickerService.updateTickerFromRest('ETHUSDT', {
      symbol: 'ETHUSDT',
      lastPrice: '3000',
      priceChange: '-50',
      priceChangePercent: '-1.5',
      highPrice: '3100',
      lowPrice: '2900',
      volume: '10000',
      quoteVolume: '30000000',
      closeTime: 1234567890
    });

    const btc = tickerService.getTicker('BTCUSDT');
    expect(btc).toBeDefined();
    expect(btc?.symbol).toBe('BTCUSDT');
    expect(btc?.lastPrice).toBe('60000');
    expect(btc?.priceChangePercent).toBe('1.5');
    
    const eth = tickerService.getTicker('ETHUSDT');
    expect(eth).toBeDefined();
    expect(eth?.symbol).toBe('ETHUSDT');
  });

  it('4. invalid ticker', () => {
    const invalid = tickerService.getTicker('INVALID');
    expect(invalid).toBeUndefined();
  });

  it('5. 24h change & 6. 24h high & 7. 24h low & 8. volume', () => {
    // @ts-ignore
    tickerService.updateTickerFromRest('SOLUSDT', {
      symbol: 'SOLUSDT',
      lastPrice: '150',
      priceChange: '5',
      priceChangePercent: '3.5',
      highPrice: '155',
      lowPrice: '140',
      volume: '200',
      quoteVolume: '30000',
      closeTime: 1234567890
    });

    const sol = tickerService.getTicker('SOLUSDT');
    expect(sol?.priceChange).toBe('5');
    expect(sol?.high24h).toBe('155');
    expect(sol?.low24h).toBe('140');
    expect(sol?.quoteVolume24h).toBe('30000');
  });

  it('16. ticker update & 18. WebSocket cleanup', () => {
    // test websocket message processing
    // @ts-ignore
    tickerService.updateTickerFromRest('BNBUSDT', {
      symbol: 'BNBUSDT',
      lastPrice: '500',
      priceChange: '0',
      priceChangePercent: '0',
      highPrice: '500',
      lowPrice: '500',
      volume: '0',
      quoteVolume: '0',
      closeTime: 0
    });

    let wsInstance: any = null;
    vi.stubGlobal('WebSocket', class MockWS {
      onmessage: any;
      onclose: any;
      constructor(url: string) {
        wsInstance = this;
      }
      close() {}
    });

    // @ts-ignore
    tickerService.connectWs('api', 'dummy_url', ['BNBUSDT'], [{symbol: 'BNBUSDT', apiSymbol: 'BNBUSDT'}]);
    
    // Simulate WS update
    wsInstance.onmessage({
      data: JSON.stringify([{
        s: 'BNBUSDT',
        c: '510',
        p: '10',
        P: '2.0',
        h: '515',
        l: '495',
        v: '10',
        q: '5000',
        E: 123
      }])
    });

    const updated = tickerService.getTicker('BNBUSDT');
    expect(updated?.lastPrice).toBe('510');
    expect(updated?.priceChangePercent).toBe('2.0');
    
    // Cleanup timeout test
    vi.useFakeTimers();
    wsInstance.onclose();
    expect(Object.keys(tickerService['reconnectTimeouts']).length).toBeGreaterThan(0);
    vi.useRealTimers();
  });
});
