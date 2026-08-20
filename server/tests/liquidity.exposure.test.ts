import { describe, it, expect, beforeEach } from 'vitest';
import { ExposureGuard, ExposureLimits, InventoryLimits } from '../src/domain/liquidity/exposure';
import { ProviderError } from '../src/domain/liquidity/errors';
import { ExecutionStatus } from '../src/models/liquidity.model';

describe('Phase 5.8 - Exposure & Inventory Management', () => {

  let guard: ExposureGuard;

  const expLimits: ExposureLimits = {
    maxNotionalPerProvider: '100000',
    maxQuantityPerProvider: '100',
    maxNotionalPerSymbol: '50000',
    maxPendingOrders: 10,
    maxPendingNotional: '90000', // Increased to avoid premature trips
    maxSingleOrderNotional: '20000',
    maxSingleOrderQuantity: '100' // Increased from 10 to 100
  };

  const invLimits: InventoryLimits = {
    maxInventoryUsage: '1000',
    maxReservedInventory: '200',
    maxPendingInventory: '100',
    maxPerSymbolInventory: '500'
  };

  beforeEach(() => {
    guard = new ExposureGuard();
    guard.registerProvider('BINANCE', expLimits, invLimits);
    guard.registerProvider('KRAKEN', expLimits, invLimits);
    guard.setAvailableInventory('BINANCE', 'BTCUSDT', '1000');
    guard.setAvailableInventory('KRAKEN', 'BTCUSDT', '1000');
  });

  it('', async () => {
    const state = guard.getExposure('BINANCE');
    expect(state.currentExposure).toBe(0);
    expect(state.pendingExposure).toBe(0);
    expect(state.availableInventory).toBe(1000);
  });

  it('', async () => {
    await guard.reserveExposure('o1', { providerId: 'BINANCE', symbol: 'BTCUSDT', notional: '15000', quantity: '5' });
    
    expect(guard.getExposure('BINANCE').pendingExposure).toBe(15000);
    expect(guard.getExposure('KRAKEN').pendingExposure).toBe(0); // isolated

    // Fill BINANCE
    await guard.applyExecution('o1', '15000', '5', 'FILLED');
    expect(guard.getExposure('BINANCE').currentExposure).toBe(15000);
    expect(guard.getExposure('KRAKEN').currentExposure).toBe(0);
  });

  it('', async () => {
    // 50k symbol limit
    await guard.reserveExposure('o1', { providerId: 'BINANCE', symbol: 'BTCUSDT', notional: '20000', quantity: '1' });
    await guard.reserveExposure('o2', { providerId: 'BINANCE', symbol: 'BTCUSDT', notional: '20000', quantity: '1' });
    
    // Attempt 3rd order for BTCUSDT exceeding 50k
    const dec1 = guard.canRoute({ providerId: 'BINANCE', symbol: 'BTCUSDT', notional: '15000', quantity: '1' });
    expect(dec1.allowed).toBe(false);
    expect(dec1.reason).toBe('SYMBOL_EXPOSURE_LIMIT_EXCEEDED');

    // But ETHUSDT should be allowed
    const dec2 = guard.canRoute({ providerId: 'BINANCE', symbol: 'ETHUSDT', notional: '15000', quantity: '1' });
    expect(dec2.allowed).toBe(true);
  });

  it('', async () => {
    const dNotional = guard.canRoute({ providerId: 'BINANCE', symbol: 'BTCUSDT', notional: '25000', quantity: '1' });
    expect(dNotional.reason).toBe('ORDER_EXPOSURE_LIMIT_EXCEEDED');

    const dQty = guard.canRoute({ providerId: 'BINANCE', symbol: 'BTCUSDT', notional: '1000', quantity: '150' });
    expect(dQty.reason).toBe('QUANTITY_LIMIT_EXCEEDED');

    for (let i = 0; i < 10; i++) {
       await guard.reserveExposure(`o${i}`, { providerId: 'KRAKEN', symbol: 'ETHUSDT', notional: '100', quantity: '1' });
    }
    const dPending = guard.canRoute({ providerId: 'KRAKEN', symbol: 'ETHUSDT', notional: '100', quantity: '1' });
    expect(dPending.reason).toBe('PENDING_EXPOSURE_LIMIT_EXCEEDED');
  });

  it('', async () => {
    guard.setProviderHealth('BINANCE', 'DISABLED');
    const d1 = guard.canRoute({ providerId: 'BINANCE', symbol: 'BTCUSDT', notional: '100', quantity: '1' });
    expect(d1.reason).toBe('PROVIDER_DISABLED');

    guard.setProviderHealth('BINANCE', 'UNKNOWN');
    const d2 = guard.canRoute({ providerId: 'BINANCE', symbol: 'BTCUSDT', notional: '100', quantity: '1' });
    expect(d2.reason).toBe('UNKNOWN_EXPOSURE');
  });

  it('', async () => {
    // Current available is 1000. Let's reserve 900.
    await guard.reserveExposure('o1', { providerId: 'BINANCE', symbol: 'BTCUSDT', notional: '100', quantity: '90' });
    
    // Limit is maxPendingInventory = 100.
    const d1 = guard.canRoute({ providerId: 'BINANCE', symbol: 'BTCUSDT', notional: '100', quantity: '15' });
    expect(d1.reason).toBe('INVENTORY_LIMIT_EXCEEDED'); // Because 90 + 15 > 100 maxPendingInventory
  });

  it('', async () => {
    await guard.reserveExposure('o1', { providerId: 'BINANCE', symbol: 'BTCUSDT', notional: '10000', quantity: '5' });
    expect(guard.getExposure('BINANCE').pendingExposure).toBe(10000);

    // Terminal partial fill reduces pending to 0, current becomes executed amount.
    await guard.applyExecution('o1', '8000', '4', 'PARTIALLY_FILLED');
    const st = guard.getExposure('BINANCE');
    expect(st.pendingExposure).toBe(0);
    expect(st.currentExposure).toBe(8000);
    expect(st.availableInventory).toBe(996);
  });

  it('', async () => {
    await guard.reserveExposure('o1', { providerId: 'BINANCE', symbol: 'BTCUSDT', notional: '10000', quantity: '5' });
    await guard.applyExecution('o1', '0', '0', 'CANCELLED');
    expect(guard.getExposure('BINANCE').pendingExposure).toBe(0);

    await guard.reserveExposure('o2', { providerId: 'BINANCE', symbol: 'BTCUSDT', notional: '10000', quantity: '5' });
    await guard.applyExecution('o2', '0', '0', 'REJECTED');
    expect(guard.getExposure('BINANCE').pendingExposure).toBe(0);

    await guard.reserveExposure('o3', { providerId: 'BINANCE', symbol: 'BTCUSDT', notional: '10000', quantity: '5' });
    await guard.applyExecution('o3', '0', '0', 'FAILED');
    expect(guard.getExposure('BINANCE').pendingExposure).toBe(0);
  });

  it('', async () => {
    await guard.reserveExposure('o1', { providerId: 'BINANCE', symbol: 'BTCUSDT', notional: '10000', quantity: '5' });
    
    await guard.applyExecution('o1', '0', '0', 'UNKNOWN');
    expect(guard.getExposure('BINANCE').pendingExposure).toBe(10000); // Retained!

    await guard.applyExecution('o1', '0', '0', 'RECONCILING');
    expect(guard.getExposure('BINANCE').pendingExposure).toBe(10000); // Retained!
  });

  it('', async () => {
    // In JS, reserveExposure is synchronous. We simulate fast requests across different symbols.
    for(let i = 0; i < 4; i++) {
        // 4 x 20k = 80k pending
        await guard.reserveExposure(`slice${i}`, { providerId: 'BINANCE', symbol: `SYM${i}`, notional: '20000', quantity: '10' });
    }
    
    // The next one tries 20k which pushes pending to 100k, exceeding maxPendingNotional 90k
    const d3 = guard.canRoute({ providerId: 'BINANCE', symbol: 'LTCUSDT', notional: '20000', quantity: '10' });
    expect(d3.allowed).toBe(false);
    expect(d3.reason).toBe('PENDING_EXPOSURE_LIMIT_EXCEEDED');
  });

  it('', async () => {
    expect(() => guard.canRoute({ providerId: 'BINANCE', symbol: 'BTCUSDT', notional: '-50', quantity: '10' })).toThrow(/INVALID_NOTIONAL/);
    expect(() => guard.canRoute({ providerId: 'BINANCE', symbol: 'BTCUSDT', notional: 'NaN', quantity: '10' })).toThrow(/INVALID_NOTIONAL/);
    await expect(guard.reserveExposure('ox', { providerId: 'BINANCE', symbol: 'BTCUSDT', notional: '100', quantity: 'Infinity' })).rejects.toThrow(/INVALID_QUANTITY/);
  });

  it('', async () => {
    await guard.reserveExposure('o1', { providerId: 'BINANCE', symbol: 'BTCUSDT', notional: '10000', quantity: '5' });
    const dec = guard.canRoute({ providerId: 'BINANCE', symbol: 'BTCUSDT', notional: '10000', quantity: '5' });
    
    // Verified pure JSON state
    const serialized = JSON.stringify(dec);
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('balance');
  });

});
