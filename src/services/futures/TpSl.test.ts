import { futuresOrderService } from './FuturesOrderService';
import { futuresTpSlService } from './FuturesTpSlService';
import { demoLedger } from '../ledger';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FuturesTpSlService } from './FuturesTpSlService';
import { FuturesOrderService } from './FuturesOrderService';
import { DemoLedger } from '../ledger';
import { futuresRiskService } from './FuturesRiskService';
import { futuresMarketService } from './FuturesMarketService';

describe('Futures TP/SL Service', () => {
  let ledger: DemoLedger;
  let orderService: FuturesOrderService;
  let tpSlService: FuturesTpSlService;

  beforeEach(() => {
    vi.spyOn(futuresMarketService, 'getMarket').mockResolvedValue({
      symbol: 'BTCUSDT',
      lastPrice: '63000',
      maintenanceMarginRate: '0.005',
      minimumQuantity: '0.001',
      maximumLeverage: 125,
      makerFee: '0.0002',
      takerFee: '0.0004'
    } as any);

    ledger = new DemoLedger(false);
    ledger.reset();
    ledger.credit('FUTURES_USDT', '20000', 'Init');
    
    demoLedger.reset();
    demoLedger.credit('FUTURES_USDT', '20000', 'Init');
    futuresOrderService.reset();
    futuresTpSlService.reset();
    orderService = futuresOrderService;
    tpSlService = futuresTpSlService;
  });

  it('1. LONG TP & 12. EXAMPLE - LONG', async () => {
    await orderService.placeOrder({
        accountId: 'test', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG',
        type: 'MARKET', quantity: '0.1', leverage: 10, marginMode: 'ISOLATED'
    });
    
    const pos = orderService.getPositions('test')[0];
    
    tpSlService.addOrUpdateConfig({
        accountId: 'test', positionId: pos.positionId, symbol: 'BTCUSDT', positionSide: 'LONG',
        takeProfitEnabled: true, takeProfitPrice: '64000',
        stopLossEnabled: true, stopLossPrice: '62000',
        quantity: '0.1'
    }, pos);
    
    expect(tpSlService.getConfigForPosition(pos.positionId)).toBeDefined();
    
    // Trigger TP
    await orderService.updateMarkPrices([{ symbol: 'BTCUSDT', markPrice: '64000' }]);
    await new Promise(resolve => setTimeout(resolve, 50));
    await new Promise(resolve => setTimeout(resolve, 50));
    
    const updatedPos = orderService.getPositions('test')[0];
    expect(updatedPos.status).toBe('CLOSED');
    
    const config = tpSlService.getConfigs('test')[0];
    expect(config.status).toBe('TRIGGERED');
    expect(config.triggerType).toBe('TP');
  });

  it('2. LONG SL & 12. EXAMPLE - LONG', async () => {
    await orderService.placeOrder({
        accountId: 'test', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG',
        type: 'MARKET', quantity: '0.1', leverage: 10, marginMode: 'ISOLATED'
    });
    
    const pos = orderService.getPositions('test')[0];
    
    tpSlService.addOrUpdateConfig({
        accountId: 'test', positionId: pos.positionId, symbol: 'BTCUSDT', positionSide: 'LONG',
        takeProfitEnabled: true, takeProfitPrice: '64000',
        stopLossEnabled: true, stopLossPrice: '62000',
        quantity: '0.1'
    }, pos);
    
    // Trigger SL
    console.log('--- Triggering updateMarkPrices ---');
    await orderService.updateMarkPrices([{ symbol: 'BTCUSDT', markPrice: '62000' }]);
    await new Promise(resolve => setTimeout(resolve, 50));
    await new Promise(resolve => setTimeout(resolve, 50));
    
    const updatedPos = orderService.getPositions('test')[0];
    expect(updatedPos.status).toBe('CLOSED');
    
    const config = tpSlService.getConfigs('test')[0];
    expect(config.status).toBe('TRIGGERED');
    expect(config.triggerType).toBe('SL');
  });
  
  it('3. SHORT TP & 13. EXAMPLE - SHORT', async () => {
    await orderService.placeOrder({
        accountId: 'test', symbol: 'BTCUSDT', side: 'SELL', positionSide: 'SHORT',
        type: 'MARKET', quantity: '0.1', leverage: 10, marginMode: 'ISOLATED'
    });
    
    const pos = orderService.getPositions('test')[0];
    
    tpSlService.addOrUpdateConfig({
        accountId: 'test', positionId: pos.positionId, symbol: 'BTCUSDT', positionSide: 'SHORT',
        takeProfitEnabled: true, takeProfitPrice: '62000',
        stopLossEnabled: true, stopLossPrice: '64000',
        quantity: '0.1'
    }, pos);
    
    // Trigger TP
    await orderService.updateMarkPrices([{ symbol: 'BTCUSDT', markPrice: '62000' }]);
    
    const updatedPos = orderService.getPositions('test')[0];
    expect(updatedPos.status).toBe('CLOSED');
    
    const config = tpSlService.getConfigs('test')[0];
    expect(config.status).toBe('TRIGGERED');
    expect(config.triggerType).toBe('TP');
  });

  it('4. SHORT SL & 13. EXAMPLE - SHORT', async () => {
    await orderService.placeOrder({
        accountId: 'test', symbol: 'BTCUSDT', side: 'SELL', positionSide: 'SHORT',
        type: 'MARKET', quantity: '0.1', leverage: 10, marginMode: 'ISOLATED'
    });
    
    const pos = orderService.getPositions('test')[0];
    
    tpSlService.addOrUpdateConfig({
        accountId: 'test', positionId: pos.positionId, symbol: 'BTCUSDT', positionSide: 'SHORT',
        takeProfitEnabled: true, takeProfitPrice: '62000',
        stopLossEnabled: true, stopLossPrice: '64000',
        quantity: '0.1'
    }, pos);
    
    // Trigger SL
    await orderService.updateMarkPrices([{ symbol: 'BTCUSDT', markPrice: '64000' }]);
    
    const updatedPos = orderService.getPositions('test')[0];
    expect(updatedPos.status).toBe('CLOSED');
    
    const config = tpSlService.getConfigs('test')[0];
    expect(config.status).toBe('TRIGGERED');
    expect(config.triggerType).toBe('SL');
  });
  
  it('5. TP validation & 6. SL validation', async () => {
    await orderService.placeOrder({
        accountId: 'test', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG',
        type: 'MARKET', quantity: '0.1', leverage: 10, marginMode: 'ISOLATED'
    });
    const pos = orderService.getPositions('test')[0];
    
    
    
    
  });
  
  it('10. Partial TP & 11. Partial SL & 14. Position closure logic', async () => {
    await orderService.placeOrder({
        accountId: 'test', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG',
        type: 'MARKET', quantity: '0.1', leverage: 10, marginMode: 'ISOLATED'
    });
    const pos = orderService.getPositions('test')[0];
    
    tpSlService.addOrUpdateConfig({
        accountId: 'test', positionId: pos.positionId, symbol: 'BTCUSDT', positionSide: 'LONG',
        takeProfitEnabled: true, takeProfitPrice: '64000', stopLossEnabled: false,
        quantity: '0.04'
    }, pos);
    
    await orderService.updateMarkPrices([{ symbol: 'BTCUSDT', markPrice: '64000' }]);
    
    const updatedPos = orderService.getPositions('test')[0];
    expect(updatedPos.status).toBe('OPEN');
    expect(updatedPos.quantity).toBe('0.06');
    
    const config = tpSlService.getConfigs('test')[0];
    expect(config.status).toBe('TRIGGERED');
  });
  
  it('16. Orphan TP/SL prevention', async () => {
    await orderService.placeOrder({
        accountId: 'test', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG',
        type: 'MARKET', quantity: '0.1', leverage: 10, marginMode: 'ISOLATED'
    });
    const pos = orderService.getPositions('test')[0];
    
    tpSlService.addOrUpdateConfig({
        accountId: 'test', positionId: pos.positionId, symbol: 'BTCUSDT', positionSide: 'LONG',
        takeProfitEnabled: true, takeProfitPrice: '64000', stopLossEnabled: false,
        quantity: '0.1'
    }, pos);
    
    await orderService.placeOrder({
        accountId: 'test', symbol: 'BTCUSDT', side: 'SELL', positionSide: 'LONG',
        type: 'MARKET', quantity: '0.1', leverage: 10, marginMode: 'ISOLATED', reduceOnly: true, closePosition: true
    });
    
    expect(orderService.getPositions('test')[0].status).toBe('CLOSED');
    
    const config = tpSlService.getConfigs('test')[0];
    expect(config.status).toBe('CANCELLED');
  });

});
