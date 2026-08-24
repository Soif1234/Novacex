import { IDatabaseConnection, db } from '../../config/database';
import { eventBus } from './event-bus';
import { decimalAdd, decimalCompare, decimalNormalize } from '../ledger/decimal';
import { logger } from '../../config/logger';
import { env } from '../../config/env';
import { isSupportedSymbol } from './external-feed.service';

export type Interval = '1m' | '5m' | '1h' | '1d';

export interface KLine {
  market: 'SPOT' | 'FUTURES';
  symbol: string;
  interval: Interval;
  openTime: number;
  closeTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  baseVolume: string;
  quoteVolume: string;
  tradesCount: number;
  isFinal: boolean;
}

const INTERVAL_MS: Record<Interval, number> = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

function decimalMax(a: string, b: string): string {
  return decimalCompare(a, b) >= 0 ? a : b;
}

function decimalMin(a: string, b: string): string {
  return decimalCompare(a, b) <= 0 ? a : b;
}

export class KLineService {
  private activeCandles: Map<string, KLine> = new Map();
  private lastTradeTimes: Map<string, number> = new Map(); // Track max trade time per candle for out-of-order handling
  private processedTrades: Set<string> = new Set();
  private db: IDatabaseConnection;
  private intervalTimer: NodeJS.Timeout | null = null;
  private unsubTrade: (() => void) | null = null;
  private unsubFutures: (() => void) | null = null;

  constructor(db: IDatabaseConnection) {
    this.db = db;
  }

  public async start(): Promise<void> {
    await this.recoverUnfinishedCandles();

    this.unsubTrade = eventBus.subscribe('market.trade', async (event) => {
      const trade = event.payload;
      if (!trade.isMaker) {
        await this.processTrade('SPOT', trade.symbol, trade);
      }
    });

    this.unsubFutures = eventBus.subscribe('futures.trade.executed', async (event) => {
      const trade = event.payload;
      await this.processTrade('FUTURES', trade.symbol, trade);
    });

    this.intervalTimer = setInterval(() => {
      this.finalizeCandles().catch((err) => {
        logger.error('Error in kline finalization sweep', { err });
      });
      this.cleanupProcessedTrades();
    }, 5000);
  }

  public async stop(): Promise<void> {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.unsubTrade) {
      this.unsubTrade();
      this.unsubTrade = null;
    }
    if (this.unsubFutures) {
      this.unsubFutures();
      this.unsubFutures = null;
    }
  }

  private async recoverUnfinishedCandles(): Promise<void> {
    try {
      const res = await this.db.query<any>('SELECT * FROM k_lines WHERE is_final = false');
      for (const row of res.rows) {
        const key = `${row.market}:${row.symbol}:${row.interval}:${row.open_time}`;
        this.activeCandles.set(key, {
          market: row.market as 'SPOT' | 'FUTURES',
          symbol: row.symbol,
          interval: row.interval as Interval,
          openTime: Number(row.open_time),
          closeTime: Number(row.close_time),
          open: row.open_price,
          high: row.high_price,
          low: row.low_price,
          close: row.close_price,
          baseVolume: row.base_volume,
          quoteVolume: row.quote_volume,
          tradesCount: Number(row.trades_count),
          isFinal: row.is_final,
        });
      }
      logger.info('Recovered unfinished K-lines from database', { count: this.activeCandles.size });
    } catch (err) {
      logger.error('Failed to recover unfinished K-lines', { err: err instanceof Error ? err.message : String(err) });
    }
  }

  private async processTrade(market: 'SPOT' | 'FUTURES', symbol: string, trade: any): Promise<void> {
    const tradeId = trade.tradeId || trade.id;
    if (!tradeId) return; // Ignore invalid trades

    if (this.processedTrades.has(tradeId)) {
      return; // Idempotency: duplicate event protection
    }
    this.processedTrades.add(tradeId);

    // Validate quantities and prices to prevent NaN/Infinity corruption
    const priceNum = Number(trade.price);
    const qtyNum = Number(trade.quantity);
    if (!isFinite(priceNum) || !isFinite(qtyNum) || priceNum <= 0 || qtyNum <= 0) {
      logger.warn('Invalid trade data, skipping K-line generation', { tradeId, price: trade.price, quantity: trade.quantity });
      return;
    }

    const price = decimalNormalize(trade.price);
    const baseQty = decimalNormalize(trade.quantity);
    let quoteQty = '0';
    if (trade.quoteQuantity) {
      quoteQty = decimalNormalize(trade.quoteQuantity);
    } else {
      // Calculate quote volume if missing
      quoteQty = decimalNormalize(String(priceNum * qtyNum));
    }

    // Determine timestamp
    let tradeTime = Date.now();
    if (trade.timestamp) {
      tradeTime = Number(trade.timestamp);
    } else if (trade.createdAt) {
      tradeTime = new Date(trade.createdAt).getTime();
    }

    const intervals: Interval[] = ['1m', '5m', '1h', '1d'];

    for (const interval of intervals) {
      const ms = INTERVAL_MS[interval];
      const openTime = Math.floor(tradeTime / ms) * ms;
      const closeTime = openTime + ms - 1;
      const key = `${market}:${symbol}:${interval}:${openTime}`;

      let candle = this.activeCandles.get(key);
      let isNew = false;

      if (!candle) {
        // Synchronously create placeholder to prevent race conditions on concurrent trades
        candle = {
          market,
          symbol,
          interval,
          openTime,
          closeTime,
          open: price,
          high: price,
          low: price,
          close: price,
          baseVolume: '0',
          quoteVolume: '0',
          tradesCount: 0,
          isFinal: false,
        };
        this.activeCandles.set(key, candle);
        isNew = true;

        // Handle scenario where we receive a trade for a finalized candle (late event)
        // Check DB to see if it exists
        const res = await this.db.query<any>(
          'SELECT is_final FROM k_lines WHERE market = $1 AND symbol = $2 AND interval = $3 AND open_time = $4',
          [market, symbol, interval, openTime]
        );

        if (res.rows.length > 0) {
          if (res.rows[0].is_final) {
            logger.warn('Received late trade for finalized candle, ignoring to prevent mutation', { market, symbol, interval, openTime });
            this.activeCandles.delete(key);
            continue;
          } else {
            isNew = false; // Exists in DB but not final, means it was already created by another instance or process, we just update it
          }
        }
      }

      if (candle.isFinal) {
        logger.warn('Received late trade for finalized candle in memory, ignoring to prevent mutation', { market, symbol, interval, openTime });
        continue;
      }

      // Determine chronological correctness for CLOSE price
      const lastTime = this.lastTradeTimes.get(key) || 0;
      const isChronological = tradeTime >= lastTime;
      if (isChronological) {
        this.lastTradeTimes.set(key, tradeTime);
        candle.close = price;
      }

      candle.high = decimalMax(candle.high, price);
      candle.low = decimalMin(candle.low, price);
      candle.baseVolume = decimalAdd(candle.baseVolume, baseQty);
      candle.quoteVolume = decimalAdd(candle.quoteVolume, quoteQty);
      candle.tradesCount += 1;

      if (isNew) {
        // Insert new candle
        try {
          await this.db.query(
            `INSERT INTO k_lines 
             (market, symbol, interval, open_time, close_time, open_price, high_price, low_price, close_price, base_volume, quote_volume, trades_count, is_final)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             ON CONFLICT (market, symbol, interval, open_time) DO NOTHING`,
            [
              market, symbol, interval, openTime, closeTime,
              candle.open, candle.high, candle.low, candle.close,
              candle.baseVolume, candle.quoteVolume, candle.tradesCount, false
            ]
          );
        } catch (err) {
          logger.error('Failed to insert new K-line', { err: err instanceof Error ? err.message : String(err), key });
        }
      } else {
        // Update existing candle
        try {
          await this.db.query(
            `UPDATE k_lines 
             SET high_price = $1, low_price = $2, close_price = $3, base_volume = $4, quote_volume = $5, trades_count = $6, updated_at = NOW()
             WHERE market = $7 AND symbol = $8 AND interval = $9 AND open_time = $10`,
            [
              candle.high, candle.low, candle.close, candle.baseVolume, candle.quoteVolume, candle.tradesCount,
              market, symbol, interval, openTime
            ]
          );
        } catch (err) {
          logger.error('Failed to update K-line', { err: err instanceof Error ? err.message : String(err), key });
        }
      }

      // Publish WebSocket update
      eventBus.publish({
        id: crypto.randomUUID(),
        type: 'kline.update',
        channel: `kline:${market.toLowerCase()}:${symbol.toLowerCase()}:${interval}`,
        symbol,
        timestamp: Date.now(),
        version: '1.0.0',
        payload: candle,
      });
    }
  }

  private async finalizeCandles(): Promise<void> {
    const now = Date.now();
    for (const [key, candle] of this.activeCandles.entries()) {
      if (now > candle.closeTime) {
        candle.isFinal = true;
        try {
          await this.db.query(
            'UPDATE k_lines SET is_final = true, updated_at = NOW() WHERE market = $1 AND symbol = $2 AND interval = $3 AND open_time = $4',
            [candle.market, candle.symbol, candle.interval, candle.openTime]
          );
          this.activeCandles.delete(key);
          this.lastTradeTimes.delete(key);
          
          // Publish final update
          eventBus.publish({
            id: crypto.randomUUID(),
            type: 'kline.update',
            channel: `kline:${candle.market.toLowerCase()}:${candle.symbol.toLowerCase()}:${candle.interval}`,
            symbol: candle.symbol,
            timestamp: Date.now(),
            version: '1.0.0',
            payload: candle,
          });
        } catch (err) {
          logger.error('Failed to finalize K-line', { err: err instanceof Error ? err.message : String(err), key });
          candle.isFinal = false; // Revert on failure to retry next tick
        }
      }
    }
  }

  private cleanupProcessedTrades(): void {
    // Basic mechanism to prevent memory leak: clear processed trades set periodically.
    // In production, we'd use a TTL cache, but since we rely on authoritative event streams,
    // a periodic wipe (e.g. 5 minutes) is fine, as duplicates happen immediately upon network retries.
    // We'll just reset it if it grows too large.
    if (this.processedTrades.size > 100000) {
      this.processedTrades.clear();
    }
  }

  private klineCache = new Map<string, { data: KLine[]; expiresAt: number }>();

  public async getHistoricalKLines(
    market: 'SPOT' | 'FUTURES',
    symbol: string,
    interval: Interval,
    limit: number = 500,
    endTime?: number
  ): Promise<KLine[]> {
    const cleanSym = symbol.trim().toUpperCase();
    const cleanInterval = (['1m', '5m', '1h', '1d'].includes(interval) ? interval : '1m') as Interval;
    const safeLimit = Math.min(Math.max(limit || 500, 1), 1000);
    const end = endTime || Date.now();

    let res: any = { rows: [] };
    try {
      res = await this.db.query<any>(
        `SELECT * FROM k_lines
         WHERE market = $1 AND symbol = $2 AND interval = $3 AND open_time <= $4
         ORDER BY open_time DESC
         LIMIT $5`,
        [market, cleanSym, cleanInterval, end, safeLimit]
      );
    } catch {
      res = { rows: [] };
    }

    if (res.rows.length > 0) {
      return res.rows.map((row: any) => ({
        market: row.market,
        symbol: row.symbol,
        interval: row.interval,
        openTime: Number(row.open_time),
        closeTime: Number(row.close_time),
        open: row.open_price,
        high: row.high_price,
        low: row.low_price,
        close: row.close_price,
        baseVolume: row.base_volume,
        quoteVolume: row.quote_volume,
        tradesCount: Number(row.trades_count),
        isFinal: row.is_final
      })).reverse(); // Return oldest to newest for charts
    }

    // Fallback: If no internal simulated trade candles exist in DB, fetch reference candles from external feed
    if (!env.EXTERNAL_MARKET_DATA_ENABLED) {
      return [];
    }

    const cacheKey = `${market}:${cleanSym}:${cleanInterval}:${safeLimit}`;
    const now = Date.now();
    const cached = this.klineCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }

    const externalKlines = await this.fetchExternalHistoricalKLines(market, cleanSym, cleanInterval, safeLimit);
    if (externalKlines.length > 0) {
      this.klineCache.set(cacheKey, {
        data: externalKlines,
        expiresAt: now + 10000, // 10-second TTL
      });
    }

    return externalKlines;
  }

  private async fetchExternalHistoricalKLines(
    market: 'SPOT' | 'FUTURES',
    symbol: string,
    interval: Interval,
    limit: number
  ): Promise<KLine[]> {
    if (!isSupportedSymbol(symbol)) {
      return [];
    }

    const primaryBase = market === 'FUTURES'
      ? 'https://fapi.binance.com/fapi/v1'
      : env.EXTERNAL_MARKET_DATA_URL;

    const fallbackBase = market === 'FUTURES'
      ? 'https://fapi.binance.com/fapi/v1'
      : 'https://api.binance.com/api/v3';

    const fetchFromUrl = async (baseUrl: string): Promise<KLine[]> => {
      const url = `${baseUrl}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);

      try {
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

        const rawData = await response.json();
        if (!Array.isArray(rawData)) return [];

        const result: KLine[] = [];
        for (const raw of rawData) {
          if (!Array.isArray(raw) || raw.length < 9) continue;
          try {
            const openTime = Number(raw[0]);
            const open = decimalNormalize(String(raw[1]));
            const high = decimalNormalize(String(raw[2]));
            const low = decimalNormalize(String(raw[3]));
            const close = decimalNormalize(String(raw[4]));
            const baseVolume = decimalNormalize(String(raw[5]));
            const closeTime = Number(raw[6]);
            const quoteVolume = decimalNormalize(String(raw[7]));
            const tradesCount = Number(raw[8]) || 0;

            result.push({
              market,
              symbol,
              interval,
              openTime,
              closeTime,
              open,
              high,
              low,
              close,
              baseVolume,
              quoteVolume,
              tradesCount,
              isFinal: true,
            });
          } catch {
            // Skip invalid candle
          }
        }
        return result;
      } catch (err) {
        clearTimeout(timeout);
        throw err;
      }
    };

    try {
      return await fetchFromUrl(primaryBase);
    } catch (err: any) {
      if (primaryBase !== fallbackBase) {
        try {
          return await fetchFromUrl(fallbackBase);
        } catch {
          // Fallback failed
        }
      }
      logger.warn('Failed to fetch external historical candles', {
        market,
        symbol,
        interval,
        error: err?.message || String(err),
      });
      return [];
    }
  }
}

export const klineService = new KLineService(db);
