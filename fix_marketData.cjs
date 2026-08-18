const fs = require('fs');
let code = fs.readFileSync('src/services/marketData.ts', 'utf8');
code = code.replace(
  "const { tradingPairRegistry } = require('./market/TradingPairRegistry');\n    const targetSymbols = tradingPairRegistry.getAllPairs().map(p => p.symbol);\n    const symbols = JSON.stringify(targetSymbols);",
  "const targetSymbols = tradingPairRegistry.getAllPairs().map(p => p.symbol);\n    const symbols = JSON.stringify(targetSymbols);"
);
code = "import { tradingPairRegistry } from './market/TradingPairRegistry';\n" + code;
fs.writeFileSync('src/services/marketData.ts', code);
