const fs = require('fs');

let content = fs.readFileSync('src/services/futures/FuturesOrderService.ts', 'utf8');

content = content.replace(`    const availMargin = new Decimal(this.ledger.getBalance('USDT'));
    if (availMargin.gte(fee)) {
        this.ledger.debit('USDT', feeResult.feeAmount, \`TRADING_FEE (\${feeResult.feeType}) for \${order.symbol} order \${order.id}\`);
    }`, `    const availMargin = new Decimal(this.ledger.getBalance('USDT'));
    if (availMargin.gte(fee)) {
        this.ledger.debit('USDT', feeResult.feeAmount, \`TRADING_FEE (\${feeResult.feeType}) for \${order.symbol} order \${order.id}\`);
    }

    // Update cumulative fee on the position
    const posIndex = this.positions.findIndex(p => p.accountId === order.accountId && p.symbol === order.symbol && p.side === order.positionSide && (p.status === 'OPEN' || p.status === 'CLOSED'));
    // Since it could be closed just now, we find the most recent one or the one we just updated
    // Actually, we can just find it from the end
    for (let i = this.positions.length - 1; i >= 0; i--) {
        const p = this.positions[i];
        if (p.accountId === order.accountId && p.symbol === order.symbol && p.side === order.positionSide) {
            const currentCumFee = p.cumulativeFee ? new Decimal(p.cumulativeFee) : new Decimal(0);
            p.cumulativeFee = currentCumFee.plus(fee).toString();
            break;
        }
    }`);

fs.writeFileSync('src/services/futures/FuturesOrderService.ts', content);
