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
    try {
      const cacheKey = 'nova_top_200_pairs_v3';
      const cached = localStorage.getItem(cacheKey);
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

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1000);
      let tickerRes: any = null;
      let exchangeInfoRes: any = null;
      try {
        [tickerRes, exchangeInfoRes] = await Promise.all([
          fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', { signal: controller.signal }).catch(() => null),
          fetch('https://fapi.binance.com/fapi/v1/exchangeInfo', { signal: controller.signal }).catch(() => null)
        ]);
      } finally {
        clearTimeout(timeoutId);
      }

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
          'THETA': 'Theta Network', 'AXS': 'Axie Infinity', 'QNT': 'Quant', 'GALA': 'Gala'
        };
        const name = commonNames[info.baseAsset];
        let qtyPrecision = 3;

        const priceFilter = info.filters.find((f: any) => f.filterType === 'PRICE_FILTER');
        if (priceFilter) tickSize = priceFilter.tickSize;

        const lotSize = info.filters.find((f: any) => f.filterType === 'LOT_SIZE');
        if (lotSize) minQty = lotSize.minQty;
        
        qtyPrecision = info.quantityPrecision || 3;

        const canonicalSymbol = t.symbol;

        const futuresPair: TradingPair = {
          symbol: canonicalSymbol,
          apiSymbol: t.symbol,
          baseAsset: info.baseAsset,
          quoteAsset: info.quoteAsset,
          marketType: 'FUTURES',
          tickSize: parseFloat(tickSize).toString(),
          quantityPrecision: qtyPrecision,
          minQuantity: parseFloat(minQty).toString(),
          categories: ['USDT'],
          name: name || info.baseAsset
        };

        const spotPair: TradingPair = {
          symbol: canonicalSymbol,
          apiSymbol: t.symbol,
          baseAsset: info.baseAsset,
          quoteAsset: info.quoteAsset,
          marketType: 'SPOT',
          tickSize: parseFloat(tickSize).toString(),
          quantityPrecision: qtyPrecision,
          minQuantity: parseFloat(minQty).toString(),
          categories: ['USDT'],
          name: name || info.baseAsset
        };

        if (!this.futuresPairs.has(futuresPair.symbol)) {
          this.futuresPairs.set(futuresPair.symbol, futuresPair);
          newPairs.push(futuresPair);
        }
        
        if (!this.spotPairs.has(spotPair.symbol)) {
          this.spotPairs.set(spotPair.symbol, spotPair);
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
