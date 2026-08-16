const fs = require('fs');
let code = fs.readFileSync('src/services/futures/FuturesOrderService.ts', 'utf8');

if (!code.includes('reduceOnly: orderPayload.reduceOnly,')) {
    code = code.replace(
        'type: orderPayload.type,',
        'type: orderPayload.type,\n      reduceOnly: orderPayload.reduceOnly,\n      closePosition: orderPayload.closePosition,'
    );
    fs.writeFileSync('src/services/futures/FuturesOrderService.ts', code);
}
