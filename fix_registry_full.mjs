import fs from 'fs';

const code = `export type MarketType = 'SPOT' | 'FUTURES';

export interface TradingPair {
  symbol: string;
  apiSymbol?: string;
  baseAsset: string;
  quoteAsset: string;
  marketType: MarketType;
  tickSize: string;
  quantityPrecision: number;
  minQuantity: string;
  categories?: string[];
}

export class TradingPairRegistry {
  private pairs: Map<string, TradingPair> = new Map();
  private loaded: boolean = false;

  constructor() {
    this.registerDefaultPairs();
  }

  private registerDefaultPairs() {
    const defaultPairs: TradingPair[] = [
      {
        symbol: 'BTCUSDT',
        apiSymbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        marketType: 'FUTURES',
        tickSize: '0.10',
        quantityPrecision: 3,
        minQuantity: '0.001',
        categories: ['Layer 1', 'USDT']
      },
      {
        symbol: 'ETHUSDT',
        apiSymbol: 'ETHUSDT',
        baseAsset: 'ETH',
        quoteAsset: 'USDT',
        marketType: 'FUTURES',
        tickSize: '0.01',
        quantityPrecision: 3,
        minQuantity: '0.01',
        categories: ['Layer 1', 'DeFi', 'USDT']
      },
      {
        symbol: 'SOLUSDT',
        apiSymbol: 'SOLUSDT',
        baseAsset: 'SOL',
        quoteAsset: 'USDT',
        marketType: 'FUTURES',
        tickSize: '0.001',
        quantityPrecision: 1,
        minQuantity: '0.1',
        categories: ['Layer 1', 'USDT']
      },
      {
        symbol: 'XRPUSDT',
        apiSymbol: 'XRPUSDT',
        baseAsset: 'XRP',
        quoteAsset: 'USDT',
        marketType: 'FUTURES',
        tickSize: '0.0001',
        quantityPrecision: 0,
        minQuantity: '10',
        categories: ['Layer 1', 'USDT']
      },
      {
        symbol: 'DOGEUSDT',
        apiSymbol: 'DOGEUSDT',
        baseAsset: 'DOGE',
        quoteAsset: 'USDT',
        marketType: 'FUTURES',
        tickSize: '0.00001',
        quantityPrecision: 0,
        minQuantity: '100',
        categories: ['Meme', 'USDT']
      },
      {
        symbol: 'FETUSDT',
        apiSymbol: 'FETUSDT',
        baseAsset: 'FET',
        quoteAsset: 'USDT',
        marketType: 'FUTURES',
        tickSize: '0.0001',
        quantityPrecision: 0,
        minQuantity: '10',
        categories: ['AI', 'USDT']
      },
      {
        symbol: 'LINKUSDC',
        apiSymbol: 'LINKUSDC',
        baseAsset: 'LINK',
        quoteAsset: 'USDC',
        marketType: 'SPOT',
        tickSize: '0.001',
        quantityPrecision: 2,
        minQuantity: '1',
        categories: ['DeFi', 'RWA', 'USDC']
      },
      {
        symbol: 'BTCUSDC',
        apiSymbol: 'BTCUSDC',
        baseAsset: 'BTC',
        quoteAsset: 'USDC',
        marketType: 'SPOT',
        tickSize: '0.10',
        quantityPrecision: 3,
        minQuantity: '0.001',
        categories: ['Layer 1', 'USDC']
      }
    ];

    defaultPairs.forEach(p => this.pairs.set(p.symbol, p));
  }

  public async loadTop200() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const cacheKey = 'nova_top_200_pairs_v3';
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (parsed && parsed.timestamp && Date.now() - parsed.timestamp < 24 * 60 * 60 * 1000) {
            if (Array.isArray(parsed.pairs)) {
              parsed.pairs.forEach((p: TradingPair) => {
                if (!this.pairs.has(p.symbol)) {
                  this.pairs.set(p.symbol, p);
                }
              });
              return;
            }
          }
        } catch (e) {
          console.warn('Failed to parse cached top 200 pairs', e);
        }
      }

      const [tickerRes, exchangeInfoRes] = await Promise.all([
        fetch('https://fapi.binance.com/fapi/v1/ticker/24hr').catch(() => null),
        fetch('https://fapi.binance.com/fapi/v1/exchangeInfo').catch(() => null)
      ]);

      if (!tickerRes || !exchangeInfoRes || !tickerRes.ok || !exchangeInfoRes.ok) {
        console.warn('Failed to fetch market data for top 200 pairs');
        return;
      }

      const data = await tickerRes.json();
      const exchangeInfo = await exchangeInfoRes.json();

      if (!Array.isArray(data) || !exchangeInfo.symbols) return;

      const usdtPairs = data.filter((d: any) => d.symbol.endsWith('USDT') && parseFloat(d.quoteVolume) > 0);
      usdtPairs.sort((a: any, b: any) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
      const top200 = usdtPairs.slice(0, 200);

      const symbolInfoMap = new Map();
      exchangeInfo.symbols.forEach((s: any) => {
        symbolInfoMap.set(s.symbol, s);
      });

      const newPairs: TradingPair[] = [];

      top200.forEach((t: any) => {
        const info = symbolInfoMap.get(t.symbol);
        if (!info || info.status !== 'TRADING') return;

        let tickSize = '0.01';
        let minQty = '0.001';
        let qtyPrecision = 3;

        const priceFilter = info.filters.find((f: any) => f.filterType === 'PRICE_FILTER');
        if (priceFilter) tickSize = priceFilter.tickSize;

        const lotSize = info.filters.find((f: any) => f.filterType === 'LOT_SIZE');
        if (lotSize) minQty = lotSize.minQty;
        
        qtyPrecision = info.quantityPrecision || 3;

        const futuresPair: TradingPair = {
          symbol: t.symbol,
          apiSymbol: t.symbol,
          baseAsset: info.baseAsset,
          quoteAsset: info.quoteAsset,
          marketType: 'FUTURES',
          tickSize: parseFloat(tickSize).toString(),
          quantityPrecision: qtyPrecision,
          minQuantity: parseFloat(minQty).toString(),
          categories: ['USDT']
        };

        const spotPair: TradingPair = {
          symbol: t.symbol + '-SPOT',
          apiSymbol: t.symbol,
          baseAsset: info.baseAsset,
          quoteAsset: info.quoteAsset,
          marketType: 'SPOT',
          tickSize: parseFloat(tickSize).toString(),
          quantityPrecision: qtyPrecision,
          minQuantity: parseFloat(minQty).toString(),
          categories: ['USDT']
        };

        if (!this.pairs.has(futuresPair.symbol)) {
          this.pairs.set(futuresPair.symbol, futuresPair);
          newPairs.push(futuresPair);
        }
        
        if (!this.pairs.has(spotPair.symbol)) {
          this.pairs.set(spotPair.symbol, spotPair);
          newPairs.push(spotPair);
        }
      });

      localStorage.setItem(cacheKey, JSON.stringify({
        timestamp: Date.now(),
        pairs: newPairs
      }));

    } catch (err) {
      console.error('Failed to load top 200 pairs', err);
    }
  }

  public getPair(symbol: string): TradingPair | undefined {
    return this.pairs.get(symbol);
  }

  public getAllPairs(): TradingPair[] {
    return Array.from(this.pairs.values());
  }

  public getSpotPairs(): TradingPair[] {
    return this.getAllPairs().filter(p => p.marketType === 'SPOT');
  }

  public getFuturesPairs(): TradingPair[] {
    return this.getAllPairs().filter(p => p.marketType === 'FUTURES');
  }

  public isSupported(symbol: string): boolean {
    return this.pairs.has(symbol);
  }
}

export const tradingPairRegistry = new TradingPairRegistry();
`;

fs.writeFileSync('src/services/market/TradingPairRegistry.ts', code);
console.log("Updated TradingPairRegistry.ts");
