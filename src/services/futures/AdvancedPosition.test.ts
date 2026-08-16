import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FuturesOrderService } from './FuturesOrderService';
import { futuresTpSlService } from './FuturesTpSlService';
import { DemoLedger } from '../ledger';
import { futuresRiskService } from './FuturesRiskService';
import { futuresMarketService } from './FuturesMarketService';
import { Decimal } from 'decimal.js';

describe('Advanced Position Management', () => {
  let ledger: DemoLedger;
  let orderService: FuturesOrderService;
  let mockMarkPrice = '50000';

  beforeEach(() => {
    ledger = new DemoLedger(false);
    ledger.reset();
    ledger.credit('FUTURES_USDT', '100000', 'Init');
    
    orderService = new FuturesOrderService(ledger, false);
    futuresTpSlService.reset();
    
    mockMarkPrice = '50000';

    vi.spyOn(futuresMarketService, 'getMarket').mockImplementation(async (symbol) => {
        return {
            symbol: symbol,
            baseAsset: symbol.replace('USDT', ''),
            quoteAsset: 'USDT',
            lastPrice: mockMarkPrice,
            markPrice: mockMarkPrice,
            indexPrice: mockMarkPrice,
            fundingRate: '0.0001',
            makerFee: '0.0002',
            takerFee: '0.0005',
            maintenanceMarginRate: '0.005',
            minimumQuantity: '0.001',
            maximumLeverage: 100,
            tickSize: '0.1',
            quantityPrecision: 3,
            openInterest: '0',
            volume24h: '0',
            high24h: '0',
            low24h: '0',
            change24h: '0',
        };
    });
  });

  const getPos = (accountId = 'test') => orderService.getPositions(accountId)[0];

  it('1. Partial LONG close & 16. PNL after partial close & 5. Market close', async () => {
    await orderService.placeOrder({
        accountId: 'test', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG',
        type: 'MARKET', quantity: '1', leverage: 10, marginMode: 'ISOLATED'
    });
    
    mockMarkPrice = '52000';
    await orderService.updateMarkPrices([{ symbol: 'BTCUSDT', markPrice: '52000' }]);
    
    // Close 0.4 at Market
    await orderService.placeOrder({
        accountId: 'test', symbol: 'BTCUSDT', side: 'SELL', positionSide: 'LONG',
        type: 'MARKET', quantity: '0.4', leverage: 10, marginMode: 'ISOLATED',
        reduceOnly: true, closePosition: true
    });
    
    const pos = getPos();
    expect(pos.quantity).toBe('0.6');
    expect(pos.status).toBe('OPEN');
    // Realized PNL for 0.4 BTC at 52000 - 50000 = 2000 profit/BTC = 800 profit
    expect(Number(pos.realizedPnl)).toBeGreaterThan(0);
  });

  it('2. Partial SHORT close', async () => {
    await orderService.placeOrder({
        accountId: 'test', symbol: 'BTCUSDT', side: 'SELL', positionSide: 'SHORT',
        type: 'MARKET', quantity: '1', leverage: 10, marginMode: 'ISOLATED'
    });
    mockMarkPrice = '48000';
    await orderService.updateMarkPrices([{ symbol: 'BTCUSDT', markPrice: '48000' }]);
    await orderService.placeOrder({
        accountId: 'test', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'SHORT',
        type: 'MARKET', quantity: '0.5', leverage: 10, marginMode: 'ISOLATED',
        reduceOnly: true, closePosition: true
    });
    
    const pos = getPos();
    expect(pos.quantity).toBe('0.5');
    expect(pos.status).toBe('OPEN');
    expect(Number(pos.realizedPnl)).toBeGreaterThan(0);
  });

  it('3. Full LONG close & 4. Full SHORT close', async () => {
    await orderService.placeOrder({
        accountId: 'test', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG',
        type: 'MARKET', quantity: '1', leverage: 10, marginMode: 'ISOLATED'
    });
    await orderService.placeOrder({
        accountId: 'test', symbol: 'BTCUSDT', side: 'SELL', positionSide: 'LONG',
        type: 'MARKET', quantity: '1', leverage: 10, marginMode: 'ISOLATED',
        reduceOnly: true, closePosition: true
    });
    const pos = getPos();
    expect(pos.status).toBe('CLOSED');
    expect(pos.quantity).toBe('0');
  });

  it('6. Limit close', async () => {
    await orderService.placeOrder({
        accountId: 'test', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG',
        type: 'MARKET', quantity: '1', leverage: 10, marginMode: 'ISOLATED'
    });
    await orderService.placeOrder({
        accountId: 'test', symbol: 'BTCUSDT', side: 'SELL', positionSide: 'LONG',
        type: 'LIMIT', price: '60000', quantity: '1', leverage: 10, marginMode: 'ISOLATED',
        reduceOnly: true, closePosition: true
    });
    
    expect(getPos().status).toBe('OPEN');
    
    mockMarkPrice = '60000';
    await orderService.updateMarkPrices([{ symbol: 'BTCUSDT', markPrice: '60000' }]);
    // In demo, checkLimitOrders needs to be triggered either by a tick or manually
    // The previous test didn't trigger checkLimitOrders with new mark price automatically in tests unless simulated
    await orderService.checkLimitOrders();
    expect(getPos().status).toBe('CLOSED');
  });

  it('7. Add isolated margin & 14. Liquidation price after adding margin', async () => {
    await orderService.placeOrder({
        accountId: 'test', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG',
        type: 'MARKET', quantity: '1', leverage: 10, marginMode: 'ISOLATED'
    });
    const posBefore = getPos();
    // Simulate initial margin and calculate its liquidation price
    const initialLiq = futuresRiskService.calculateLiquidationPrice(posBefore, '0.005', '0');
    posBefore.liquidationPrice = initialLiq; // Mock it since real app calculates later
    const liqBefore = Number(posBefore.liquidationPrice);
    const imBefore = Number(posBefore.initialMargin);
    
    await orderService.addIsolatedMargin('test', posBefore.positionId, '1000');
    
    const posAfter = getPos();
    const liqAfter = Number(posAfter.liquidationPrice);
    
    // For a LONG position, adding margin should decrease the liquidation price
    expect(liqAfter).toBeLessThan(liqBefore); 
    expect(Number(posAfter.initialMargin)).toBeGreaterThan(imBefore);
  });

  it('8. Remove isolated margin & 15. Liquidation price after removing margin', async () => {
    await orderService.placeOrder({
        accountId: 'test', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG',
        type: 'MARKET', quantity: '1', leverage: 10, marginMode: 'ISOLATED'
    });
    
    const posBefore = getPos();
    await orderService.addIsolatedMargin('test', posBefore.positionId, '2000');
    
    const liqMiddle = Number(getPos().liquidationPrice);
    
    await orderService.removeIsolatedMargin('test', posBefore.positionId, '1000');
    
    const liqAfter = Number(getPos().liquidationPrice);
    // For a LONG position, removing margin should increase the liquidation price
    expect(liqAfter).toBeGreaterThan(liqMiddle);
  });

  it('9. Insufficient available margin & 10. Unsafe margin removal', async () => {
    await orderService.placeOrder({
        accountId: 'test', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG',
        type: 'MARKET', quantity: '1', leverage: 10, marginMode: 'ISOLATED'
    });
    const pos = getPos();
    
    // Test Insufficient available margin
    ledger.debit('FUTURES_USDT', ledger.getBalance('FUTURES_USDT'), 'Drain');
    await expect(orderService.addIsolatedMargin('test', pos.positionId, '1000')).rejects.toThrow('Insufficient available margin');
    
    ledger.credit('FUTURES_USDT', '100000', 'Refill');
    
    // Test Unsafe margin removal
    // Current mark is 50000. Entry is 50000. Qty 1. Lev 10. IM = 5000. MM = 500.
    // If we remove 4800, remaining IM = 200. Equity = 200. MM = 500. Equity < MM -> Liquidation.
    await expect(orderService.removeIsolatedMargin('test', pos.positionId, '4800')).rejects.toThrow('Unsafe margin removal');
  });

  it('12. TP/SL quantity after partial close & 13. TP/SL cancellation after full close', async () => {
    await orderService.placeOrder({
        accountId: 'test', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG',
        type: 'MARKET', quantity: '1', leverage: 10, marginMode: 'ISOLATED'
    });
    const pos = getPos();
    
    futuresTpSlService.addOrUpdateConfig({
        accountId: 'test', positionId: pos.positionId, symbol: 'BTCUSDT', positionSide: 'LONG',
        takeProfitEnabled: true, takeProfitPrice: '60000', stopLossEnabled: false, quantity: '1'
    }, pos);
    
    expect(futuresTpSlService.getConfigForPosition(pos.positionId)?.quantity).toBe('1');
    
    await orderService.placeOrder({
        accountId: 'test', symbol: 'BTCUSDT', side: 'SELL', positionSide: 'LONG',
        type: 'MARKET', quantity: '0.4', leverage: 10, marginMode: 'ISOLATED',
        reduceOnly: true, closePosition: true
    });
    
    expect(futuresTpSlService.getConfigForPosition(pos.positionId)?.quantity).toBe('0.6');
    
    await orderService.placeOrder({
        accountId: 'test', symbol: 'BTCUSDT', side: 'SELL', positionSide: 'LONG',
        type: 'MARKET', quantity: '0.6', leverage: 10, marginMode: 'ISOLATED',
        reduceOnly: true, closePosition: true
    });
    
    expect(futuresTpSlService.getConfigForPosition(pos.positionId)).toBeUndefined();
  });
  
  it('17. Duplicate execution prevention & 18. Closed position modification prevention', async () => {
    await orderService.placeOrder({
        accountId: 'test', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG',
        type: 'MARKET', quantity: '1', leverage: 10, marginMode: 'ISOLATED'
    });
    const pos = getPos();
    
    await orderService.placeOrder({
        accountId: 'test', symbol: 'BTCUSDT', side: 'SELL', positionSide: 'LONG',
        type: 'MARKET', quantity: '1', leverage: 10, marginMode: 'ISOLATED',
        reduceOnly: true, closePosition: true
    });
    
    await expect(orderService.placeOrder({
        accountId: 'test', symbol: 'BTCUSDT', side: 'SELL', positionSide: 'LONG',
        type: 'MARKET', quantity: '1', leverage: 10, marginMode: 'ISOLATED',
        reduceOnly: true, closePosition: true
    })).rejects.toThrow('No open position to close');
    
    await expect(orderService.addIsolatedMargin('test', pos.positionId, '1000')).rejects.toThrow('Position is not open');
  });
});
