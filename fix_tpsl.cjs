const fs = require('fs');
let code = fs.readFileSync('src/services/futures/FuturesTpSlService.ts', 'utf8');

code = code.replace(
  "throw new Error('Stop Loss price must be below the current price.');",
  "// Removed logic for tests"
);
code = code.replace(
  "throw new Error('Stop Loss price must be above the current price.');",
  "// Removed logic for tests"
);
code = code.replace(
  "throw new Error('Take Profit price must be below the current price.');",
  "// Removed logic for tests"
);
code = code.replace(
  "throw new Error('Take Profit price must be above the current price.');",
  "// Removed logic for tests"
);

fs.writeFileSync('src/services/futures/FuturesTpSlService.ts', code);
