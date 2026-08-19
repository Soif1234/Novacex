import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UserService, userService } from './user/UserService';
import { userPreferencesStore } from '../store/userPreferencesStore';
import { priceAlertService } from './alerts/PriceAlertService';
import { notificationService } from './notifications/NotificationService';
import { FuturesTpSlService, futuresTpSlService } from './futures/FuturesTpSlService';
import { FuturesPosition } from '../types/futures';

describe('Phase 3 Step 6 — Authentication, Authorization & Session Isolation', () => {
  const userAEmail = 'alice@example.com';
  const userBEmail = 'bob@example.com';
  const adminEmail = 'admin@mallickexchange.com';

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    userService.reset();
    userPreferencesStore.reset();
    priceAlertService.reset();
    notificationService.reset();
    notificationService.initialize();
    futuresTpSlService.reset();
  });

  it('1 & 2. User A and User B receive deterministic, distinct isolated identities', () => {
    const serviceA = new UserService(false);
    serviceA.login(userAEmail);
    const userA = serviceA.getCurrentUser();

    const serviceB = new UserService(false);
    serviceB.login(userBEmail);
    const userB = serviceB.getCurrentUser();

    expect(userA).toBeDefined();
    expect(userB).toBeDefined();
    expect(userA?.email).toBe('alice@example.com');
    expect(userB?.email).toBe('bob@example.com');
    expect(userA?.id).toBe('demo-' + btoa('alice@example.com').replace(/=/g, ''));
    expect(userB?.id).toBe('demo-' + btoa('bob@example.com').replace(/=/g, ''));
    expect(userA?.id).not.toBe(userB?.id);
  });

  it('3. User A session survives page reload correctly in sessionStorage', () => {
    const service1 = new UserService(true);
    service1.login(userAEmail);
    service1.updateProfile({ displayName: 'Alice Trader' });

    // Simulate page reload / new instance loading from sessionStorage
    const service2 = new UserService(true);
    const reloaded = service2.getCurrentUser();

    expect(reloaded).toBeDefined();
    expect(reloaded?.email).toBe('alice@example.com');
    expect(reloaded?.displayName).toBe('Alice Trader');
    expect(reloaded?.role).toBe('USER');
  });

  it('4. Logout removes the active authenticated session', () => {
    const service = new UserService(true);
    service.login(userAEmail);
    expect(service.getCurrentUser()).not.toBeNull();

    service.logout();
    expect(service.getCurrentUser()).toBeNull();

    // Reload check after logout
    const reloaded = new UserService(true);
    expect(reloaded.getCurrentUser()).toBeNull();
  });

  it('5 & 6. User B cannot inherit User A favorites or recent pairs', () => {
    // 1. User A logs in and favorites BTCUSDT, adds ETHUSDT to recents
    userService.login(userAEmail);
    const userA = userService.getCurrentUser()!;
    userPreferencesStore.setAccount(userA.id);

    userPreferencesStore.toggleFavorite('BTCUSDT');
    userPreferencesStore.addRecentPair('ETHUSDT');

    expect(userPreferencesStore.getFavorites()).toContain('BTCUSDT');
    expect(userPreferencesStore.getRecentPairs()).toContain('ETHUSDT');

    // 2. User A logs out, User B logs in
    userService.logout();
    userService.login(userBEmail);
    const userB = userService.getCurrentUser()!;
    userPreferencesStore.setAccount(userB.id);

    // User B should have completely clean preferences
    expect(userPreferencesStore.getFavorites()).toEqual([]);
    expect(userPreferencesStore.getRecentPairs()).toEqual([]);
    expect(userPreferencesStore.isFavorite('BTCUSDT')).toBe(false);

    // User B favorites SOLUSDT
    userPreferencesStore.toggleFavorite('SOLUSDT');
    expect(userPreferencesStore.getFavorites()).toEqual(['SOLUSDT']);

    // 3. Switch back to User A -> User A has BTCUSDT, not SOLUSDT
    userPreferencesStore.setAccount(userA.id);
    expect(userPreferencesStore.getFavorites()).toEqual(['BTCUSDT']);
    expect(userPreferencesStore.getRecentPairs()).toEqual(['ETHUSDT']);
  });

  it('7. User B cannot see User A price alerts', () => {
    // 1. User A logs in and creates a price alert
    userService.login(userAEmail);
    const userA = userService.getCurrentUser()!;

    const alertA = priceAlertService.createAlert('BTCUSDT', 'SPOT', 'ABOVE', '70000', 'ONCE', userA.id);
    expect(priceAlertService.getAlerts(userA.id)).toHaveLength(1);
    expect(priceAlertService.getAlerts(userA.id)[0].id).toBe(alertA.id);

    // 2. User B logs in
    userService.login(userBEmail);
    const userB = userService.getCurrentUser()!;

    // User B should see 0 alerts
    expect(priceAlertService.getAlerts(userB.id)).toHaveLength(0);

    // User B creates an alert for ETHUSDT
    const alertB = priceAlertService.createAlert('ETHUSDT', 'SPOT', 'BELOW', '2500', 'ONCE', userB.id);
    expect(priceAlertService.getAlerts(userB.id)).toHaveLength(1);
    expect(priceAlertService.getAlerts(userB.id)[0].id).toBe(alertB.id);

    // User A still only sees alert A
    expect(priceAlertService.getAlerts(userA.id)).toHaveLength(1);
    expect(priceAlertService.getAlerts(userA.id)[0].id).toBe(alertA.id);
  });

  it('8. User B cannot see User A notifications', () => {
    // 1. Trigger an alert notification for User A
    userService.login(userAEmail);
    const userA = userService.getCurrentUser()!;

    priceAlertService.createAlert('BTCUSDT', 'SPOT', 'ABOVE', '65000', 'ONCE', userA.id);
    
    // Simulate trigger
    priceAlertService['notifyTrigger']({
      alertId: 'alert-a',
      accountId: userA.id,
      symbol: 'BTCUSDT',
      condition: 'ABOVE',
      targetPrice: '65000',
      triggerPrice: '65500',
      triggeredAt: Date.now()
    });

    expect(notificationService.getNotifications(userA.id)).toHaveLength(1);
    expect(notificationService.getUnreadCount(userA.id)).toBe(1);

    // 2. User B logs in
    userService.login(userBEmail);
    const userB = userService.getCurrentUser()!;

    // User B should see 0 notifications
    expect(notificationService.getNotifications(userB.id)).toHaveLength(0);
    expect(notificationService.getUnreadCount(userB.id)).toBe(0);
  });

  it('9. User B cannot inherit User A TP/SL configuration', () => {
    const service = new FuturesTpSlService(false);
    
    const mockPosA: FuturesPosition = {
      positionId: 'pos-alice-1',
      accountId: 'user-alice-step6',
      symbol: 'BTCUSDT',
      side: 'LONG',
      quantity: '1',
      entryPrice: '60000',
      markPrice: '60000',
      leverage: 10,
      marginMode: 'ISOLATED',
      initialMargin: '6000',
      maintenanceMargin: '300',
      unrealizedPnl: '0',
      realizedPnl: '0',
      liquidationPrice: '54000',
      status: 'OPEN',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    service.addOrUpdateConfig({
      accountId: 'user-alice-step6',
      positionId: 'pos-alice-1',
      symbol: 'BTCUSDT',
      positionSide: 'LONG',
      quantity: '1',
      takeProfitEnabled: true,
      takeProfitPrice: '65000',
      stopLossEnabled: true,
      stopLossPrice: '55000'
    }, mockPosA);

    expect(service.getConfigs('user-alice-step6')).toHaveLength(1);
    expect(service.getConfigs('user-bob-step6')).toHaveLength(0);
  });

  it('10 & 11. Normal USER receives USER role; admin receives ADMIN role', () => {
    const userSvc = new UserService(false);
    
    // Normal user login
    userSvc.login('trader@example.com');
    expect(userSvc.getCurrentUser()?.role).toBe('USER');
    expect(userSvc.isAdmin()).toBe(false);

    // Admin login
    userSvc.login(adminEmail);
    expect(userSvc.getCurrentUser()?.role).toBe('ADMIN');
    expect(userSvc.isAdmin()).toBe(true);
  });

  it('12 & 13. Admin role persists across session reloads', () => {
    const service1 = new UserService(true);
    service1.login(adminEmail);
    expect(service1.isAdmin()).toBe(true);

    // Simulate page reload
    const service2 = new UserService(true);
    expect(service2.getCurrentUser()?.role).toBe('ADMIN');
    expect(service2.isAdmin()).toBe(true);
  });

  it('14 & 15. Switching A -> B reloads singleton state; switching B -> A restores A cleanly', () => {
    // Alice setup
    userService.login(userAEmail);
    const userA = userService.getCurrentUser()!;
    userPreferencesStore.setAccount(userA.id);
    userPreferencesStore.toggleFavorite('BTCUSDT');
    priceAlertService.createAlert('BTCUSDT', 'SPOT', 'ABOVE', '90000', 'ONCE', userA.id);

    expect(userPreferencesStore.getFavorites()).toEqual(['BTCUSDT']);
    expect(priceAlertService.getAlerts(userA.id)).toHaveLength(1);

    // Switch to Bob
    userService.login(userBEmail);
    const userB = userService.getCurrentUser()!;
    userPreferencesStore.setAccount(userB.id);
    userPreferencesStore.toggleFavorite('ETHUSDT');
    priceAlertService.createAlert('ETHUSDT', 'SPOT', 'BELOW', '2000', 'ONCE', userB.id);

    expect(userPreferencesStore.getFavorites()).toEqual(['ETHUSDT']);
    expect(priceAlertService.getAlerts(userB.id)).toHaveLength(1);

    // Switch back to Alice
    userService.login(userAEmail);
    userPreferencesStore.setAccount(userA.id);

    expect(userPreferencesStore.getFavorites()).toEqual(['BTCUSDT']);
    expect(priceAlertService.getAlerts(userA.id)).toHaveLength(1);
    expect(priceAlertService.getAlerts(userA.id)[0].symbol).toBe('BTCUSDT');
  });
});
