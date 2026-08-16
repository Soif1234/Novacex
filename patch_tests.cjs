const fs = require('fs');
let code = fs.readFileSync('src/services/futures/CloseOrders.test.ts', 'utf8');

// For LONG limit close, change PENDING limit to 70000
code = code.replace(
  "type: 'LIMIT', price: '60000', quantity: '1', leverage: 10, marginMode: 'ISOLATED',",
  "type: 'LIMIT', price: '70000', quantity: '1', leverage: 10, marginMode: 'ISOLATED',"
);

// For LONG limit close, change FILLED limit to 60000
code = code.replace(
  "type: 'LIMIT', price: '40000', quantity: '1', leverage: 10, marginMode: 'ISOLATED',",
  "type: 'LIMIT', price: '60000', quantity: '1', leverage: 10, marginMode: 'ISOLATED',"
);

// For Partial LONG close, change FILLED limit to 60000
code = code.replace(
  "type: 'LIMIT', price: '40000', quantity: '0.4', leverage: 10, marginMode: 'ISOLATED',",
  "type: 'LIMIT', price: '60000', quantity: '0.4', leverage: 10, marginMode: 'ISOLATED',"
);

// For SHORT limit close, limit to 60000 is 64230.50 >= 60000, wait, for SHORT it's a BUY limit.
// BUY executes when currentPrice <= limitPrice.
// currentPrice is 64230.50. So if limit is 60000, 64230.50 <= 60000 is FALSE -> PENDING.
// If limit is 70000, 64230.50 <= 70000 is TRUE -> FILLED.
code = code.replace(
  "type: 'LIMIT', price: '60000', quantity: '1', leverage: 10, marginMode: 'ISOLATED',",
  "type: 'LIMIT', price: '70000', quantity: '1', leverage: 10, marginMode: 'ISOLATED',"
);

code = code.replace(
  "// 50000 <= 60000, executes immediately!",
  "// 64230 <= 70000, executes immediately!"
);

// For Partial SHORT close, limit to 70000 to execute
code = code.replace(
  "type: 'LIMIT', price: '60000', quantity: '0.3', leverage: 10, marginMode: 'ISOLATED',",
  "type: 'LIMIT', price: '70000', quantity: '0.3', leverage: 10, marginMode: 'ISOLATED',"
);

// For cancel pending close order, it's a LONG position, so SELL order.
// To make it PENDING, we need it to be above current price (70000).
code = code.replace(
  "type: 'LIMIT', price: '60000', quantity: '1', leverage: 10, marginMode: 'ISOLATED',",
  "type: 'LIMIT', price: '70000', quantity: '1', leverage: 10, marginMode: 'ISOLATED',"
);

fs.writeFileSync('src/services/futures/CloseOrders.test.ts', code);
