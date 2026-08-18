import fs from 'fs';

const p = 'src/services/market/TradingPairRegistry.ts';
let code = fs.readFileSync(p, 'utf-8');

if (!code.includes('apiSymbol?: string;')) {
  code = code.replace('symbol: string;', 'symbol: string;\n  apiSymbol?: string;');
  code = code.replace('public isSupported(symbol: string): boolean {', `
  public async loadTop200() {
    try {
      const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
      const data = await res.json();
      if (!Array.isArray(data)) return;
      
      const usdtPairs = data.filter(d => d.symbol.endsWith('USDT') && parseFloat(d.quoteVolume) > 0);
      usdtPairs.sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
      const top200 = usdtPairs.slice(0, 200);

      top200.forEach(t => {
        // Add Futures
        if (!this.pairs.has(t.symbol)) {
          this.pairs.set(t.symbol, {
            symbol: t.symbol,
            apiSymbol: t.symbol,
            baseAsset: t.symbol.replace('USDT', ''),
            quoteAsset: 'USDT',
            marketType: 'FUTURES',
            tickSize: '0.01',
            quantityPrecision: 3,
            minQuantity: '0.1',
            categories: ['USDT']
          });
        }
        
        // Add Spot
        const spotSymbol = t.symbol + '-SPOT';
        if (!this.pairs.has(spotSymbol)) {
          this.pairs.set(spotSymbol, {
            symbol: spotSymbol,
            apiSymbol: t.symbol,
            baseAsset: t.symbol.replace('USDT', ''),
            quoteAsset: 'USDT',
            marketType: 'SPOT',
            tickSize: '0.01',
            quantityPrecision: 3,
            minQuantity: '0.1',
            categories: ['USDT']
          });
        }
      });
      console.log('Loaded top 200 pairs');
    } catch (err) {
      console.error('Failed to load top 200 pairs', err);
    }
  }

  public getApiSymbol(symbol: string): string {
    const pair = this.pairs.get(symbol);
    return pair?.apiSymbol || pair?.symbol || symbol;
  }

  public isSupported(symbol: string): boolean {`);
  fs.writeFileSync(p, code);
  console.log("Updated TradingPairRegistry.ts");
}
