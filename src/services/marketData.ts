import { tradingPairRegistry } from './market/TradingPairRegistry';
import { MarketPair } from '../types';
import { mockMarkets } from '../mockData';
import { tickerService } from './market/TickerService';

let initialized = false;

export async function fetchMarketData(): Promise<MarketPair[]> {
  try {
    if (!initialized) {
      initialized = true;
      await tradingPairRegistry.loadTop200();
    }

    // Attempt to fetch from Binance to guarantee fresh data for legacy callers
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1500);
    let fapiRes: any = null;
    let apiRes: any = null;
    try {
      [fapiRes, apiRes] = await Promise.all([
        fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', { signal: controller.signal }).catch(() => null),
        fetch('https://api.binance.com/api/v3/ticker/24hr', { signal: controller.signal }).catch(() => null)
      ]);
    } finally {
      clearTimeout(timeoutId);
    }

    const data: any[] = [];
    if (fapiRes && fapiRes.ok) {
      const fapi = await fapiRes.json();
      if (Array.isArray(fapi)) data.push(...fapi.map((d: any) => ({...d, _market: 'FUTURES'})));
    }
    if (apiRes && apiRes.ok) {
      const api = await apiRes.json();
      if (Array.isArray(api)) data.push(...api.map((d: any) => ({...d, _market: 'SPOT'})));
    }

    if (data.length === 0) throw new Error("No data returned");

    const pairs = tradingPairRegistry.getAllPairs();
    const result: MarketPair[] = [];

    pairs.forEach(pair => {
      const apiSymbol = pair.apiSymbol || pair.symbol;
      const binanceItem = data.find(d => d.symbol === apiSymbol && d._market === pair.marketType);
      
      if (binanceItem) {
        result.push({
          id: pair.symbol, // Important: use our internal symbol
          baseAsset: pair.baseAsset,
          quoteAsset: pair.quoteAsset,
          price: parseFloat(binanceItem.lastPrice),
          priceStr: binanceItem.lastPrice,
          change24h: parseFloat(binanceItem.priceChangePercent),
          volume: parseFloat(binanceItem.quoteVolume),
          high24h: parseFloat(binanceItem.highPrice),
          low24h: parseFloat(binanceItem.lowPrice),
        });
      }
    });

    return result;
  } catch (error) {
    console.warn('Failed to fetch real market data, falling back to TickerService or mock data:', error);
    
    const tickers = tickerService.getAllTickers();
    if (tickers.length > 0) {
      return tickers.map(t => {
        const pair = tradingPairRegistry.getPair(t.symbol);
        return {
          id: t.symbol,
          baseAsset: pair ? pair.baseAsset : t.symbol.replace('USDT', ''),
          quoteAsset: pair ? pair.quoteAsset : 'USDT',
          price: parseFloat(t.lastPrice),
          priceStr: t.lastPrice,
          change24h: parseFloat(t.priceChangePercent),
          volume: parseFloat(t.quoteVolume24h),
          high24h: parseFloat(t.high24h),
          low24h: parseFloat(t.low24h)
        };
      });
    }

    return mockMarkets.map(m => ({
      ...m,
      id: `${m.baseAsset}${m.quoteAsset}`,
      priceStr: m.price.toString(),
      high24h: m.price * 1.05,
      low24h: m.price * 0.95
    }));
  }
}
