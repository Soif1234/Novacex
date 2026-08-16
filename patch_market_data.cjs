const fs = require('fs');
const file = 'src/hooks/useFuturesMarketData.ts';
let code = fs.readFileSync(file, 'utf8');

if (!code.includes('updateMarketPriceLocally')) {
  code = code.replace(
    'export function useFuturesMarketData',
    `export function updateMarketPriceLocally(symbol: string, newPrice: string) {
  const market = globalData.find(m => m.symbol === symbol);
  if (market) {
    market.lastPrice = newPrice;
    market.markPrice = newPrice;
    // We can also let the futuresOrderService know about the new mark prices for risk checks
    futuresOrderService.updateMarkPrices(globalData);
    notify();
  }
}

export function useFuturesMarketData`
  );
  fs.writeFileSync(file, code);
}
