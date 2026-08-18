export interface PriceAlert {
  id: string;
  symbol: string;
  marketType: 'SPOT' | 'FUTURES';
  condition: 'ABOVE' | 'BELOW';
  targetPrice: string;
  status: 'ACTIVE' | 'TRIGGERED' | 'CANCELLED' | 'EXPIRED';
  createdAt: number;
  triggeredAt?: number;
  lastCheckedPrice?: string;
  repeat: 'ONCE' | 'REPEATING';
  lastTriggeredAt?: number;
}

export interface AlertTriggeredEvent {
  alertId: string;
  symbol: string;
  condition: 'ABOVE' | 'BELOW';
  targetPrice: string;
  triggerPrice: string;
  triggeredAt: number;
}
