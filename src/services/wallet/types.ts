export type WalletType = 'SPOT' | 'FUTURES';

export interface Asset {
  asset: string;
  name: string;
  totalBalance: string;
  availableBalance: string;
  lockedBalance: string;
  marketValue: string; // in USDT
  status: 'ACTIVE' | 'INACTIVE';
}

export interface WalletBalances {
  total: string;           // Total across all wallets
  spotTotal: string;       // Spot total value
  futuresTotal: string;    // Futures total value
  
  spotAvailable: string;   // Spot USDT available
  futuresAvailable: string;// Futures USDT available
  
  spotLocked: string;      // Spot locked value
  futuresLocked: string;   // Futures locked margin
  unrealizedPnl: string;   // Futures unrealized PNL
}
