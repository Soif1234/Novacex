const fs = require('fs');
let code = fs.readFileSync('src/services/futures/MultiPair.test.ts', 'utf8');

code = code.replace(
    "{ ETHUSDT: '0.01', BTCUSDT: '-0.01' }",
    "{ ETHUSDT: '3000', BTCUSDT: '60000' }"
);

fs.writeFileSync('src/services/futures/MultiPair.test.ts', code);
