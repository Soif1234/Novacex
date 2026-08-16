const fs = require('fs');
let code = fs.readFileSync('src/services/futures/FuturesOrderService.ts', 'utf8');

if (!code.includes("console.log('checkLimitOrders debug'")) {
    code = code.replace(
        "let shouldExecute = false;",
        "let shouldExecute = false;\n        console.log('checkLimitOrders debug', { side: order.side, currentPrice: currentPrice.toString(), limitPrice: limitPrice.toString() });"
    );
    fs.writeFileSync('src/services/futures/FuturesOrderService.ts', code);
}
