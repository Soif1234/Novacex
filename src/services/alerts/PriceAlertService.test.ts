import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { priceAlertService } from './PriceAlertService';
import { tickerService } from '../market/TickerService';
import { tradingPairRegistry } from '../market/TradingPairRegistry';
import { AlertTriggeredEvent } from '../../types/alerts';

describe.skip('PriceAlertService', () => {
  beforeEach(() => {
    // Clear alerts before each test
    // @ts-ignore
    priceAlertService.alerts = [];
    localStorage.clear();
    // @ts-ignore
    priceAlertService.isInitialized = false;
    priceAlertService.initialize();
  });

  afterEach(() => {
    priceAlertService.destroy();
  });

  const getAlert = (id: string) => priceAlertService.getAlert(id);

  it('1. Create ABOVE alert', () => {
    const alert = priceAlertService.createAlert('BTCUSDT', 'FUTURES', 'ABOVE', '70000', 'ONCE');
    expect(alert.symbol).toBe('BTCUSDT');
    expect(alert.condition).toBe('ABOVE');
    expect(alert.targetPrice).toBe('70000');
  });

  it('2. Create BELOW alert', () => {
    const alert = priceAlertService.createAlert('BTCUSDT', 'FUTURES', 'BELOW', '60000', 'ONCE');
    expect(alert.symbol).toBe('BTCUSDT');
    expect(alert.condition).toBe('BELOW');
    expect(alert.targetPrice).toBe('60000');
  });

  it('3. Invalid symbol', () => {
    expect(() => priceAlertService.createAlert('INVALID', 'FUTURES', 'ABOVE', '70000', 'ONCE')).toThrow(/Invalid symbol/);
  });

  it('4. Invalid target price', () => {
    expect(() => priceAlertService.createAlert('BTCUSDT', 'FUTURES', 'ABOVE', 'abc', 'ONCE')).toThrow(/numeric/);
  });

  it('5. Zero target', () => {
    expect(() => priceAlertService.createAlert('BTCUSDT', 'FUTURES', 'ABOVE', '0', 'ONCE')).toThrow(/greater than zero/);
  });

  it('6. Negative target', () => {
    expect(() => priceAlertService.createAlert('BTCUSDT', 'FUTURES', 'ABOVE', '-1000', 'ONCE')).toThrow(/greater than zero/);
  });

  it('7. NaN target', () => {
    expect(() => priceAlertService.createAlert('BTCUSDT', 'FUTURES', 'ABOVE', 'NaN', 'ONCE')).toThrow(/numeric/);
  });

  it('8. Infinity target', () => {
    expect(() => priceAlertService.createAlert('BTCUSDT', 'FUTURES', 'ABOVE', 'Infinity', 'ONCE')).toThrow(/numeric/);
  });

  it('9. ABOVE trigger', () => {
    const alert = priceAlertService.createAlert('BTCUSDT', 'FUTURES', 'ABOVE', '70000', 'ONCE');
    // Simulate previous price
    priceAlertService.evaluateAlert(alert, '69000');
    expect(alert.status).toBe('ACTIVE');
    
    // Simulate cross
    let triggered = false;
    priceAlertService.subscribe((e) => {
      if (e.alertId === alert.id) triggered = true;
    });
    
    priceAlertService.evaluateAlert(alert, '70000');
    expect(triggered).toBe(true);
    expect(alert.status).toBe('TRIGGERED');
  });

  it('10. BELOW trigger', () => {
    const alert = priceAlertService.createAlert('BTCUSDT', 'FUTURES', 'BELOW', '60000', 'ONCE');
    // Simulate previous price
    priceAlertService.evaluateAlert(alert, '61000');
    expect(alert.status).toBe('ACTIVE');
    
    // Simulate cross
    let triggered = false;
    priceAlertService.subscribe((e) => {
      if (e.alertId === alert.id) triggered = true;
    });
    
    priceAlertService.evaluateAlert(alert, '59000');
    expect(triggered).toBe(true);
    expect(alert.status).toBe('TRIGGERED');
  });

  it('11. Exact target trigger', () => {
    const alert = priceAlertService.createAlert('BTCUSDT', 'FUTURES', 'ABOVE', '70000', 'ONCE');
    priceAlertService.evaluateAlert(alert, '69000');
    priceAlertService.evaluateAlert(alert, '70000');
    expect(alert.status).toBe('TRIGGERED');
  });

  it('12. One-time alert', () => {
    const alert = priceAlertService.createAlert('BTCUSDT', 'FUTURES', 'ABOVE', '70000', 'ONCE');
    priceAlertService.evaluateAlert(alert, '69000');
    priceAlertService.evaluateAlert(alert, '70500'); // triggers
    expect(alert.status).toBe('TRIGGERED');
    
    let triggerCount = 0;
    priceAlertService.subscribe(() => triggerCount++);
    
    // Dip and go above again
    priceAlertService.evaluateAlert(alert, '69000');
    priceAlertService.evaluateAlert(alert, '70500');
    
    expect(triggerCount).toBe(0); // Should not trigger again
  });

  it('13. Repeating alert', () => {
    const alert = priceAlertService.createAlert('BTCUSDT', 'FUTURES', 'ABOVE', '70000', 'REPEATING');
    priceAlertService.evaluateAlert(alert, '69000');
    
    let triggerCount = 0;
    priceAlertService.subscribe(() => triggerCount++);
    
    priceAlertService.evaluateAlert(alert, '70500'); // triggers (1)
    expect(alert.status).toBe('ACTIVE');
    expect(triggerCount).toBe(1);
    
    // Dip below threshold
    priceAlertService.evaluateAlert(alert, '69000'); 
    
    // Go above again
    priceAlertService.evaluateAlert(alert, '70500'); // triggers (2)
    
    expect(triggerCount).toBe(2);
  });

  it('14. Duplicate trigger prevention', () => {
    const alert = priceAlertService.createAlert('BTCUSDT', 'FUTURES', 'ABOVE', '70000', 'REPEATING');
    priceAlertService.evaluateAlert(alert, '69000');
    
    let triggerCount = 0;
    priceAlertService.subscribe(() => triggerCount++);
    
    priceAlertService.evaluateAlert(alert, '70500'); // triggers (1)
    priceAlertService.evaluateAlert(alert, '71000'); // NO trigger
    priceAlertService.evaluateAlert(alert, '72000'); // NO trigger
    
    expect(triggerCount).toBe(1);
  });

  it('15. Threshold crossing', () => {
    const alert = priceAlertService.createAlert('BTCUSDT', 'FUTURES', 'ABOVE', '70000', 'ONCE');
    
    // If created and immediately receives price above threshold, it shouldn't trigger
    priceAlertService.evaluateAlert(alert, '71000');
    expect(alert.status).toBe('ACTIVE');
    
    // Must cross from below
    priceAlertService.evaluateAlert(alert, '69000');
    priceAlertService.evaluateAlert(alert, '70500');
    expect(alert.status).toBe('TRIGGERED');
  });

  it('16. Multiple alerts', () => {
    const alert1 = priceAlertService.createAlert('BTCUSDT', 'FUTURES', 'ABOVE', '70000', 'ONCE');
    const alert2 = priceAlertService.createAlert('ETHUSDT', 'FUTURES', 'BELOW', '3000', 'ONCE');
    
    priceAlertService.evaluateAlert(alert1, '69000');
    priceAlertService.evaluateAlert(alert2, '3100');
    
    let events: string[] = [];
    priceAlertService.subscribe((e) => events.push(e.symbol));
    
    // Only ETH triggers
    priceAlertService.evaluateAlert(alert1, '69500');
    priceAlertService.evaluateAlert(alert2, '2900');
    
    expect(events.length).toBe(1);
    expect(events[0]).toBe('ETHUSDT');
  });

  it('17. BTC/ETH isolation', () => {
    const btcAlert = priceAlertService.createAlert('BTCUSDT', 'FUTURES', 'ABOVE', '70000', 'ONCE');
    const ethAlert = priceAlertService.createAlert('ETHUSDT', 'FUTURES', 'ABOVE', '4000', 'ONCE');
    
    priceAlertService.evaluateAlert(btcAlert, '69000');
    priceAlertService.evaluateAlert(ethAlert, '3900');
    
    // ETH goes above 70000 (improbable but tests isolation)
    priceAlertService.evaluateAlert(ethAlert, '71000');
    
    expect(btcAlert.status).toBe('ACTIVE');
    expect(ethAlert.status).toBe('TRIGGERED');
  });

  it('18. Spot/Futures isolation', () => {
    const futuresAlert = priceAlertService.createAlert('BTCUSDT', 'FUTURES', 'ABOVE', '70000', 'ONCE');
    const spotAlert = priceAlertService.createAlert('BTCUSDC', 'SPOT', 'ABOVE', '70000', 'ONCE');
    
    priceAlertService.evaluateAlert(futuresAlert, '69000');
    priceAlertService.evaluateAlert(spotAlert, '69000');
    
    // Spot goes to 71000
    priceAlertService.evaluateAlert(spotAlert, '71000');
    
    expect(futuresAlert.status).toBe('ACTIVE');
    expect(spotAlert.status).toBe('TRIGGERED');
  });

  it('19. Persistence', () => {
    priceAlertService.createAlert('BTCUSDT', 'FUTURES', 'ABOVE', '70000', 'ONCE');
    // @ts-ignore
    expect(JSON.parse(localStorage.getItem('nova_price_alerts')!).length).toBe(1);
    
    // Simulate reload
    // @ts-ignore
    priceAlertService.alerts = [];
    // @ts-ignore
    priceAlertService.load();
    expect(priceAlertService.getAlerts().length).toBe(1);
  });

  it('20. Alert cancellation', () => {
    const alert = priceAlertService.createAlert('BTCUSDT', 'FUTURES', 'ABOVE', '70000', 'ONCE');
    priceAlertService.cancelAlert(alert.id);
    expect(priceAlertService.getAlert(alert.id)?.status).toBe('CANCELLED');
    
    // Should not trigger
    priceAlertService.evaluateAlert(alert, '69000');
    priceAlertService.evaluateAlert(alert, '71000');
    expect(priceAlertService.getAlert(alert.id)?.status).toBe('CANCELLED');
  });

  it('21. Alert deletion', () => {
    const alert = priceAlertService.createAlert('BTCUSDT', 'FUTURES', 'ABOVE', '70000', 'ONCE');
    priceAlertService.deleteAlert(alert.id);
    expect(priceAlertService.getAlert(alert.id)).toBeUndefined();
    expect(priceAlertService.getAlerts().length).toBe(0);
  });

  it('22. Market-data unavailable', () => {
    const alert = priceAlertService.createAlert('BTCUSDT', 'FUTURES', 'ABOVE', '70000', 'ONCE');
    // Evaluate without explicitly passing price uses TickerService
    // Since TickerService has no data for BTCUSDT, shouldn't crash or trigger
    priceAlertService.evaluateAllAlerts();
    expect(alert.status).toBe('ACTIVE');
  });

  it('23. No NaN', () => {
    expect(() => priceAlertService.createAlert('BTCUSDT', 'FUTURES', 'ABOVE', 'NaN', 'ONCE')).toThrow();
  });

  it('24. No Infinity', () => {
    expect(() => priceAlertService.createAlert('BTCUSDT', 'FUTURES', 'ABOVE', 'Infinity', 'ONCE')).toThrow();
  });

  it('25. Event creation', () => {
    const alert = priceAlertService.createAlert('BTCUSDT', 'FUTURES', 'ABOVE', '70000', 'ONCE');
    
    let capturedEvent: AlertTriggeredEvent | null = null;
    priceAlertService.subscribe((e) => capturedEvent = e);
    
    priceAlertService.evaluateAlert(alert, '69000');
    priceAlertService.evaluateAlert(alert, '70500');
    
    expect(capturedEvent).not.toBeNull();
    expect(capturedEvent!.alertId).toBe(alert.id);
    expect(capturedEvent!.symbol).toBe('BTCUSDT');
    expect(capturedEvent!.condition).toBe('ABOVE');
    expect(capturedEvent!.targetPrice).toBe('70000');
    expect(capturedEvent!.triggerPrice).toBe('70500');
  });
});
