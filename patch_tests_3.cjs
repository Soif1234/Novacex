const fs = require('fs');
let code = fs.readFileSync('src/services/futures/CloseOrders.test.ts', 'utf8');

code = code.replaceAll("price: '60000'", "price: '70000'");

fs.writeFileSync('src/services/futures/CloseOrders.test.ts', code);
