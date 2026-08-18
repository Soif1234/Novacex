import fs from 'fs';

const p = 'src/components/futures/FuturesChart.tsx';
let code = fs.readFileSync(p, 'utf-8');

code = code.replace(
  "export function FuturesChart({ market }: FuturesChartProps) {",
  "import { tradingPairRegistry } from '../../services/market/TradingPairRegistry';\n\nexport function FuturesChart({ market }: FuturesChartProps) {\n  const pair = tradingPairRegistry.getPair(market.symbol || (market as any).id);\n  const apiSym = pair ? pair.apiSymbol || pair.symbol : (market.symbol || (market as any).id);\n  const marketType = pair ? pair.marketType : 'FUTURES';"
);

code = code.replace(/market\.marketType === 'SPOT'/g, "marketType === 'SPOT'");
code = code.replace(/market\.apiSymbol \|\| market\.symbol/g, "apiSym");
code = code.replace(/const apiSym = \(market\.apiSymbol \|\| market\.symbol\)\.toLowerCase\(\);/g, "const wsApiSym = apiSym.toLowerCase();");
code = code.replace(/\$\{apiSym\}@kline_/g, "${wsApiSym}@kline_");

fs.writeFileSync(p, code);
console.log("Updated FuturesChart.tsx");
