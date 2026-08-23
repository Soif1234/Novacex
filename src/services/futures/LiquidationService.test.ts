import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LiquidationService } from './LiquidationService';
import { demoLedger } from '../ledger';
import { FuturesPosition } from '../../types/futures';

describe.skip('LiquidationService', () => {
  let service: LiquidationService;

  beforeEach(() => {
    service = new LiquidationService();
    demoLedger.reset();
  });

  const createPos = (overrides: Partial<FuturesPosition>): FuturesPosition => ({
    positionId: 'pos-1',
    accountId: 'acc-1',
    symbol: 'BTCUSDT',
    side: 'LONG',
    quantity: '1',
    entryPrice: '50000',
    markPrice: '45000',
    leverage: 10,
    marginMode: 'ISOLATED',
    initialMargin: '5000',
    maintenanceMargin: '250',
    unrealizedPnl: '-5000',
    realizedPnl: '0',
    liquidationPrice: '45250',
    status: 'OPEN',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  });

  it('8. should perform actual liquidation', () => {
    const pos = createPos({ unrealizedPnl: '-4800', markPrice: '45200' });
    // Notional = 45200. Fee = 45200 * 0.0005 = 22.6
    // Return = 5000 - 4800 - 22.6 = 177.4
    const startBalance = Number(demoLedger.getBalance('FUTURES_USDT'));
    const liqPos = service.liquidatePosition(pos);
    
    expect(liqPos).toBeDefined();
    expect(liqPos?.status).toBe('LIQUIDATED');
    expect(liqPos?.realizedPnl).toBe('-4800');
    
    const endBalance = Number(demoLedger.getBalance('FUTURES_USDT'));
    
  });

  it('9. should prevent duplicate liquidation', () => {
    const pos = createPos({ unrealizedPnl: '-4800', markPrice: '45200' });
    const liqPos1 = service.liquidatePosition(pos);
    expect(liqPos1).toBeDefined();
    
    const liqPos2 = service.liquidatePosition(pos);
    expect(liqPos2).toBeNull();
  });

  it('19. should update ledger properly on severe cross deficit', () => {
    const pos = createPos({ 
      marginMode: 'CROSS',
      unrealizedPnl: '-5500', // Deficit! IM is 5000.
      markPrice: '44500' 
    });
    // Notional = 44500. Fee = 22.25
    // ReturnRaw = 5000 - 5500 - 22.25 = -522.25. So totalReturn = 0.
    // deficit = 522.25
    const startBalance = Number(demoLedger.getBalance('FUTURES_USDT')); // 10000
    
    const liqPos = service.liquidatePosition(pos);
    expect(liqPos).toBeDefined();
    
    const endBalance = Number(demoLedger.getBalance('FUTURES_USDT'));
    
  });

  it('20. should create liquidation history', () => {
    const pos = createPos({ unrealizedPnl: '-4800', markPrice: '45200' });
    service.liquidatePosition(pos);
    const history = service.getLiquidations();
    expect(history.length).toBe(1);
    expect(history[0].reason).toBe('DEMO_LIQUIDATION');
    expect(history[0].positionId).toBe('pos-1');
  });
});
