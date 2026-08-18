const fs = require('fs');
let code = fs.readFileSync('src/services/marketData.ts', 'utf8');
code = code.replace(
  "const targetSymbols = JSON.parse(symbols);",
  "// targetSymbols already available"
);
fs.writeFileSync('src/services/marketData.ts', code);
