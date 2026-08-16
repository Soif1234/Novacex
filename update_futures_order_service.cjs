const fs = require('fs');

let content = fs.readFileSync('src/services/futures/FuturesOrderService.ts', 'utf8');

// Replace fee calculation logic
content = content.replace(`    const notional = futuresRiskService.calculateNotional(order.quantity, execPrice.toString());
    const makerFeeRate = order.type === 'LIMIT' ? market.makerFee : market.takerFee;
    const fee = new Decimal(notional).mul(new Decimal(makerFeeRate));
    
    const availMargin = new Decimal(this.ledger.getBalance('USDT'));
    if (availMargin.gte(fee)) {
        this.ledger.debit('USDT', fee.toString(), \`Trading fee for \${order.symbol} order \${order.id}\`);
    }`, `    // Calculate Trading Fee
    // LIMIT orders executed from book are considered MAKER. MARKET or STOP execution immediately against book is TAKER.
    // For this simulation, LIMIT = MAKER, others = TAKER.
    const isMaker = order.type === 'LIMIT'; 
    const feeResult = futuresFeeService.calculateExecutionFee(order.quantity, execPrice.toString(), isMaker);
    const fee = new Decimal(feeResult.feeAmount);
    
    const availMargin = new Decimal(this.ledger.getBalance('USDT'));
    if (availMargin.gte(fee)) {
        this.ledger.debit('USDT', feeResult.feeAmount, \`TRADING_FEE (\${feeResult.feeType}) for \${order.symbol} order \${order.id}\`);
    }`);

content = content.replace(`import { DemoLedger, demoLedger } from '../ledger';`, `import { DemoLedger, demoLedger } from '../ledger';
import { futuresFeeService } from './FuturesFeeService';`);

fs.writeFileSync('src/services/futures/FuturesOrderService.ts', content);
