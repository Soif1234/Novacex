const fs = require('fs');
let code = fs.readFileSync('src/services/futures/CloseOrders.test.ts', 'utf8');

// closeOrder2 should trigger immediately, so limit price < currentPrice for SELL
code = code.replace(
  "type: 'LIMIT', price: '70000', quantity: '1', leverage: 10, marginMode: 'ISOLATED',\n      reduceOnly: true, closePosition: true\n    });\n    \n    expect(closeOrder2.status).toBe('FILLED');",
  "type: 'LIMIT', price: '60000', quantity: '1', leverage: 10, marginMode: 'ISOLATED',\n      reduceOnly: true, closePosition: true\n    });\n    \n    expect(closeOrder2.status).toBe('FILLED');"
);

// partial long should trigger immediately, so limit price < currentPrice for SELL
code = code.replace(
  "type: 'LIMIT', price: '70000', quantity: '0.4', leverage: 10, marginMode: 'ISOLATED',\n      reduceOnly: true, closePosition: true",
  "type: 'LIMIT', price: '60000', quantity: '0.4', leverage: 10, marginMode: 'ISOLATED',\n      reduceOnly: true, closePosition: true"
);

fs.writeFileSync('src/services/futures/CloseOrders.test.ts', code);
