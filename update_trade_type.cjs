const fs = require('fs');

let content = fs.readFileSync('src/types/futures.ts', 'utf8');

content = content.replace(`  feeAsset: string;
  realizedPnl: string;`, `  feeAsset: string;
  feeType?: 'MAKER' | 'TAKER';
  feeRate?: string;
  realizedPnl: string;`);

fs.writeFileSync('src/types/futures.ts', content);
