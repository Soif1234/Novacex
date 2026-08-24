import { tradingPairRegistry } from './market/TradingPairRegistry';
import { MarketPair } from '../types';
import { apiClient } from './api/client';

let initialized = false;

/**
 * Fetch the market list from the authoritative backend (`/market/tickers`).
 *
 * There is NO external market-data provider and NO synthetic/mock price fallback:
 * if the backend is unavailable the function returns an empty list so the UI reflects
 * a real outage rather than fabricated prices.
 */
export async function fetchMarketData(): Promise<MarketPair[]> {
  if (!initialized) {
    initialized = true;
    await tradingPairRegistry.loadTop200();
  }

  try {
    const res = await apiClient.get<{ tickers: any[] }>('/market/tickers');
    const tickers = (res && (res as any).tickers)
      ? (res as any).tickers
      : (Array.isArray(res) ? (res as any) : []);

    const bySymbol = new Map<string, any>();
    for (const t of tickers) {
      if (t && t.symbol) {
        const clean = String(t.symbol).toUpperCase();
        bySymbol.set(clean, t);
        tradingPairRegistry.registerPairFromTicker(clean, t.lastPrice);
      }
    }

    const pairs = tradingPairRegistry.getAllPairs();
    const result: MarketPair[] = [];
    const seen = new Set<string>();

    for (const pair of pairs) {
      if (seen.has(pair.symbol)) continue;
      const t = bySymbol.get((pair.apiSymbol || pair.symbol).toUpperCase());
      if (!t) continue;
      seen.add(pair.symbol);
      result.push({
        id: pair.symbol,
        baseAsset: pair.baseAsset,
        quoteAsset: pair.quoteAsset,
        price: parseFloat(t.lastPrice),
        priceStr: String(t.lastPrice),
        change24h: parseFloat(t.priceChangePercent24h ?? t.priceChangePercent ?? '0'),
        volume: parseFloat(t.quoteVolume24h ?? '0'),
        high24h: parseFloat(t.high24h ?? '0'),
        low24h: parseFloat(t.low24h ?? '0'),
      });
    }

    return result;
  } catch (error) {
    console.warn('Failed to fetch market data from backend:', error);
    return [];
  }
}
