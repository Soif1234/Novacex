import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { marketDataService } from './market.service';
import { TickerData } from './types';
import { decimalNormalize } from '../ledger/decimal';

export const CORE_DEFAULT_SYMBOLS: ReadonlyArray<string> = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'ADAUSDT',
  'AVAXUSDT',
  'LINKUSDC',
  'BTCUSDC',
];

export const CORE_SYMBOLS_SET = new Set(CORE_DEFAULT_SYMBOLS);

// Active dynamic supported symbols cache
const activeSupportedSymbols = new Set<string>(CORE_DEFAULT_SYMBOLS);

export function isSupportedSymbol(symbol: string): boolean {
  if (!symbol || typeof symbol !== 'string') return false;
  const clean = symbol.trim().toUpperCase();
  if (activeSupportedSymbols.has(clean)) return true;
  // Match standard spot/futures pair syntax e.g. BTCUSDT, ETHUSDC
  return /^[A-Z0-9]{3,12}(USDT|USDC)$/.test(clean);
}

export function getActiveSupportedSymbols(): string[] {
  return Array.from(activeSupportedSymbols);
}

// Export for backward-compatibility with tests/imports
export const SUPPORTED_SYMBOLS: ReadonlyArray<string> = CORE_DEFAULT_SYMBOLS;

export class ExternalMarketFeedService {
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private consecutiveErrors = 0;
  private currentBaseUrl: string;
  private lastFetchTime = 0;

  constructor() {
    this.currentBaseUrl = env.EXTERNAL_MARKET_DATA_URL;
  }

  public start(): void {
    if (!env.EXTERNAL_MARKET_DATA_ENABLED) {
      logger.info('External market data feed is disabled via configuration');
      return;
    }

    if (this.isRunning) return;
    this.isRunning = true;

    logger.info('Starting ExternalMarketFeedService (Top ~200 Pairs)', {
      primaryUrl: env.EXTERNAL_MARKET_DATA_URL,
      pollIntervalMs: env.EXTERNAL_MARKET_DATA_POLL_INTERVAL_MS,
    });

    // Run initial fetch immediately
    this.pollTickers().catch((err) => {
      logger.warn('Initial external market feed poll encountered error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    this.timer = setInterval(() => {
      this.pollTickers().catch((err) => {
        logger.warn('External market feed polling error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, env.EXTERNAL_MARKET_DATA_POLL_INTERVAL_MS);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    logger.info('ExternalMarketFeedService stopped');
  }

  public async pollTickers(): Promise<void> {
    const primaryUrl = env.EXTERNAL_MARKET_DATA_URL;
    const fallbackUrl = 'https://api.binance.com/api/v3';

    // Failover to secondary mirror after 2 consecutive errors
    const baseUrl = this.consecutiveErrors >= 2 ? fallbackUrl : primaryUrl;

    try {
      const url = `${baseUrl}/ticker/24hr`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'NovaCEX-MarketFeed/1.0',
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const rawTickers = await response.json();
      if (!Array.isArray(rawTickers)) {
        throw new Error('Unexpected non-array response from external ticker endpoint');
      }

      // Filter for active USDT and USDC pairs
      const usdtPairs = rawTickers.filter((item: any) => {
        if (!item || !item.symbol) return false;
        const sym = String(item.symbol).toUpperCase();
        return (sym.endsWith('USDT') || sym.endsWith('USDC')) && parseFloat(item.quoteVolume || '0') > 0;
      });

      // Sort descending by 24h volume and select Top 200 pairs
      usdtPairs.sort((a: any, b: any) => parseFloat(b.quoteVolume || '0') - parseFloat(a.quoteVolume || '0'));
      const top200 = usdtPairs.slice(0, 200);

      // Ensure all core default symbols are included
      const selectedMap = new Map<string, any>();
      top200.forEach((item: any) => {
        selectedMap.set(String(item.symbol).toUpperCase(), item);
      });

      rawTickers.forEach((item: any) => {
        if (!item || !item.symbol) return;
        const sym = String(item.symbol).toUpperCase();
        if (CORE_SYMBOLS_SET.has(sym) && !selectedMap.has(sym)) {
          selectedMap.set(sym, item);
        }
      });

      const transformed: TickerData[] = [];
      const now = Date.now();

      for (const item of selectedMap.values()) {
        const sym = String(item.symbol).toUpperCase();

        try {
          const lastPrice = decimalNormalize(String(item.lastPrice || '0'));
          const bid = decimalNormalize(String(item.bidPrice || item.lastPrice || '0'));
          const ask = decimalNormalize(String(item.askPrice || item.lastPrice || '0'));
          const high24h = decimalNormalize(String(item.highPrice || item.lastPrice || '0'));
          const low24h = decimalNormalize(String(item.lowPrice || item.lastPrice || '0'));
          const volume24h = decimalNormalize(String(item.volume || '0'));
          const quoteVolume24h = decimalNormalize(String(item.quoteVolume || '0'));
          const priceChange24h = decimalNormalize(String(item.priceChange || '0'));
          const priceChangePercent24h = decimalNormalize(String(item.priceChangePercent || '0'));
          const ts = Number(item.closeTime || now);

          transformed.push({
            symbol: sym,
            lastPrice,
            bid,
            ask,
            high24h,
            low24h,
            volume24h,
            quoteVolume24h,
            priceChange24h,
            priceChangePercent24h,
            timestamp: ts,
          });

          activeSupportedSymbols.add(sym);
        } catch {
          // Skip individual corrupt item without failing the batch
        }
      }

      if (transformed.length > 0) {
        marketDataService.updateExternalTickers(transformed);
        this.lastFetchTime = now;
        this.consecutiveErrors = 0;
        this.currentBaseUrl = baseUrl;
      }
    } catch (err: any) {
      this.consecutiveErrors++;
      logger.warn('Failed to fetch external market tickers; retaining last valid state', {
        error: err?.message || String(err),
        consecutiveErrors: this.consecutiveErrors,
        currentBaseUrl: baseUrl,
      });
    }
  }

  public getLastFetchTime(): number {
    return this.lastFetchTime;
  }

  public getConsecutiveErrors(): number {
    return this.consecutiveErrors;
  }
}

export const externalMarketFeedService = new ExternalMarketFeedService();
