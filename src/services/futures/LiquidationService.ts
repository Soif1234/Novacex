import { Decimal } from 'decimal.js';
import { FuturesPosition, FuturesLiquidation } from '../../types/futures';
import { futuresRiskService } from './FuturesRiskService';
import { demoLedger } from '../ledger';

export class LiquidationService {
  private liquidations: FuturesLiquidation[] = [];
  private liquidatedPositionIds: Set<string> = new Set();
  
  public getLiquidations(): FuturesLiquidation[] {
    return [...this.liquidations];
  }
  
  public liquidatePosition(position: FuturesPosition): FuturesPosition | null {
    if (this.liquidatedPositionIds.has(position.positionId) || position.status !== 'OPEN') {
      return null; // Already liquidated or not open
    }
    
    // We determine the final realized PNL and how much margin is lost.
    // In this simplified DEMO system, liquidation means losing the entire position equity.
    // Which means: Unrealized PNL becomes Realized PNL, and we return whatever margin remains,
    // but typically a liquidation fee would consume the rest. 
    // To keep it simple and safe for DEMO:
    // When liquidated, the position is closed at mark price.
    
    const ep = new Decimal(position.entryPrice);
    const mp = new Decimal(position.markPrice);
    const q = new Decimal(position.quantity);
    
    const realizedPnl = futuresRiskService.calculateUnrealizedPnl(position, position.markPrice);
    const im = new Decimal(position.initialMargin);
    const rpnl = new Decimal(realizedPnl);
    
    // Fee = Position Notional * Taker Fee (assume 0.05% for liquidation)
    const notional = new Decimal(futuresRiskService.calculateNotional(position.quantity, position.markPrice));
    const fee = notional.mul(0.0005);
    
    // Total return to ledger = Initial Margin + Realized PNL - Fee
    // If it's negative, we clamp to 0 for demo purposes (we don't take cross margin balance beyond what's available or isolate margin).
    const totalReturnRaw = im.plus(rpnl).minus(fee);
    const totalReturn = totalReturnRaw.lt(0) ? new Decimal(0) : totalReturnRaw;
    
    // Actual deficit if it was less than 0
    const deficit = totalReturnRaw.lt(0) ? totalReturnRaw.abs() : new Decimal(0);
    
    // Create liquidation record
    const liq: FuturesLiquidation = {
      liquidationId: Math.random().toString(36).substring(2, 11),
      accountId: position.accountId,
      positionId: position.positionId,
      symbol: position.symbol,
      side: position.side,
      quantity: position.quantity,
      markPrice: position.markPrice,
      liquidationPrice: position.liquidationPrice,
      realizedPnl: realizedPnl,
      fee: fee.toString(),
      timestamp: Date.now(),
      reason: 'DEMO_LIQUIDATION'
    };
    
    this.liquidations.push(liq);
    this.liquidatedPositionIds.add(position.positionId);
    
    // Ledger updates
    // In FuturesPnl, margin was already taken from the ledger.
    // We just credit back the remaining equity.
    if (totalReturn.gt(0)) {
      demoLedger.credit('FUTURES_USDT', totalReturn.toString(), `Liquidation return for ${position.symbol} ${position.side} order ${position.positionId}`);
    }
    
    // If CROSS margin and there's a deficit, we deduct from available balance
    if (position.marginMode === 'CROSS' && deficit.gt(0)) {
       const available = new Decimal(demoLedger.getBalance('FUTURES_USDT'));
       const deduct = Decimal.min(available, deficit);
       if (deduct.gt(0)) {
         demoLedger.debit('FUTURES_USDT', deduct.toString(), `Liquidation deficit cross-margin deduction for ${position.symbol} ${position.side}`);
       }
    }
    
    return {
      ...position,
      status: 'LIQUIDATED',
      realizedPnl: realizedPnl,
      updatedAt: Date.now()
    };
  }
}

export const liquidationService = new LiquidationService();
