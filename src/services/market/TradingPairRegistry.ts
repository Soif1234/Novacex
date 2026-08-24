import { apiClient } from '../api/client';

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

  public registerPairFromTicker(symbol: string, lastPrice?: string): TradingPair {
    const cleanSym = this.resolveCanonicalSymbol(symbol);
    const existing = this.getPair(cleanSym);
    if (existing) return existing;

    let quoteAsset = 'USDT';
    let baseAsset = cleanSym;
    if (cleanSym.endsWith('USDT')) {
      quoteAsset = 'USDT';
      baseAsset = cleanSym.slice(0, -4);
    } else if (cleanSym.endsWith('USDC')) {
      quoteAsset = 'USDC';
      baseAsset = cleanSym.slice(0, -4);
    }

    const priceNum = parseFloat(lastPrice || '1');
    let tickSize = '0.01';
    let quantityPrecision = 2;
    let minQuantity = '0.01';

    if (priceNum >= 1000) {
      tickSize = '0.10';
      quantityPrecision = 3;
      minQuantity = '0.001';
    } else if (priceNum >= 10) {
      tickSize = '0.01';
      quantityPrecision = 2;
      minQuantity = '0.01';
    } else if (priceNum >= 1) {
      tickSize = '0.001';
      quantityPrecision = 1;
      minQuantity = '0.1';
    } else if (priceNum >= 0.01) {
      tickSize = '0.0001';
      quantityPrecision = 0;
      minQuantity = '10';
    } else {
      tickSize = '0.00001';
      quantityPrecision = 0;
      minQuantity = '100';
    }

    const commonNames: Record<string, string> = {
      'BTC': 'Bitcoin', 'ETH': 'Ethereum', 'SOL': 'Solana', 'XRP': 'Ripple',
      'DOGE': 'Dogecoin', 'ADA': 'Cardano', 'AVAX': 'Avalanche', 'LINK': 'Chainlink',
      'DOT': 'Polkadot', 'MATIC': 'Polygon', 'SHIB': 'Shiba Inu', 'LTC': 'Litecoin',
      'BCH': 'Bitcoin Cash', 'ATOM': 'Cosmos', 'UNI': 'Uniswap', 'XLM': 'Stellar',
      'NEAR': 'NEAR Protocol', 'APT': 'Aptos', 'ARB': 'Arbitrum', 'OP': 'Optimism',
      'FIL': 'Filecoin', 'INJ': 'Injective', 'LDO': 'Lido DAO', 'RNDR': 'Render',
      'STX': 'Stacks', 'IMX': 'Immutable', 'VET': 'VeChain', 'GRT': 'The Graph',
      'SNX': 'Synthetix', 'AAVE': 'Aave', 'MKR': 'Maker', 'ALGO': 'Algorand',
      'FTM': 'Fantom', 'SAND': 'The Sandbox', 'MANA': 'Decentraland', 'EGLD': 'MultiversX',
      'THETA': 'Theta Network', 'AXS': 'Axie Infinity', 'QNT': 'Quant', 'GALA': 'Gala',
      'PEPE': 'Pepe', 'SUI': 'Sui', 'SEI': 'Sei', 'TIA': 'Celestia', 'WIF': 'dogwifhat',
      'BONK': 'Bonk', 'FLOKI': 'Floki', 'RENDER': 'Render', 'FET': 'Fetch.ai', 'TAO': 'Bittensor'
    };

    const name = commonNames[baseAsset] || baseAsset;

    const futuresPair: TradingPair = {
      symbol: cleanSym,
      apiSymbol: cleanSym,
      baseAsset,
      quoteAsset,
      marketType: 'FUTURES',
      tickSize,
      quantityPrecision,
      minQuantity,
      categories: [quoteAsset],
      name
    };

    const spotPair: TradingPair = {
      symbol: cleanSym,
      apiSymbol: cleanSym,
      baseAsset,
      quoteAsset,
      marketType: 'SPOT',
      tickSize,
      quantityPrecision,
      minQuantity,
      categories: [quoteAsset],
      name
    };

    if (!this.futuresPairs.has(cleanSym)) this.futuresPairs.set(cleanSym, futuresPair);
    if (!this.spotPairs.has(cleanSym)) this.spotPairs.set(cleanSym, spotPair);

    return futuresPair;
  }

  public async loadTop200() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const cacheKey = 'nova_top_200_pairs_v4';
      const cached = typeof localStorage !== 'undefined' ? localStorage.getItem(cacheKey) : null;
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (parsed && parsed.timestamp && Date.now() - parsed.timestamp < 24 * 60 * 60 * 1000) {
            if (Array.isArray(parsed.pairs)) {
              parsed.pairs.forEach((p: TradingPair) => {
                const canonicalSym = this.resolveCanonicalSymbol(p.symbol);
                const normalized: TradingPair = {
                  ...p,
                  symbol: canonicalSym
                };
                if (p.marketType === 'FUTURES') {
                  if (!this.futuresPairs.has(canonicalSym)) this.futuresPairs.set(canonicalSym, normalized);
                } else {
                  if (!this.spotPairs.has(canonicalSym)) this.spotPairs.set(canonicalSym, normalized);
                }
              });
              return;
            }
          }
        } catch (e) {
          console.warn('Failed to parse cached top 200 pairs', e);
        }
      }

      // Fetch from NovaCEX authoritative backend proxy endpoint
      const res = await apiClient.get<{ tickers: any[] }>('/market/tickers').catch(() => null);
      const tickers = (res && (res as any).tickers)
        ? (res as any).tickers
        : (Array.isArray(res) ? (res as any) : []);

      if (Array.isArray(tickers) && tickers.length > 0) {
        const newPairs: TradingPair[] = [];
        tickers.forEach((t: any) => {
          if (t && t.symbol) {
            const pair = this.registerPairFromTicker(t.symbol, t.lastPrice);
            newPairs.push(pair);
          }
        });

        if (typeof localStorage !== 'undefined' && newPairs.length > 0) {
          localStorage.setItem(cacheKey, JSON.stringify({
            timestamp: Date.now(),
            pairs: newPairs
          }));
        }
      }
    } catch (err) {
      console.warn('Failed to load top 200 pairs from backend:', err);
    }
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
