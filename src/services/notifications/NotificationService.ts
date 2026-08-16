import { Notification } from '../../types/notifications';
import { priceAlertService } from '../alerts/PriceAlertService';
import { AlertTriggeredEvent } from '../../types/alerts';

type NotificationListener = () => void;
type NewNotificationListener = (notification: Notification) => void;

class NotificationService {
  private notifications: Notification[] = [];
  private listeners: Set<NotificationListener> = new Set();
  private newNotifListeners: Set<NewNotificationListener> = new Set();
  private isInitialized = false;
  private unsubscribeAlerts: (() => void) | null = null;

  constructor() {
    this.load();
  }

  public initialize() {
    if (this.isInitialized) return;
    this.unsubscribeAlerts = priceAlertService.subscribe(this.onAlertTriggered);
    this.isInitialized = true;
  }

  public destroy() {
    if (this.unsubscribeAlerts) {
      this.unsubscribeAlerts();
      this.unsubscribeAlerts = null;
    }
    this.isInitialized = false;
  }

  private load() {
    try {
      if (typeof localStorage !== 'undefined') {
        const stored = localStorage.getItem('nova_notifications');
        if (stored) {
          this.notifications = JSON.parse(stored);
        }
      }
    } catch (e) {
      console.error('Failed to load notifications', e);
    }
  }

  private save() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('nova_notifications', JSON.stringify(this.notifications));
      }
    } catch (e) {
      console.error('Failed to save notifications', e);
    }
  }

  private onAlertTriggered = (event: AlertTriggeredEvent) => {
    this.createNotification(event);
  };

  private createNotification(event: AlertTriggeredEvent) {
    const notification: Notification = {
      id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'PRICE_ALERT',
      alertId: event.alertId,
      symbol: event.symbol,
      title: `${event.symbol} Price Alert`,
      message: `${event.symbol} crossed ${event.condition === 'ABOVE' ? 'above' : 'below'} ${event.targetPrice} USDT.`,
      triggerPrice: event.triggerPrice,
      targetPrice: event.targetPrice,
      condition: event.condition,
      createdAt: event.triggeredAt || Date.now(),
      read: false,
    };

    this.notifications.unshift(notification);
    if (this.notifications.length > 50) {
      this.notifications = this.notifications.slice(0, 50);
    }
    this.save();
    this.notifyListeners();
    this.notifyNewNotifListeners(notification);
  }

  public getNotifications(): Notification[] {
    return [...this.notifications];
  }

  public getUnreadCount(): number {
    return this.notifications.filter(n => !n.read).length;
  }

  public getUnreadNotifications(): Notification[] {
    return this.notifications.filter(n => !n.read);
  }

  public markAsRead(id: string) {
    const notification = this.notifications.find(n => n.id === id);
    if (notification && !notification.read) {
      notification.read = true;
      this.save();
      this.notifyListeners();
    }
  }

  public markAllAsRead() {
    let changed = false;
    this.notifications.forEach(n => {
      if (!n.read) {
        n.read = true;
        changed = true;
      }
    });
    if (changed) {
      this.save();
      this.notifyListeners();
    }
  }

  public deleteNotification(id: string) {
    const prevLength = this.notifications.length;
    this.notifications = this.notifications.filter(n => n.id !== id);
    if (this.notifications.length !== prevLength) {
      this.save();
      this.notifyListeners();
    }
  }

  public clearNotifications() {
    if (this.notifications.length > 0) {
      this.notifications = [];
      this.save();
      this.notifyListeners();
    }
  }

  public subscribe(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public subscribeNew(listener: NewNotificationListener): () => void {
    this.newNotifListeners.add(listener);
    return () => this.newNotifListeners.delete(listener);
  }

  private notifyNewNotifListeners(notification: Notification) {
    this.newNotifListeners.forEach(listener => listener(notification));
  }

  private notifyListeners() {
    this.listeners.forEach(listener => listener());
  }
}

export const notificationService = new NotificationService();
