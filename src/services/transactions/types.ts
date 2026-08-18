import { WalletType } from '../wallet/types';

export type TransactionType = 'DEPOSIT' | 'WITHDRAWAL' | 'TRANSFER' | 'REALIZED_PNL' | 'TRADING_FEE' | 'FUNDING' | 'MARGIN' | 'OTHER';
export type TransactionDirection = 'CREDIT' | 'DEBIT';
export type TransactionStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface Transaction {
    id: string;
    userId: string;
    type: TransactionType;
    asset: string;
    amount: string;
    balanceBefore?: string;
    balanceAfter?: string;
    wallet: WalletType;
    direction: TransactionDirection;
    status: TransactionStatus;
    referenceId?: string;
    symbol?: string;
    description: string;
    createdAt: number;
    completedAt?: number;
}
