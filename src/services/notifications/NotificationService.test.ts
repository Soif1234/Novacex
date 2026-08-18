import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { notificationService } from './NotificationService';
import { AlertTriggeredEvent } from '../../types/alerts';

describe('NotificationService', () => {
  beforeEach(() => {
    // Clear localStorage
    const store: Record<string, string> = {};
    const mockLocalStorage = {
      getItem: (key: string) => store[key] || null,
      setItem: (key: string, value: string) => store[key] = value,
      clear: () => {}
    };
    Object.defineProperty(window, 'localStorage', { value: mockLocalStorage, writable: true });
    
    // Clear notifications
    notificationService.clearNotifications();
  });

  afterEach(() => {
    notificationService.destroy();
  });

  const mockEvent: AlertTriggeredEvent = {
    alertId: 'test_alert_id',
    symbol: 'BTCUSDT',
    condition: 'ABOVE',
    targetPrice: '70000',
    triggerPrice: '70100',
    triggeredAt: Date.now()
  };

  it('1. Create notification from event', () => {
    // @ts-ignore
    notificationService.createNotification(mockEvent);
    
    const notifs = notificationService.getNotifications();
    expect(notifs.length).toBe(1);
    const n = notifs[0];
    
    expect(n.type).toBe('PRICE_ALERT');
    expect(n.alertId).toBe(mockEvent.alertId);
    expect(n.symbol).toBe(mockEvent.symbol);
    expect(n.targetPrice).toBe(mockEvent.targetPrice);
    expect(n.triggerPrice).toBe(mockEvent.triggerPrice);
    expect(n.read).toBe(false);
  });

  it('2. Get unread count', () => {
    // @ts-ignore
    notificationService.createNotification(mockEvent);
    expect(notificationService.getUnreadCount()).toBe(1);
    
    // @ts-ignore
    notificationService.createNotification({...mockEvent, alertId: 'another'});
    expect(notificationService.getUnreadCount()).toBe(2);
  });

  it('3. Mark as read', () => {
    // @ts-ignore
    notificationService.createNotification(mockEvent);
    const id = notificationService.getNotifications()[0].id;
    
    notificationService.markAsRead(id);
    expect(notificationService.getUnreadCount()).toBe(0);
    expect(notificationService.getNotifications()[0].read).toBe(true);
  });

  it('4. Mark all as read', () => {
    // @ts-ignore
    notificationService.createNotification(mockEvent);
    // @ts-ignore
    notificationService.createNotification({...mockEvent, alertId: 'another'});
    
    expect(notificationService.getUnreadCount()).toBe(2);
    
    notificationService.markAllAsRead();
    
    expect(notificationService.getUnreadCount()).toBe(0);
  });

  it('5. Delete notification', () => {
    // @ts-ignore
    notificationService.createNotification(mockEvent);
    const id = notificationService.getNotifications()[0].id;
    
    notificationService.deleteNotification(id);
    
    expect(notificationService.getNotifications().length).toBe(0);
  });

  it('6. Clear all notifications', () => {
    // @ts-ignore
    notificationService.createNotification(mockEvent);
    // @ts-ignore
    notificationService.createNotification({...mockEvent, alertId: 'another'});
    
    notificationService.clearNotifications();
    
    expect(notificationService.getNotifications().length).toBe(0);
  });

  it('7. Notification limit', () => {
    for (let i = 0; i < 60; i++) {
      // @ts-ignore
      notificationService.createNotification({...mockEvent, alertId: 'id_' + i});
    }
    
    expect(notificationService.getNotifications().length).toBe(50);
  });
});
