const fs = require('fs');

let content = fs.readFileSync('src/services/futures/FuturesOrderService.ts', 'utf8');

content = content.replace(`        quantity: executedQty.toString(),
        fee: feeResult.feeAmount,
        feeAsset: 'USDT',`, `        quantity: executedQty.toString(),
        fee: feeResult.feeAmount,
        feeAsset: 'USDT',
        feeType: feeResult.feeType,
        feeRate: feeResult.feeRate,`);

fs.writeFileSync('src/services/futures/FuturesOrderService.ts', content);
