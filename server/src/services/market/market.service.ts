import crypto from 'crypto';
import {
  TickerData,
  OrderBookSnapshot,
  OrderBookUpdate,
  MarketTradeData,
  MarkPriceData,
  MarketStatusData,
  OrderBookLevel,
} from './types';
import { EventBus, eventBus } from './event-bus';
import { matchingEngine, MatchingEngine } from '../spot/matching.engine';
import { developmentMarkPriceProvider, IMarkPriceProvider } from '../futures/mark-price.provider';
import {
  decimalNormalize,
  decimalSubtract,
  decimalMultiply,
  decimalDivide,
  decimalCompare,
  decimalZero,
} from '../ledger/decimal';
import { logger } from '../../config/logger';

export interface MarketServiceOptions {
  mode?: 'DEVELOPMENT' | 'PRODUCTION';
  eventBus?: EventBus;
  matchingEngine?: MatchingEngine;
  markPriceProvider?: IMarkPriceProvider;
}

export class MarketDataService {
  public readonly mode: 'DEVELOPMENT' | 'PRODUCTION';
  private bus: EventBus;
  private engine: MatchingEngine;
  private markPrices: IMarkPriceProvider;

  private epoch: number;
  private sequenceMap = new Map<string, number>(); // symbol -> sequence
  private tickers = new Map<string, TickerData>();
  private trades = new Map<string, MarketTradeData[]>(); // symbol -> recent trades
  private marketStatus = new Map<string, 'TRADING' | 'HALTED' | 'CLOSED'>();

  constructor(options: MarketServiceOptions = {}) {
    this.mode = options.mode || 'DEVELOPMENT';
    this.bus = options.eventBus || eventBus;
    this.engine = options.matchingEngine || matchingEngine;
    this.markPrices = options.markPriceProvider || developmentMarkPriceProvider;
    this.epoch = Date.now();

    this.initDefaultMarketState();
  }

  private initDefaultMarketState(): void {
    const defaultSymbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BTCUSDC'];

    for (const sym of defaultSymbols) {
      this.sequenceMap.set(sym, 1000);
      this.trades.set(sym, []);
      this.marketStatus.set(sym, 'TRADING');

      let defaultPrice = '50000';
      if (sym === 'ETHUSDT') defaultPrice = '3000';
      if (sym === 'SOLUSDT') defaultPrice = '150';

      const normPrice = decimalNormalize(defaultPrice);
      this.tickers.set(sym, {
        symbol: sym,
        lastPrice: normPrice,
        bid: normPrice,
        ask: normPrice,
        high24h: decimalMultiply(normPrice, '1.05'),
        low24h: decimalMultiply(normPrice, '0.95'),
        volume24h: decimalNormalize('1250.50'),
        quoteVolume24h: decimalMultiply(normPrice, '1250.50'),
        priceChange24h: decimalZero(),
        priceChangePercent24h: decimalZero(),
        timestamp: Date.now(),
      });
    }
  }

  public getEpoch(): number {
    return this.epoch;
  }

  public nextSequence(symbol: string): number {
    const cleanSym = symbol.trim().toUpperCase();
    const current = this.sequenceMap.get(cleanSym) || 1000;
    const next = current + 1;
    this.sequenceMap.set(cleanSym, next);
    return next;
  }

  public getCurrentSequence(symbol: string): number {
    const cleanSym = symbol.trim().toUpperCase();
    return this.sequenceMap.get(cleanSym) || 1000;
  }

  /**
   * Get Ticker snapshot for a specific symbol.
   */
  public getTicker(symbol: string): TickerData | null {
    const cleanSym = symbol.trim().toUpperCase();
    const ticker = this.tickers.get(cleanSym);
    if (!ticker) return null;
    return { ...ticker };
  }

  /**
   * Get all active Tickers.
   */
  public getAllTickers(): TickerData[] {
    return Array.from(this.tickers.values()).map(t => ({ ...t }));
  }

  /**
   * Get OrderBook snapshot from authoritative matching engine.
   */
  public getOrderBook(symbol: string, depth = 50): OrderBookSnapshot {
    const cleanSym = symbol.trim().toUpperCase();
    const book = this.engine.getDepth(cleanSym, depth);

    const bids: OrderBookLevel[] = book.bids.map(b => [b.price, b.quantity]);
    const asks: OrderBookLevel[] = book.asks.map(a => [a.price, a.quantity]);

    return {
      symbol: cleanSym,
      bids,
      asks,
      sequence: this.getCurrentSequence(cleanSym),
      epoch: this.epoch,
      timestamp: Date.now(),
    };
  }


  /**
   * Get recent public trades for a symbol.
   */
  public getRecentTrades(symbol: string, limit = 50): MarketTradeData[] {
    const cleanSym = symbol.trim().toUpperCase();
    const list = this.trades.get(cleanSym) || [];
    return list.slice(0, limit);
  }

  /**
   * Get Mark Price for a symbol.
   */
  public async getMarkPrice(symbol: string): Promise<MarkPriceData> {
    const cleanSym = symbol.trim().toUpperCase();
    const price = await this.markPrices.getMarkPrice(cleanSym);
    const indexPrice = await this.markPrices.getIndexPrice(cleanSym);

    return {
      symbol: cleanSym,
      price,
      
      indexPrice,
      timestamp: Date.now(),
    };
  }


  /**
   * Get Index Price directly.
   */
  public async getIndexPrice(symbol: string): Promise<string> {
    const cleanSym = symbol.trim().toUpperCase();
    return this.markPrices.getIndexPrice(cleanSym);
  }

  /**
   * Record a public execution and emit trade + ticker events.
   */
  public recordTrade(trade: {
    tradeId?: string;
    symbol: string;
    price: string;
    quantity: string;
    quoteQuantity?: string;
    side: 'BUY' | 'SELL';
    isMaker?: boolean;
    timestamp?: number;
  }): MarketTradeData {
    const cleanSym = trade.symbol.trim().toUpperCase();
    const tradeId = trade.tradeId || crypto.randomUUID();
    const price = decimalNormalize(trade.price);
    const quantity = decimalNormalize(trade.quantity);
    const quoteQuantity = trade.quoteQuantity ? decimalNormalize(trade.quoteQuantity) : decimalMultiply(price, quantity);
    const ts = trade.timestamp || Date.now();

    const tradeData: MarketTradeData = {
      tradeId,
      symbol: cleanSym,
      price,
      quantity,
      quoteQuantity,
      side: trade.side,
      isMaker: Boolean(trade.isMaker),
      timestamp: ts,
    };

    // Update in-memory recent trades buffer
    if (!this.trades.has(cleanSym)) {
      this.trades.set(cleanSym, []);
    }
    const list = this.trades.get(cleanSym)!;
    list.unshift(tradeData);
    if (list.length > 200) {
      list.length = 200;
    }

    // Update ticker
    const ticker = this.tickers.get(cleanSym) || {
      symbol: cleanSym,
      lastPrice: price,
      bid: price,
      ask: price,
      high24h: price,
      low24h: price,
      volume24h: decimalZero(),
      quoteVolume24h: decimalZero(),
      priceChange24h: decimalZero(),
      priceChangePercent24h: decimalZero(),
      timestamp: ts,
    };

    ticker.lastPrice = price;
    ticker.timestamp = ts;
    ticker.volume24h = decimalNormalize(String(Number(ticker.volume24h) + Number(quantity)));
    ticker.quoteVolume24h = decimalNormalize(String(Number(ticker.quoteVolume24h) + Number(quoteQuantity)));

    // Emit market.trade public event
    this.bus.publish({
      id: crypto.randomUUID(),
      type: 'market.trade',
      channel: `trades:${cleanSym}`,
      symbol: cleanSym,
      timestamp: ts,
      version: '1.0.0',
      payload: tradeData,
    });

    // Emit market.ticker public event
    this.bus.publish({
      id: crypto.randomUUID(),
      type: 'market.ticker',
      channel: `ticker:${cleanSym}`,
      symbol: cleanSym,
      timestamp: ts,
      version: '1.0.0',
      payload: ticker,
    });

    return tradeData;
  }

  /**
   * Emit an incremental OrderBook update event from current matching engine state.
   */
  public emitOrderBookUpdate(symbol: string): OrderBookUpdate {
    const cleanSym = symbol.trim().toUpperCase();
    const prevSeq = this.getCurrentSequence(cleanSym);
    const seq = this.nextSequence(cleanSym);
    const book = this.engine.getDepth(cleanSym, 20);

    const bids: OrderBookLevel[] = book.bids.map(b => [b.price, b.quantity]);
    const asks: OrderBookLevel[] = book.asks.map(a => [a.price, a.quantity]);

    const update: OrderBookUpdate = {
      symbol: cleanSym,
      bids,
      asks,
      sequence: seq,
      prevSequence: prevSeq,
      epoch: this.epoch,
      timestamp: Date.now(),
    };


    this.bus.publish({
      id: crypto.randomUUID(),
      type: 'market.orderbook.update',
      channel: `orderbook:${cleanSym}`,
      symbol: cleanSym,
      sequence: seq,
      epoch: this.epoch,
      timestamp: update.timestamp,
      version: '1.0.0',
      payload: update,
    });

    return update;
  }

  /**
   * Emit Mark Price update event.
   */
  public emitMarkPriceUpdate(symbol: string, price: string): MarkPriceData {
    const cleanSym = symbol.trim().toUpperCase();
    const cleanPrice = decimalNormalize(price);
    const ts = Date.now();

    const data: MarkPriceData = {
      symbol: cleanSym,
      price: cleanPrice,
      timestamp: ts,
    };

    this.bus.publish({
      id: crypto.randomUUID(),
      type: 'market.markPrice',
      channel: `markPrice:${cleanSym}`,
      symbol: cleanSym,
      timestamp: ts,
      version: '1.0.0',
      payload: data,
    });

    return data;
  }

  /**
   * Reset / reinitialize market data state on server restart or in tests.
   */
  public reset(): void {
    this.epoch = Date.now();
    this.sequenceMap.clear();
    this.trades.clear();
    this.initDefaultMarketState();
  }
}

export const marketDataService = new MarketDataService();
