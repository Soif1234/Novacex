export interface Notification {
  id: string;
  accountId?: string;
  type: 'PRICE_ALERT';
  alertId: string;
  symbol: string;
  title: string;
  message: string;
  triggerPrice: string;
  targetPrice: string;
  condition: 'ABOVE' | 'BELOW';
  createdAt: number;
  read: boolean;
  metadata?: any;
}
