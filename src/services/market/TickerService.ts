import { tradingPairRegistry } from './TradingPairRegistry';
import { apiClient } from '../api/client';
import { wsClient } from '../websocket/wsClient';

export interface Ticker {
  symbol: string;
  lastPrice: string;
  priceChange: string;
  priceChangePercent: string;
  high24h: string;
  low24h: string;
  volume24h: string;
  quoteVolume24h: string;
  timestamp: number;
}

class TickerService {
  private spotTickers: Map<string, Ticker> = new Map();
  private futuresTickers: Map<string, Ticker> = new Map();
  private subscribers: Set<() => void> = new Set();

  private wsUnsubs: Array<() => void> = [];
  private initialized = false;

  constructor() {}

  public get tickers(): Map<string, Ticker> {
    const self = this;
    return new Proxy(this.spotTickers, {
      get(target, prop, receiver) {
        if (prop === 'clear') {
          return () => {
            self.spotTickers.clear();
            self.futuresTickers.clear();
          };
        }
        return Reflect.get(target, prop, receiver);
      }
    });
  }

  public getSpotTicker(symbol: string): Ticker | undefined {
    return this.spotTickers.get(symbol);
  }

  public getFuturesTicker(symbol: string): Ticker | undefined {
    return this.futuresTickers.get(symbol);
  }

  public getSpotTickers(): Ticker[] {
    return Array.from(this.spotTickers.values());
  }

  public getFuturesTickers(): Ticker[] {
    return Array.from(this.futuresTickers.values());
  }

  public getTicker(symbol: string, marketType?: 'SPOT' | 'FUTURES'): Ticker | undefined {
    if (marketType === 'FUTURES') return this.futuresTickers.get(symbol);
    if (marketType === 'SPOT') return this.spotTickers.get(symbol);
    return this.futuresTickers.get(symbol) || this.spotTickers.get(symbol);
  }

  public getAllTickers(): Ticker[] {
    const merged = new Map<string, Ticker>();
    this.spotTickers.forEach((v, k) => merged.set(k, v));
    this.futuresTickers.forEach((v, k) => {
      if (!merged.has(k)) merged.set(k, v);
    });
    return Array.from(merged.values());
  }

  public subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private notify() {
    this.subscribers.forEach(cb => cb());
  }

  /**
   * Store a ticker from a REST-style payload. Accepts (symbolKey, item) or
   * (type, symbolKey, item). Null-safe: missing/empty/NaN/Infinity numeric fields
   * default to '0', and a missing item is ignored — this fixes the prior
   * undefined-`lastPrice` crash. Retained as a seeding seam for tests / REST bridges.
   */
  public updateTickerFromRest(arg1: string, arg2: any, arg3?: any): void {
    let type: 'fapi' | 'api' = 'api';
    let symbolKey: string = arg1;
    let item: any = arg2;

    if (arg1 === 'fapi' || arg1 === 'api' || arg1 === 'futures' || arg1 === 'spot') {
      type = (arg1 === 'fapi' || arg1 === 'futures') ? 'fapi' : 'api';
      symbolKey = arg2;
      item = arg3;
    }

    if (!symbolKey || !item || typeof item !== 'object') return;

    const num = (v: any): string => {
      if (v === undefined || v === null) return '0';
      const s = String(v);
      const n = Number(s);
      return (s.trim() === '' || !isFinite(n)) ? '0' : s;
    };

    const ticker: Ticker = {
      symbol: symbolKey,
      lastPrice: num(item.lastPrice),
      priceChange: num(item.priceChange ?? item.priceChange24h),
      priceChangePercent: num(item.priceChangePercent ?? item.priceChangePercent24h),
      high24h: num(item.highPrice ?? item.high24h),
      low24h: num(item.lowPrice ?? item.low24h),
      volume24h: num(item.volume ?? item.volume24h),
      quoteVolume24h: num(item.quoteVolume ?? item.quoteVolume24h),
      timestamp: Number(item.closeTime ?? item.timestamp ?? Date.now()),
    };

    const targetMap = type === 'fapi' ? this.futuresTickers : this.spotTickers;
    targetMap.set(symbolKey, ticker);
  }

  public async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    await tradingPairRegistry.loadTop200();
    await this.fetchInitialData();
    this.connectWebSockets();
  }

  /**
   * Normalize an authoritative backend TickerData payload into the frontend Ticker shape.
   */
  private mapBackendTicker(symbol: string, t: any): Ticker {
    return {
      symbol,
      lastPrice: String(t.lastPrice ?? '0'),
      priceChange: String(t.priceChange24h ?? t.priceChange ?? '0'),
      priceChangePercent: String(t.priceChangePercent24h ?? t.priceChangePercent ?? '0'),
      high24h: String(t.high24h ?? '0'),
      low24h: String(t.low24h ?? '0'),
      volume24h: String(t.volume24h ?? '0'),
      quoteVolume24h: String(t.quoteVolume24h ?? '0'),
      timestamp: Number(t.timestamp ?? Date.now()),
    };
  }

  private storeTicker(symbolUpper: string, raw: any): void {
    const futuresPair = tradingPairRegistry.getFuturesPair(symbolUpper);
    const spotPair = tradingPairRegistry.getSpotPair(symbolUpper);

    if (futuresPair) {
      this.futuresTickers.set(futuresPair.symbol, this.mapBackendTicker(futuresPair.symbol, raw));
    }
    if (spotPair) {
      this.spotTickers.set(spotPair.symbol, this.mapBackendTicker(spotPair.symbol, raw));
    }
    if (!futuresPair && !spotPair) {
      this.spotTickers.set(symbolUpper, this.mapBackendTicker(symbolUpper, raw));
    }
  }

  private async fetchInitialData() {
    try {
      // Authoritative backend tickers only. No external market-data provider.
      const res = await apiClient.get<{ tickers: any[] }>('/market/tickers');
      const list = (res && (res as any).tickers)
        ? (res as any).tickers
        : (Array.isArray(res) ? (res as any) : []);
      for (const t of list) {
        if (t && t.symbol) {
          this.storeTicker(String(t.symbol).toUpperCase(), t);
        }
      }
      this.notify();
    } catch (error) {
      console.error('Failed to fetch initial ticker data from backend', error);
    }
  }

  private connectWebSockets() {
    // Reset any previous subscriptions.
    this.wsUnsubs.forEach(u => {
      try { u(); } catch { /* noop */ }
    });
    this.wsUnsubs = [];

    const symbols = new Set<string>();
    tradingPairRegistry.getFuturesPairs().forEach(p => symbols.add((p.apiSymbol || p.symbol).toUpperCase()));
    tradingPairRegistry.getSpotPairs().forEach(p => symbols.add((p.apiSymbol || p.symbol).toUpperCase()));

    for (const sym of symbols) {
      const unsub = wsClient.subscribe(`ticker:${sym}`, (data: any) => {
        if (data) {
          this.storeTicker(String(data.symbol || sym).toUpperCase(), data);
          this.notify();
        }
      });
      this.wsUnsubs.push(unsub);
    }
  }
}

export const tickerService = new TickerService();
