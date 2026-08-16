const fs = require('fs');
let code = fs.readFileSync('src/services/marketData.ts', 'utf8');
code = code.replace(
  "const symbols = '[\"BTCUSDT\",\"ETHUSDT\",\"SOLUSDT\",\"XRPUSDT\",\"DOGEUSDT\"]';",
  "const { tradingPairRegistry } = require('./market/TradingPairRegistry');\n    const targetSymbols = tradingPairRegistry.getAllPairs().map(p => p.symbol);\n    const symbols = JSON.stringify(targetSymbols);"
);
fs.writeFileSync('src/services/marketData.ts', code);
