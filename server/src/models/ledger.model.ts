export type LedgerTxType =
  | 'DEPOSIT'
  | 'WITHDRAWAL'
  | 'INTERNAL_TRANSFER'
  | 'SPOT_ORDER_LOCK'
  | 'SPOT_ORDER_UNLOCK'
  | 'SPOT_TRADE_SETTLE'
  | 'FUTURES_MARGIN_LOCK'
  | 'FUTURES_MARGIN_RELEASE'
  | 'FUTURES_PNL_REALIZED'
  | 'FUTURES_FUNDING_PAYMENT'
  | 'FUTURES_LIQUIDATION'
  | 'TRADING_FEE';

export type EntryDirection = 'CREDIT' | 'DEBIT';
export type TransferStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'REJECTED';

export interface LedgerTransactionEntity {
  id: string;
  accountId: string;
  transactionType: LedgerTxType;
  referenceId: string;
  description: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface LedgerEntryEntity {
  id: string;
  transactionId: string;
  accountId: string;
  asset: string;
  direction: EntryDirection;
  amount: string;
  balanceAfter: string;
  createdAt: Date;
}

export interface DepositEntity {
  id: string;
  accountId: string;
  asset: string;
  amount: string;
  status: TransferStatus;
  txHash?: string;
  ledgerTxId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface WithdrawalEntity {
  id: string;
  accountId: string;
  asset: string;
  amount: string;
  fee: string;
  status: TransferStatus;
  destinationAddress: string;
  txHash?: string;
  ledgerTxId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface InternalTransferEntity {
  id: string;
  userId: string;
  fromAccountId: string;
  toAccountId: string;
  asset: string;
  amount: string;
  status: TransferStatus;
  ledgerTxId?: string;
  createdAt: Date;
}
