export interface DemoTrade {
  id: string;
  orderId: string;
  accountId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: string;
  quantity: string;
  fee?: string;
  feeAsset?: string;
  timestamp: number;
}
