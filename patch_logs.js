const fs = require('fs');

const files = [
  'src/services/TradeService.ts',
  'src/services/OrderService.ts',
  'src/services/ledger.ts',
  'src/services/FuturesService.ts'
];

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace(/console\.warn\(.*?\);/g, '');
  content = content.replace(/console\.error\(.*?\);/g, '');
  fs.writeFileSync(file, content);
}
