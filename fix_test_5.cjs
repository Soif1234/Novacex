const fs = require('fs');
let code = fs.readFileSync('src/services/futures/FuturesFeeIntegration.test.ts', 'utf8');

code = code.replace(
  "const feeEntry = ledger.getHistory().find(h => h.timestamp >= Date.now() - 5000 && h.reason.includes('rejected')); // Just dummy, the history is shared",
  "const feeEntry = ledger.getHistory().find(h => h.reason.includes('TRADING_FEE'));"
);

fs.writeFileSync('src/services/futures/FuturesFeeIntegration.test.ts', code);
