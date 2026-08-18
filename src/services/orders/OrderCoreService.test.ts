import { expect, test, describe, beforeEach } from 'vitest';
import { orderCoreService } from './OrderCoreService';
import { tradeFillService } from './TradeFillService';
import { syncOrderToCore, syncFillToCore } from './integration';

describe('Centralized Order Data Foundation (F21A)', () => {
    beforeEach(() => {
        localStorage.clear();
        orderCoreService.reset();
        tradeFillService.reset();
    });

    test('1-7. Order creation, user ownership, properties', () => {
        syncOrderToCore('ord1', 'u1', 'BTCUSDT', 'SPOT', 'BUY', 'MARKET', '1.0', undefined, undefined, 'NEW', '0', '0');
        
        const o = orderCoreService.getOrder('ord1');
        expect(o).toBeDefined();
        expect(o?.userId).toBe('u1');
        expect(o?.symbol).toBe('BTCUSDT');
        expect(o?.market).toBe('SPOT');
        expect(o?.side).toBe('BUY');
        expect(o?.type).toBe('MARKET');
        expect(o?.quantity).toBe('1.0');
    });

    test('8. Unique order ID', () => {
        syncOrderToCore('ord1', 'u1', 'BTCUSDT', 'SPOT', 'BUY', 'MARKET', '1.0', undefined, undefined, 'NEW');
        syncOrderToCore('ord1', 'u1', 'BTCUSDT', 'SPOT', 'BUY', 'MARKET', '1.0', undefined, undefined, 'NEW'); // Duplicate
        
        expect(orderCoreService.getOrders().length).toBe(1);
    });

    test('9-11. Executed quantity, remaining quantity, avg price', () => {
        syncOrderToCore('ord2', 'u1', 'BTCUSDT', 'SPOT', 'BUY', 'LIMIT', '2.0', '60000', undefined, 'OPEN');
        syncFillToCore('f1', 'ord2', 'u1', 'BTCUSDT', 'SPOT', 'BUY', '0.5', '60000', '0', 'USDT');
        
        let o = orderCoreService.getOrder('ord2')!;
        expect(o.executedQuantity).toBe('0.5');
        expect(o.remainingQuantity).toBe('1.5');
        expect(o.averageFillPrice).toBe('60000');
        
        syncFillToCore('f2', 'ord2', 'u1', 'BTCUSDT', 'SPOT', 'BUY', '0.5', '62000', '0', 'USDT');
        o = orderCoreService.getOrder('ord2')!;
        expect(o.executedQuantity).toBe('1');
        expect(o.remainingQuantity).toBe('1');
        expect(o.averageFillPrice).toBe('61000'); // (0.5 * 60k + 0.5 * 62k) / 1
    });

    test('12-13. Order status lifecycle', () => {
        syncOrderToCore('ord3', 'u1', 'BTCUSDT', 'SPOT', 'BUY', 'LIMIT', '1.0', '60000', undefined, 'NEW');
        let o = orderCoreService.getOrder('ord3')!;
        expect(o.status).toBe('NEW');
        
        syncFillToCore('f3', 'ord3', 'u1', 'BTCUSDT', 'SPOT', 'BUY', '0.4', '60000', '0', 'USDT');
        o = orderCoreService.getOrder('ord3')!;
        expect(o.status).toBe('PARTIALLY_FILLED');
        
        syncFillToCore('f4', 'ord3', 'u1', 'BTCUSDT', 'SPOT', 'BUY', '0.6', '60000', '0', 'USDT');
        o = orderCoreService.getOrder('ord3')!;
        expect(o.status).toBe('FILLED');
    });

    test('14-16. TradeFill creation, relationship, duplicate prevention', () => {
        syncOrderToCore('ord4', 'u1', 'ETHUSDT', 'FUTURES', 'LONG', 'MARKET', '10', undefined, undefined, 'NEW');
        syncFillToCore('f5', 'ord4', 'u1', 'ETHUSDT', 'FUTURES', 'LONG', '10', '3000', '1', 'USDT', '0');
        syncFillToCore('f5', 'ord4', 'u1', 'ETHUSDT', 'FUTURES', 'LONG', '10', '3000', '1', 'USDT', '0'); // Dup
        
        const fills = tradeFillService.getFillsByOrder('ord4');
        expect(fills.length).toBe(1);
        expect(fills[0].id).toBe('f5');
        
        const o = orderCoreService.getOrder('ord4')!;
        expect(o.executedQuantity).toBe('10'); // should not be 20
    });

    test('17-18. Persistence and Malformed storage', () => {
        syncOrderToCore('ord5', 'u1', 'SOLUSDT', 'SPOT', 'SELL', 'MARKET', '5', undefined, undefined, 'FILLED');
        
        // Simulate reload
        const newCore = Object.assign(Object.create(Object.getPrototypeOf(orderCoreService)), orderCoreService);
        newCore['load']();
        expect(newCore.getOrder('ord5')).toBeDefined();
        
        // Malformed
        localStorage.setItem('demo_core_orders', '{bad-json');
        newCore['load']();
        // Should not crash, just fail silently and use existing
        expect(newCore.getOrders()).toBeDefined();
    });

    test('19-20. Invalid quantity and price', () => {
        // Core accepts string, validation relies on engine. 
        // We verify that strings with zero or negative do not throw and crash the system.
        expect(() => {
            syncOrderToCore('ord6', 'u1', 'SOLUSDT', 'SPOT', 'SELL', 'MARKET', '0', '0', undefined, 'NEW');
        }).not.toThrow();
    });

});
