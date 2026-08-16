const fs = require('fs');

let content = fs.readFileSync('src/services/futures/FuturesRiskService.ts', 'utf8');

content = content.replace(`  public calculateRoe(unrealizedPnl: string | number, initialMargin: string | number): string {`, `  public calculateNetPnl(position: FuturesPosition, markPrice: string | number): string {
    const grossPnl = new Decimal(this.calculateUnrealizedPnl(position, markPrice));
    const realizedPnl = new Decimal(position.realizedPnl || 0);
    const cumulativeFee = new Decimal(position.cumulativeFee || 0);
    const cumulativeFunding = new Decimal(position.cumulativeFunding || 0); // Note: funding paid is negative, received is positive
    
    // Net PNL = Unrealized PNL + Realized PNL - cumulative fees + cumulative funding
    // Wait, the UI might show Net PNL just for the open portion or total for the position? 
    // Usually it's total for the position (including realized if not closed out entirely yet).
    // Let's stick to: Net PNL = Gross PNL + cumulativeFunding - cumulativeFee (ignoring realized PNL from partial closes for now, or including it?)
    // Actually, Realized PNL is from partial closes. 
    return grossPnl.plus(realizedPnl).minus(cumulativeFee).plus(cumulativeFunding).toString();
  }

  public calculateRoe(unrealizedPnl: string | number, initialMargin: string | number): string {`);

fs.writeFileSync('src/services/futures/FuturesRiskService.ts', content);
