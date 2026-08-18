import fs from 'fs';

function fixFile(file) {
  let content = fs.readFileSync(file, 'utf-8');
  // Match tickerService.updateTickerFromRest({ symbol: 'BTCUSDT', ... })
  content = content.replace(/tickerService\.updateTickerFromRest\(\{\s*symbol:\s*'([^']+)',/g, "tickerService.updateTickerFromRest('$1', {\n      symbol: '$1',");
  fs.writeFileSync(file, content);
  console.log("Fixed", file);
}

fixFile('src/services/market/TickerService.test.ts');
fixFile('src/pages/Markets.test.tsx');

