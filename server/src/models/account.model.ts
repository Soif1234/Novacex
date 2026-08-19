export type AccountType = 'SPOT' | 'FUTURES' | 'FUNDING' | 'SYSTEM_VAULT';

export interface AccountEntity {
  id: string;
  userId: string;
  type: AccountType;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssetEntity {
  symbol: string;
  name: string;
  decimals: number;
  isActive: boolean;
  isFiat: boolean;
  minWithdrawalAmount: string;
  withdrawalFee: string;
  createdAt: Date;
}

export interface WalletBalanceEntity {
  id: string;
  accountId: string;
  asset: string;
  availableBalance: string;
  lockedBalance: string;
  updatedAt: Date;
}
