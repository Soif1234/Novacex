import { describe, it, expect, beforeEach } from 'vitest';
import { FuturesHedgeManager, HedgePolicy } from '../src/domain/liquidity/hedge';
import { ExposureGuard, ExposureLimits, InventoryLimits } from '../src/domain/liquidity/exposure';
import { ExecutionEconomics } from '../src/domain/liquidity/economics';

describe('Phase 5.9 - Futures Liquidity & Hedging Architecture', () => {

  let guard: ExposureGuard;
  let manager: FuturesHedgeManager;

  const policy: HedgePolicy = {
    hedgeRatio: 1.0,
    minHedgeQuantity: '0',
    maxHedgeQuantity: '1000',
    minHedgeNotional: '0',
    maxHedgeNotional: '100000'
  };

  const expLimits: ExposureLimits = {
    maxNotionalPerProvider: '100000',
    maxQuantityPerProvider: '100',
    maxNotionalPerSymbol: '50000',
    maxPendingOrders: 10,
    maxPendingNotional: '90000',
    maxSingleOrderNotional: '20000',
    maxSingleOrderQuantity: '100'
  };

  const invLimits: InventoryLimits = {
    maxInventoryUsage: '1000',
    maxReservedInventory: '0',
    maxPendingInventory: '1000',
    maxPerSymbolInventory: '1000'
  };

  beforeEach(() => {
    guard = new ExposureGuard();
    guard.registerProvider('BINANCE', expLimits, invLimits);
    guard.setAvailableInventory('BINANCE', 'BTCUSDT', '1000');
    manager = new FuturesHedgeManager(guard);
  });

  it('', async () => {
    const exp = manager.calculateHedgeExposure('BTCUSDT', '10', '4', policy);
    expect(exp.netInternalQuantity).toBe('6.00000000');
    expect(exp.netInternalSide).toBe('LONG');
    expect(exp.targetHedgeSide).toBe('SELL');
    expect(exp.targetHedgeQuantity).toBe('6.00000000');
  });

  it('', async () => {
    const exp = manager.calculateHedgeExposure('BTCUSDT', '2', '12', policy);
    expect(exp.netInternalSide).toBe('SHORT');
    expect(exp.targetHedgeSide).toBe('BUY');
    expect(exp.targetHedgeQuantity).toBe('10.00000000');
  });

  it('', async () => {
    const exp = manager.calculateHedgeExposure('BTCUSDT', '5', '5', policy);
    expect(exp.netInternalSide).toBe('FLAT');
    expect(exp.targetHedgeSide).toBe('NONE');
    expect(exp.residualHedgeRequirement).toBe('0.00000000');
    
    const req = manager.createHedgeRequest('h1', exp, '50000', 'BINANCE', policy);
    expect(req).toBeNull();
  });

  it('', async () => {
    // BTC: L 20, S 5 -> Net L 15
    const btcExp = manager.calculateHedgeExposure('BTCUSDT', '20', '5', policy);
    expect(btcExp.residualHedgeRequirement).toBe('15.00000000');
    
    // ETH: L 0, S 10 -> Net S 10
    const ethExp = manager.calculateHedgeExposure('ETHUSDT', '0', '10', policy);
    expect(ethExp.residualHedgeRequirement).toBe('10.00000000');
    expect(ethExp.targetHedgeSide).toBe('BUY');
  });

  it('', async () => {
    const exp = manager.calculateHedgeExposure('BTCUSDT', '10', '0', { ...policy, hedgeRatio: 1.0 });
    expect(exp.targetHedgeQuantity).toBe('10.00000000');
  });

  it('', async () => {
    const exp = manager.calculateHedgeExposure('BTCUSDT', '10', '0', { ...policy, hedgeRatio: 0.25 });
    expect(exp.targetHedgeQuantity).toBe('2.50000000');
  });

  it('', async () => {
    // Initial request
    const exp1 = manager.calculateHedgeExposure('BTCUSDT', '10', '0', policy);
    const req = manager.createHedgeRequest('h1', exp1, '1000', 'BINANCE', policy)!;
    await manager.submitHedge(req);
    
    // Now pending should be 10. A new exposure check should yield 0 residual.
    const exp2 = manager.calculateHedgeExposure('BTCUSDT', '10', '0', policy);
    expect(exp2.pendingHedge).toBe('10.00000000');
    expect(exp2.residualHedgeRequirement).toBe('0.00000000');

    // Execute partial fill
    await manager.applyHedgeExecution('h1', '4', '1000', 'PARTIALLY_FILLED');
    
    // Pending should now be 0 for h1, executed 4. Residual 6.
    const exp3 = manager.calculateHedgeExposure('BTCUSDT', '10', '0', policy);
    expect(exp3.existingExecutedHedge).toBe('4.00000000');
    expect(exp3.pendingHedge).toBe('0.00000000');
    expect(exp3.residualHedgeRequirement).toBe('6.00000000');
  });

  it('', async () => {
    const exp = manager.calculateHedgeExposure('BTCUSDT', '10', '0', policy);
    // Notional 10 * 10,000 = 100,000. Exceeds maxSingleOrderNotional (20,000).
    expect(() => manager.createHedgeRequest('h1', exp, '10000', 'BINANCE', policy)).toThrow(/ORDER_EXPOSURE_LIMIT_EXCEEDED/);
  });

  it('', async () => {
    guard.setProviderHealth('BINANCE', 'DISABLED');
    const exp = manager.calculateHedgeExposure('BTCUSDT', '1', '0', policy);
    expect(() => manager.createHedgeRequest('h1', exp, '100', 'BINANCE', policy)).toThrow(/PROVIDER_DISABLED/);
  });

  it('', async () => {
    const p: HedgePolicy = { ...policy, minHedgeQuantity: '5', maxHedgeQuantity: '8' };
    
    // Below minimum
    const expLow = manager.calculateHedgeExposure('BTCUSDT', '4', '0', p);
    expect(expLow.targetHedgeQuantity).toBe('0.00000000');
    
    // Above maximum
    const expHigh = manager.calculateHedgeExposure('BTCUSDT', '15', '0', p);
    expect(expHigh.targetHedgeQuantity).toBe('8.00000000');
  });

  it('', async () => {
    const p: HedgePolicy = { ...policy, minHedgeNotional: '500', maxHedgeNotional: '5000' };
    
    // Below minimum notional
    const exp1 = manager.calculateHedgeExposure('BTCUSDT', '4', '0', p);
    expect(manager.createHedgeRequest('h1', exp1, '100', 'BINANCE', p)).toBeNull(); // 400 < 500

    // Above maximum notional (10 * 1000 = 10000. Capped at 5000. Qty capped at 5).
    const exp2 = manager.calculateHedgeExposure('BTCUSDT', '10', '0', p);
    const req = manager.createHedgeRequest('h2', exp2, '1000', 'BINANCE', p);
    expect(req!.quantity).toBe('5.00000000');
    expect(req!.notional).toBe('5000.00000000');
  });

  it('', async () => {
    const exp = manager.calculateHedgeExposure('BTCUSDT', '10', '0', policy);
    await manager.submitHedge(manager.createHedgeRequest('h1', exp, '10', 'BINANCE', policy)!);
    
    // Fail execution -> pending returns to 0, existing 0
    await manager.applyHedgeExecution('h1', '0', '0', 'FAILED');
    expect(manager.calculateHedgeExposure('BTCUSDT', '10', '0', policy).pendingHedge).toBe('0.00000000');
    
    // Re-submit
    await manager.submitHedge(manager.createHedgeRequest('h2', exp, '10', 'BINANCE', policy)!);
    await manager.applyHedgeExecution('h2', '10', '10', 'FILLED');
    expect(manager.calculateHedgeExposure('BTCUSDT', '10', '0', policy).existingExecutedHedge).toBe('10.00000000');
  });

  it('', async () => {
    const exp = manager.calculateHedgeExposure('BTCUSDT', '10', '0', policy);
    await manager.submitHedge(manager.createHedgeRequest('h1', exp, '10', 'BINANCE', policy)!);
    
    // Provider attempts to fill 15. System caps it at 10.
    await manager.applyHedgeExecution('h1', '15', '10', 'FILLED');
    
    const h = manager.getHedge('h1')!;
    expect(h.executedQuantity).toBe('10.00000000');
    expect(manager.calculateHedgeExposure('BTCUSDT', '10', '0', policy).existingExecutedHedge).toBe('10.00000000');
  });

  it('', async () => {
    const exp = manager.calculateHedgeExposure('BTCUSDT', '5', '0', policy);
    await manager.submitHedge(manager.createHedgeRequest('h1', exp, '10', 'BINANCE', policy)!);
    
    await manager.applyHedgeExecution('h1', '0', '0', 'UNKNOWN');
    const chk1 = manager.calculateHedgeExposure('BTCUSDT', '5', '0', policy);
    expect(chk1.pendingHedge).toBe('5.00000000'); // remains! Cannot double-hedge!

    await manager.applyHedgeExecution('h1', '0', '0', 'RECONCILING');
    expect(manager.calculateHedgeExposure('BTCUSDT', '5', '0', policy).pendingHedge).toBe('5.00000000');
  });

  it('', async () => {
    const exp = manager.calculateHedgeExposure('BTCUSDT', '2', '0', policy);
    await manager.submitHedge(manager.createHedgeRequest('h1', exp, '100', 'BINANCE', policy)!);
    await manager.applyHedgeExecution('h1', '2', '105', 'FILLED'); // slipped
    
    const econ: ExecutionEconomics = {
      requestedQuantity: '100',
      executedQuantity: '105',
      requestedPrice: '2',
      referencePrice: '2',
      averageExecutionPrice: '105',
      actualSlippage: '5',
      estimatedSlippage: '5',
      effectiveExecutionCost: '210',
      effectiveExecutionProceeds: '210',
      effectiveExecutionPrice: '105',
      providerFees: [],
      novaCEXFees: [],
      networkCosts: [],
      totalExternalCostsByAsset: {},
      totalNovaCEXCostsByAsset: {}
    };
    manager.attachEconomics('h1', econ);
    
    const h = manager.getHedge('h1')!;
    expect(h.economics?.actualSlippage).toBe('5');
  });

  it('', async () => {
    const exp = manager.calculateHedgeExposure('BTCUSDT', '5', '0', policy);
    const req = manager.createHedgeRequest('h1', exp, '100', 'BINANCE', policy);
    
    const serialized = JSON.stringify(req);
    expect(serialized).not.toContain('wallet');
    expect(serialized).not.toContain('margin');
    expect(serialized).not.toContain('pnl');
  });

  it('', async () => {
    expect(() => manager.calculateHedgeExposure('BTCUSDT', '-10', '0', policy)).toThrow(/INVALID_INTERNALLONGQTY/);
    expect(() => manager.calculateHedgeExposure('BTCUSDT', 'NaN', '0', policy)).toThrow(/INVALID_INTERNALLONGQTY/);
    
    const exp = manager.calculateHedgeExposure('BTCUSDT', '5', '0', policy);
    expect(() => manager.createHedgeRequest('h1', exp, '-10', 'BINANCE', policy)).toThrow(/INVALID_REFERENCEPRICE/);
  });

});
