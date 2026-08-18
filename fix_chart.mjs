import fs from 'fs';

const p = 'src/components/futures/FuturesChart.tsx';
let code = fs.readFileSync(p, 'utf-8');

// 1. Replace klines URL
code = code.replace(
  /\`https:\/\/fapi\.binance\.com\/fapi\/v1\/klines\?symbol=\$\{symbol\.toUpperCase\(\)\}&interval=\$\{binanceInterval\}&limit=500\`/g,
  "market.marketType === 'SPOT' ? `https://api.binance.com/api/v3/klines?symbol=${market.apiSymbol || market.symbol}&interval=${binanceInterval}&limit=500` : `https://fapi.binance.com/fapi/v1/klines?symbol=${market.apiSymbol || market.symbol}&interval=${binanceInterval}&limit=500`"
);

// 2. Replace WS URL
code = code.replace(
  "const wsUrl = `wss://fstream.binance.com/ws/${symbol.toLowerCase()}@kline_${binanceInterval}`;",
  "const apiSym = (market.apiSymbol || market.symbol).toLowerCase();\n    const wsUrl = market.marketType === 'SPOT' ? `wss://stream.binance.com:9443/ws/${apiSym}@kline_${binanceInterval}` : `wss://fstream.binance.com/ws/${apiSym}@kline_${binanceInterval}`; // Use apiSym"
);

fs.writeFileSync(p, code);
console.log("Updated FuturesChart.tsx");
