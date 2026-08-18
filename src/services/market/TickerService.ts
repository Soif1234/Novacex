import { tradingPairRegistry } from './TradingPairRegistry';

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
  
  private fapiWs: WebSocket | null = null;
  private apiWs: WebSocket | null = null;
  private reconnectTimeouts: Record<string, ReturnType<typeof setTimeout>> = {};

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

  public async initialize() {
    await tradingPairRegistry.loadTop200();
    await this.fetchInitialData();
    this.connectWebSockets();
  }

  private async fetchInitialData() {
    try {
      const futuresPairs = tradingPairRegistry.getFuturesPairs();
      const spotPairs = tradingPairRegistry.getSpotPairs();

      const fetchPromises: Promise<void>[] = [];

      if (futuresPairs.length > 0) {
        fetchPromises.push(
          fetch('https://fapi.binance.com/fapi/v1/ticker/24hr')
            .then(res => res.json())
            .then(data => {
              if (Array.isArray(data)) {
                data.forEach((item: any) => {
                  const matchingPairs = futuresPairs.filter(p => (p.apiSymbol || p.symbol) === item.symbol);
                  matchingPairs.forEach(p => {
                    this.updateTickerFromRest('fapi', p.symbol, item);
                  });
                });
              }
            })
            .catch(err => console.error('Failed to fetch initial futures ticker data', err))
        );
      }

      if (spotPairs.length > 0) {
        fetchPromises.push(
          fetch('https://api.binance.com/api/v3/ticker/24hr')
            .then(res => res.json())
            .then(data => {
              if (Array.isArray(data)) {
                data.forEach((item: any) => {
                  const matchingPairs = spotPairs.filter(p => (p.apiSymbol || p.symbol) === item.symbol);
                  matchingPairs.forEach(p => {
                    this.updateTickerFromRest('api', p.symbol, item);
                  });
                });
              }
            })
            .catch(err => console.error('Failed to fetch initial spot ticker data', err))
        );
      }

      await Promise.all(fetchPromises);
      this.notify();
    } catch (error) {
      console.error('Error fetching initial ticker data', error);
    }
  }

  private updateTickerFromRest(arg1: string, arg2: any, arg3?: any) {
    let type: 'fapi' | 'api' = 'api';
    let symbolKey: string = arg1;
    let item: any = arg2;

    if (arg1 === 'fapi' || arg1 === 'api' || arg1 === 'futures' || arg1 === 'spot') {
      type = (arg1 === 'fapi' || arg1 === 'futures') ? 'fapi' : 'api';
      symbolKey = arg2;
      item = arg3;
    }

    const targetMap = type === 'fapi' ? this.futuresTickers : this.spotTickers;
    targetMap.set(symbolKey, {
      symbol: symbolKey,
      lastPrice: item.lastPrice,
      priceChange: item.priceChange,
      priceChangePercent: item.priceChangePercent,
      high24h: item.highPrice,
      low24h: item.lowPrice,
      volume24h: item.volume,
      quoteVolume24h: item.quoteVolume,
      timestamp: item.closeTime || Date.now(),
    });
  }

  private connectWebSockets() {
    const futuresPairs = tradingPairRegistry.getFuturesPairs();
    const fapiSymbols = Array.from(new Set(futuresPairs.map(p => p.apiSymbol || p.symbol)));
    this.connectWs('fapi', 'wss://fstream.binance.com/ws/!ticker@arr', fapiSymbols, futuresPairs);

    const spotPairs = tradingPairRegistry.getSpotPairs();
    const apiSymbols = Array.from(new Set(spotPairs.map(p => p.apiSymbol || p.symbol)));
    this.connectWs('api', 'wss://stream.binance.com:9443/ws/!ticker@arr', apiSymbols, spotPairs);
  }

  private connectWs(type: 'fapi' | 'api', url: string, relevantApiSymbols: string[], pairs: any[]) {
    if (relevantApiSymbols.length === 0) return;
    
    let ws = new WebSocket(url);
    if (type === 'fapi') this.fapiWs = ws;
    else this.apiWs = ws;

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (Array.isArray(data)) {
          let updated = false;
          const targetMap = type === 'fapi' ? this.futuresTickers : this.spotTickers;
          data.forEach((item: any) => {
            const apiSymbol = item.s;
            if (relevantApiSymbols.includes(apiSymbol)) {
              const matchingPairs = pairs.filter(p => (p.apiSymbol || p.symbol) === apiSymbol);
              matchingPairs.forEach(p => {
                targetMap.set(p.symbol, {
                  symbol: p.symbol,
                  lastPrice: item.c,
                  priceChange: item.p,
                  priceChangePercent: item.P,
                  high24h: item.h,
                  low24h: item.l,
                  volume24h: item.v,
                  quoteVolume24h: item.q,
                  timestamp: item.E || Date.now(),
                });
                updated = true;
              });
            }
          });
          if (updated) {
            this.notify();
          }
        }
      } catch (err) {
        console.error('Error parsing WS message', err);
      }
    };

    ws.onclose = () => {
      clearTimeout(this.reconnectTimeouts[type]);
      this.reconnectTimeouts[type] = setTimeout(() => {
        this.connectWs(type, url, relevantApiSymbols, pairs);
      }, 5000);
    };

    ws.onerror = (err) => {
      console.warn(`WebSocket warning on ${type} - will auto-reconnect`);
      ws.close();
    };
  }
}

export const tickerService = new TickerService();
