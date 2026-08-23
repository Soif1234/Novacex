import { describe, it, expect, vi } from 'vitest';
import { FuturesMarketService } from './FuturesMarketService';

// Mock the network call from the underlying spot market data
vi.mock('../marketData', () => ({
  fetchMarketData: vi.fn().mockResolvedValue([
    { baseAsset: 'BTC', quoteAsset: 'USDT', price: 60000, priceStr: '60000', change24h: 2.5, volume: 1000 },
    { baseAsset: 'ETH', quoteAsset: 'USDT', price: 3000, priceStr: '3000', change24h: -1.2, volume: 5000 },
  ])
}));

describe.skip('FuturesMarketService', () => {
  const service = new FuturesMarketService();

  it('should validate valid symbols', () => {
    expect(service.isValidSymbol('BTCUSDT')).toBe(true);
    expect(service.isValidSymbol('ETHUSDT')).toBe(true);
    expect(service.isValidSymbol('SOLUSDT')).toBe(true);
    expect(service.isValidSymbol('XRPUSDT')).toBe(true);
    expect(service.isValidSymbol('DOGEUSDT')).toBe(true);
  });

  it('should reject invalid symbols', () => {
    expect(service.isValidSymbol('INVALID')).toBe(false);
    expect(service.isValidSymbol('BTCUSD')).toBe(false); // Only USDT quoted in config
    expect(service.isValidSymbol('')).toBe(false);
  });

  it('should return correct market configuration', () => {
    const btcConfig = service.getMarketConfig('BTCUSDT');
    expect(btcConfig).not.toBeNull();
    expect(btcConfig?.symbol).toBe('BTCUSDT');
    expect(btcConfig?.baseAsset).toBe('BTC');
    expect(btcConfig?.quoteAsset).toBe('USDT');
    expect(btcConfig?.maximumLeverage).toBe(125);
    expect(btcConfig?.maintenanceMarginRate).toBe('0.005');
  });

  it('should enforce proper precision values in config', () => {
    const ethConfig = service.getMarketConfig('ETHUSDT');
    expect(ethConfig).not.toBeNull();
    
    // tickSize should be string
    expect(typeof ethConfig?.tickSize).toBe('string');
    expect(ethConfig?.tickSize).toBe('0.01');

    // quantityPrecision should be a number
    expect(typeof ethConfig?.quantityPrecision).toBe('number');
    expect(ethConfig?.quantityPrecision).toBe(3);

    // minimumQuantity should be a string
    expect(typeof ethConfig?.minimumQuantity).toBe('string');
    expect(ethConfig?.minimumQuantity).toBe('0.01');
  });

  it('should fetch merged live market data', async () => {
    const markets = await service.getMarkets();
    expect(markets.length).toBe(6); // 5 statically configured markets
    
    const btcMarket = markets.find(m => m.symbol === 'BTCUSDT');
    expect(btcMarket).not.toBeUndefined();
    // From mock
    expect(btcMarket?.lastPrice).toBe('60000');
    expect(btcMarket?.markPrice).toBe('60000');
    expect(btcMarket?.change24h).toBe('2.5');
    // Static
    expect(btcMarket?.tickSize).toBe('0.10');
    expect(btcMarket?.maximumLeverage).toBe(125);
  });

  it('should fetch single live market by symbol', async () => {
    const btcMarket = await service.getMarket('BTCUSDT');
    expect(btcMarket).not.toBeNull();
    expect(btcMarket?.symbol).toBe('BTCUSDT');
    expect(btcMarket?.markPrice).toBe('60000');

    const invalidMarket = await service.getMarket('UNKNOWN');
    expect(invalidMarket).toBeNull();
  });
});
