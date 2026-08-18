const fs = require('fs');

let content = fs.readFileSync('src/types/futures.ts', 'utf8');

content = content.replace(`  unrealizedPnl: string;
  realizedPnl: string;
  liquidationPrice: string;
  status: PositionStatus;`, `  unrealizedPnl: string;
  realizedPnl: string;
  liquidationPrice: string;
  status: PositionStatus;
  cumulativeFee?: string;
  cumulativeFunding?: string;`);

fs.writeFileSync('src/types/futures.ts', content);
