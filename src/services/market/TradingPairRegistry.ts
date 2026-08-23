export type MarketType = 'SPOT' | 'FUTURES';

export interface TradingPair {
  name?: string;
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
  private spotPairs: Map<string, TradingPair> = new Map();
  private futuresPairs: Map<string, TradingPair> = new Map();
  private loaded: boolean = false;

  constructor() {
    this.registerDefaultPairs();
  }

  private registerDefaultPairs() {
    const defaultFutures: TradingPair[] = [
      {
        symbol: 'BTCUSDT',
        apiSymbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        marketType: 'FUTURES',
        tickSize: '0.10',
        quantityPrecision: 3,
        minQuantity: '0.001',
        categories: ['Layer 1', 'USDT'],
        name: 'Bitcoin'
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
        categories: ['Layer 1', 'DeFi', 'USDT'],
        name: 'Ethereum'
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
        categories: ['Layer 1', 'USDT'],
        name: 'Solana'
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
        categories: ['Layer 1', 'USDT'],
        name: 'Ripple'
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
        categories: ['Meme', 'USDT'],
        name: 'Dogecoin'
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
        categories: ['AI', 'USDT'],
        name: 'Artificial Superintelligence Alliance'
      }
    ];

    const defaultSpot: TradingPair[] = [
      {
        symbol: 'BTCUSDT',
        apiSymbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        marketType: 'SPOT',
        tickSize: '0.01',
        quantityPrecision: 3,
        minQuantity: '0.001',
        categories: ['Layer 1', 'USDT'],
        name: 'Bitcoin'
      },
      {
        symbol: 'ETHUSDT',
        apiSymbol: 'ETHUSDT',
        baseAsset: 'ETH',
        quoteAsset: 'USDT',
        marketType: 'SPOT',
        tickSize: '0.01',
        quantityPrecision: 3,
        minQuantity: '0.01',
        categories: ['Layer 1', 'DeFi', 'USDT'],
        name: 'Ethereum'
      },
      {
        symbol: 'SOLUSDT',
        apiSymbol: 'SOLUSDT',
        baseAsset: 'SOL',
        quoteAsset: 'USDT',
        marketType: 'SPOT',
        tickSize: '0.001',
        quantityPrecision: 1,
        minQuantity: '0.1',
        categories: ['Layer 1', 'USDT'],
        name: 'Solana'
      },
      {
        symbol: 'XRPUSDT',
        apiSymbol: 'XRPUSDT',
        baseAsset: 'XRP',
        quoteAsset: 'USDT',
        marketType: 'SPOT',
        tickSize: '0.0001',
        quantityPrecision: 0,
        minQuantity: '10',
        categories: ['Layer 1', 'USDT'],
        name: 'Ripple'
      },
      {
        symbol: 'DOGEUSDT',
        apiSymbol: 'DOGEUSDT',
        baseAsset: 'DOGE',
        quoteAsset: 'USDT',
        marketType: 'SPOT',
        tickSize: '0.00001',
        quantityPrecision: 0,
        minQuantity: '100',
        categories: ['Meme', 'USDT'],
        name: 'Dogecoin'
      },
      {
        symbol: 'ADAUSDT',
        apiSymbol: 'ADAUSDT',
        baseAsset: 'ADA',
        quoteAsset: 'USDT',
        marketType: 'SPOT',
        tickSize: '0.0001',
        quantityPrecision: 1,
        minQuantity: '1',
        categories: ['Layer 1', 'USDT'],
        name: 'Cardano'
      },
      {
        symbol: 'AVAXUSDT',
        apiSymbol: 'AVAXUSDT',
        baseAsset: 'AVAX',
        quoteAsset: 'USDT',
        marketType: 'SPOT',
        tickSize: '0.01',
        quantityPrecision: 2,
        minQuantity: '0.1',
        categories: ['Layer 1', 'USDT'],
        name: 'Avalanche'
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
        categories: ['DeFi', 'RWA', 'USDC'],
        name: 'Chainlink'
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
        categories: ['Layer 1', 'USDC'],
        name: 'Bitcoin'
      }
    ];

    defaultFutures.forEach(p => this.futuresPairs.set(p.symbol, p));
    defaultSpot.forEach(p => this.spotPairs.set(p.symbol, p));
  }

  public resolveCanonicalSymbol(symbol: string): string {
    if (!symbol) return 'BTCUSDT';
    // Remove legacy -SPOT / -PERP suffixes
    let cleaned = symbol.replace(/-SPOT$/i, '').replace(/-PERP$/i, '').trim();
    // Prevent BTC-SPOT -> BTC
    if (cleaned.endsWith('-SPOT')) cleaned = cleaned.replace('-SPOT', '');
    return cleaned;
  }

  public async loadTop200() {
    if (this.loaded) return;
    this.loaded = true;
    // Trading pairs are sourced from the static registry above, which is aligned with
    // the backend's supported markets. No external market-data provider (e.g. Binance)
    // is contacted from the browser.
  }

  public getSpotPair(symbol: string): TradingPair | undefined {
    if (!symbol) return undefined;
    const canonical = this.resolveCanonicalSymbol(symbol);
    return this.spotPairs.get(canonical) || this.spotPairs.get(symbol);
  }

  public getFuturesPair(symbol: string): TradingPair | undefined {
    if (!symbol) return undefined;
    const canonical = this.resolveCanonicalSymbol(symbol);
    return this.futuresPairs.get(canonical) || this.futuresPairs.get(symbol);
  }

  public getPair(symbol: string, marketType?: MarketType): TradingPair | undefined {
    if (!symbol) return undefined;
    if (marketType === 'SPOT') {
      return this.getSpotPair(symbol) || this.getFuturesPair(symbol);
    }
    if (marketType === 'FUTURES') {
      return this.getFuturesPair(symbol) || this.getSpotPair(symbol);
    }
    const canonical = this.resolveCanonicalSymbol(symbol);
    return this.futuresPairs.get(canonical) || 
           this.spotPairs.get(canonical) || 
           this.futuresPairs.get(symbol) || 
           this.spotPairs.get(symbol);
  }

  public getAllPairs(): TradingPair[] {
    return [...Array.from(this.futuresPairs.values()), ...Array.from(this.spotPairs.values())];
  }

  public getSpotPairs(): TradingPair[] {
    return Array.from(this.spotPairs.values());
  }

  public getFuturesPairs(): TradingPair[] {
    return Array.from(this.futuresPairs.values());
  }

  public isSupported(symbol: string, marketType?: MarketType): boolean {
    if (!symbol) return false;
    if (marketType === 'SPOT') return this.spotPairs.has(this.resolveCanonicalSymbol(symbol)) || this.spotPairs.has(symbol);
    if (marketType === 'FUTURES') return this.futuresPairs.has(this.resolveCanonicalSymbol(symbol)) || this.futuresPairs.has(symbol);
    const canonical = this.resolveCanonicalSymbol(symbol);
    return this.futuresPairs.has(canonical) || 
           this.spotPairs.has(canonical) || 
           this.futuresPairs.has(symbol) || 
           this.spotPairs.has(symbol);
  }
}

export const tradingPairRegistry = new TradingPairRegistry();
