const fs = require('fs');
let code = fs.readFileSync('src/services/futures/FuturesOrderService.ts', 'utf8');

if (!code.includes('filledQuantity:')) {
    code = code.replace(
        'reduceOnly: orderPayload.reduceOnly,',
        'reduceOnly: orderPayload.reduceOnly,\n      filledQuantity: "0",\n      remainingQuantity: orderPayload.quantity,'
    );
}

if (!code.includes('order.filledQuantity = order.quantity;')) {
    code = code.replace(
        "order.updatedAt = Date.now();\n    this.save();",
        "order.filledQuantity = order.quantity;\n    order.remainingQuantity = '0';\n    order.updatedAt = Date.now();\n    this.save();"
    );
}

fs.writeFileSync('src/services/futures/FuturesOrderService.ts', code);
