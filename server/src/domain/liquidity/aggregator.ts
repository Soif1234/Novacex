import { NormalizedTicker, NormalizedOrderBook, NormalizedOrderBookLevel } from './adapter';
import { ProviderError, ProviderErrorCode } from './errors';

export enum MarketDataSourceHealth {
  ACTIVE = 'ACTIVE',
  STALE = 'STALE',
  UNAVAILABLE = 'UNAVAILABLE',
  DISABLED = 'DISABLED',
  ERROR = 'ERROR'
}

export const STALE_THRESHOLD_MS = 10000; // 10 seconds

export interface SourceMetadata {
  sourceId: string;
  health: MarketDataSourceHealth;
  lastUpdateMs: number;
}

export interface AggregatedTicker {
  symbol: string;
  bestBid: string;
  bestAsk: string;
  sources: Record<string, NormalizedTicker & SourceMetadata>;
}

export interface AggregatedOrderBookLevel extends NormalizedOrderBookLevel {
  sourceId: string;
}

export interface AggregatedOrderBook {
  symbol: string;
  bids: AggregatedOrderBookLevel[];
  asks: AggregatedOrderBookLevel[];
  sources: Record<string, SourceMetadata>;
}

export class MarketDataAggregator {
  // Map<Symbol, Map<SourceId, Data>>
  private tickers: Map<string, Map<string, NormalizedTicker & SourceMetadata>> = new Map();
  private orderBooks: Map<string, Map<string, NormalizedOrderBook & SourceMetadata>> = new Map();
  private sourceHealthOverrides: Map<string, MarketDataSourceHealth> = new Map();

  /**
   * Sets manual override for a source's health (e.g. DISABLED, UNAVAILABLE)
   */
  public setSourceHealth(sourceId: string, health: MarketDataSourceHealth): void {
    this.sourceHealthOverrides.set(sourceId, health);
  }

  /**
   * Evaluates the active health of a source based on timestamp and overrides.
   */
  public evaluateSourceHealth(sourceId: string, lastUpdateMs: number, currentTimeMs: number = Date.now()): MarketDataSourceHealth {
    const override = this.sourceHealthOverrides.get(sourceId);
    if (override && override !== MarketDataSourceHealth.ACTIVE) {
      return override;
    }
    
    if (currentTimeMs - lastUpdateMs > STALE_THRESHOLD_MS) {
      return MarketDataSourceHealth.STALE;
    }
    
    return MarketDataSourceHealth.ACTIVE;
  }

  private validateNumericString(val: string): boolean {
    const num = Number(val);
    return !isNaN(num) && isFinite(num) && num > 0;
  }

  private normalizeSymbol(symbol: string): string {
    return symbol.trim().toUpperCase();
  }

  public processTickerUpdate(sourceId: string, ticker: NormalizedTicker, currentTimeMs: number = Date.now()): void {
    const symbol = this.normalizeSymbol(ticker.symbol);
    
    if (!this.validateNumericString(ticker.bid) || !this.validateNumericString(ticker.ask)) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Invalid ticker prices', sourceId);
    }
    if (!this.validateNumericString(ticker.lastPrice) || !this.validateNumericString(ticker.volume24h)) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Invalid ticker volume or lastPrice', sourceId);
    }

    const updateTimeMs = ticker.timestamp.getTime();

    let symbolMap = this.tickers.get(symbol);
    if (!symbolMap) {
      symbolMap = new Map();
      this.tickers.set(symbol, symbolMap);
    }

    const existing = symbolMap.get(sourceId);
    if (existing) {
      // Reject out-of-order or duplicate updates (timestamp must be strictly greater)
      if (updateTimeMs <= existing.lastUpdateMs) {
        return; // Silently ignore duplicate/stale sequences per rules
      }
    }

    const health = this.evaluateSourceHealth(sourceId, updateTimeMs, currentTimeMs);

    symbolMap.set(sourceId, {
      ...ticker,
      symbol, // ensure normalized
      sourceId,
      health,
      lastUpdateMs: updateTimeMs
    });
  }

  public processOrderBookUpdate(sourceId: string, orderBook: NormalizedOrderBook, currentTimeMs: number = Date.now()): void {
    const symbol = this.normalizeSymbol(orderBook.symbol);
    
    for (const level of [...orderBook.bids, ...orderBook.asks]) {
      if (!this.validateNumericString(level.price) || !this.validateNumericString(level.quantity)) {
        throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, `Invalid order book level: ${level.price}@${level.quantity}`, sourceId);
      }
    }

    const updateTimeMs = orderBook.timestamp.getTime();

    let symbolMap = this.orderBooks.get(symbol);
    if (!symbolMap) {
      symbolMap = new Map();
      this.orderBooks.set(symbol, symbolMap);
    }

    const existing = symbolMap.get(sourceId);
    if (existing) {
      // Reject out-of-order or duplicate updates
      if (updateTimeMs <= existing.lastUpdateMs) {
        return;
      }
    }

    const health = this.evaluateSourceHealth(sourceId, updateTimeMs, currentTimeMs);

    symbolMap.set(sourceId, {
      ...orderBook,
      symbol, // ensure normalized
      sourceId,
      health,
      lastUpdateMs: updateTimeMs
    });
  }

  public getAggregatedTicker(symbol: string, currentTimeMs: number = Date.now()): AggregatedTicker | null {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const symbolMap = this.tickers.get(normalizedSymbol);
    if (!symbolMap) return null;

    let bestBid = 0;
    let bestAsk = Infinity;
    const sources: Record<string, NormalizedTicker & SourceMetadata> = {};

    for (const [sourceId, ticker] of symbolMap.entries()) {
      const currentHealth = this.evaluateSourceHealth(sourceId, ticker.lastUpdateMs, currentTimeMs);
      
      if (currentHealth === MarketDataSourceHealth.ACTIVE) {
        const bid = Number(ticker.bid);
        const ask = Number(ticker.ask);
        if (bid > bestBid) bestBid = bid;
        if (ask < bestAsk) bestAsk = ask;
        
        sources[sourceId] = { ...ticker, health: currentHealth };
      }
    }

    if (Object.keys(sources).length === 0) {
      return null;
    }

    return {
      symbol: normalizedSymbol,
      bestBid: bestBid.toString(),
      bestAsk: bestAsk === Infinity ? '0' : bestAsk.toString(),
      sources
    };
  }

  public getAggregatedOrderBook(symbol: string, currentTimeMs: number = Date.now()): AggregatedOrderBook | null {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const symbolMap = this.orderBooks.get(normalizedSymbol);
    if (!symbolMap) return null;

    const aggregatedBids: AggregatedOrderBookLevel[] = [];
    const aggregatedAsks: AggregatedOrderBookLevel[] = [];
    const sources: Record<string, SourceMetadata> = {};

    for (const [sourceId, book] of symbolMap.entries()) {
      const currentHealth = this.evaluateSourceHealth(sourceId, book.lastUpdateMs, currentTimeMs);
      
      if (currentHealth === MarketDataSourceHealth.ACTIVE) {
        sources[sourceId] = { sourceId, health: currentHealth, lastUpdateMs: book.lastUpdateMs };
        
        for (const bid of book.bids) {
          aggregatedBids.push({ ...bid, sourceId });
        }
        for (const ask of book.asks) {
          aggregatedAsks.push({ ...ask, sourceId });
        }
      }
    }

    if (Object.keys(sources).length === 0) {
      return null;
    }

    // Sort: Bids descending, Asks ascending
    aggregatedBids.sort((a, b) => Number(b.price) - Number(a.price));
    aggregatedAsks.sort((a, b) => Number(a.price) - Number(b.price));

    return {
      symbol: normalizedSymbol,
      bids: aggregatedBids,
      asks: aggregatedAsks,
      sources
    };
  }
}
