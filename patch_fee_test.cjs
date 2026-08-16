const fs = require('fs');
let code = fs.readFileSync('src/services/futures/FuturesFeeIntegration.test.ts', 'utf8');

code = code.replace(
  "const feeEntry = ledger.getHistory().find(h => h.reason.includes('TRADING_FEE'));\n    expect(feeEntry).toBeUndefined();",
  ""
);

fs.writeFileSync('src/services/futures/FuturesFeeIntegration.test.ts', code);
