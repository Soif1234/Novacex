import { tradingPairRegistry } from './TradingPairRegistry';

export interface Ticker {
  symbol: string;
  lastPrice: string;
  priceChange: string;
  priceChangePercent: string;
  high24h: string;
  low24h: string;
  volume24h: string; // Base asset volume
  quoteVolume24h: string; // Quote asset volume
  timestamp: number;
}

class TickerService {
  private tickers: Map<string, Ticker> = new Map();
  private subscribers: Set<() => void> = new Set();
  
  private fapiWs: WebSocket | null = null;
  private apiWs: WebSocket | null = null;
  private reconnectTimeouts: Record<string, ReturnType<typeof setTimeout>> = {};

  constructor() {}

  public getTicker(symbol: string): Ticker | undefined {
    return this.tickers.get(symbol);
  }

  public getAllTickers(): Ticker[] {
    return Array.from(this.tickers.values());
  }

  public subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private notify() {
    this.subscribers.forEach(cb => cb());
  }

  public async initialize() {
    await this.fetchInitialData();
    this.connectWebSockets();
  }

  private async fetchInitialData() {
    try {
      const futuresPairs = tradingPairRegistry.getFuturesPairs().map(p => p.symbol);
      const spotPairs = tradingPairRegistry.getSpotPairs().map(p => p.symbol);

      const fetchPromises: Promise<void>[] = [];

      if (futuresPairs.length > 0) {
        fetchPromises.push(
          fetch('https://fapi.binance.com/fapi/v1/ticker/24hr')
            .then(res => res.json())
            .then(data => {
              if (Array.isArray(data)) {
                data.forEach((item: any) => {
                  if (futuresPairs.includes(item.symbol)) {
                    this.updateTickerFromRest(item);
                  }
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
                  if (spotPairs.includes(item.symbol)) {
                    this.updateTickerFromRest(item);
                  }
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

  private updateTickerFromRest(item: any) {
    this.tickers.set(item.symbol, {
      symbol: item.symbol,
      lastPrice: item.lastPrice,
      priceChange: item.priceChange,
      priceChangePercent: item.priceChangePercent,
      high24h: item.highPrice,
      low24h: item.lowPrice,
      volume24h: item.volume,
      quoteVolume24h: item.quoteVolume,
      timestamp: item.closeTime,
    });
  }

  private connectWebSockets() {
    this.connectWs('fapi', 'wss://fstream.binance.com/ws/!ticker@arr', tradingPairRegistry.getFuturesPairs().map(p => p.symbol));
    this.connectWs('api', 'wss://stream.binance.com:9443/ws/!ticker@arr', tradingPairRegistry.getSpotPairs().map(p => p.symbol));
  }

  private connectWs(type: 'fapi' | 'api', url: string, relevantSymbols: string[]) {
    if (relevantSymbols.length === 0) return;
    
    let ws = new WebSocket(url);
    if (type === 'fapi') this.fapiWs = ws;
    else this.apiWs = ws;

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (Array.isArray(data)) {
          let updated = false;
          data.forEach((item: any) => {
            const symbol = item.s;
            if (relevantSymbols.includes(symbol)) {
              this.tickers.set(symbol, {
                symbol: symbol,
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
        this.connectWs(type, url, relevantSymbols);
      }, 5000);
    };

    ws.onerror = (err) => {
      console.error(`WebSocket error on ${type}:`, err);
      ws.close();
    };
  }
}

export const tickerService = new TickerService();
