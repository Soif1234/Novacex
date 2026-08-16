export type MarketType = 'SPOT' | 'FUTURES';

export interface TradingPair {
  symbol: string;
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

  constructor() {
    this.registerDefaultPairs();
  }

  private registerDefaultPairs() {
    const defaultPairs: TradingPair[] = [
      {
        symbol: 'BTCUSDT',
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
