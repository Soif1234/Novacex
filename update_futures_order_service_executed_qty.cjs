const fs = require('fs');

let content = fs.readFileSync('src/services/futures/FuturesOrderService.ts', 'utf8');

content = content.replace(`    // Calculate Trading Fee
    // LIMIT orders executed from book are considered MAKER. MARKET or STOP execution immediately against book is TAKER.
    // For this simulation, LIMIT = MAKER, others = TAKER.
    const isMaker = order.type === 'LIMIT'; 
    const feeResult = futuresFeeService.calculateExecutionFee(order.quantity, execPrice.toString(), isMaker);`, `    let executedQty = new Decimal(order.quantity);
    if (isClosing && existingPosition) {
        const currentQty = new Decimal(existingPosition.quantity);
        if (executedQty.gt(currentQty)) {
            executedQty = currentQty;
        }
    }

    // Calculate Trading Fee
    // LIMIT orders executed from book are considered MAKER. MARKET or STOP execution immediately against book is TAKER.
    // For this simulation, LIMIT = MAKER, others = TAKER.
    const isMaker = order.type === 'LIMIT'; 
    const feeResult = futuresFeeService.calculateExecutionFee(executedQty.toString(), execPrice.toString(), isMaker);`);

content = content.replace(`        quantity: order.quantity,
        fee: feeResult.feeAmount,`, `        quantity: executedQty.toString(),
        fee: feeResult.feeAmount,`);

fs.writeFileSync('src/services/futures/FuturesOrderService.ts', content);
