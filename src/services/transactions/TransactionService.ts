import { Transaction, TransactionType, TransactionStatus, TransactionDirection } from './types';
import { WalletType } from '../wallet/types';
import { ledgerService, LedgerEntry } from '../wallet/LedgerService';

export class TransactionService {
    public subscribe(callback: () => void) {
        return ledgerService.subscribe(callback);
    }

    private mapToTransaction(entry: LedgerEntry): Transaction {
        return {
            id: entry.id,
            userId: entry.userId || 'demo-user-1',
            type: entry.type as TransactionType,
            asset: entry.asset,
            amount: entry.amount,
            balanceBefore: entry.balanceBefore,
            balanceAfter: entry.balanceAfter,
            wallet: entry.wallet,
            direction: entry.direction as TransactionDirection,
            status: entry.status as TransactionStatus,
            referenceId: entry.referenceId,
            symbol: entry.symbol,
            description: entry.description,
            createdAt: entry.createdAt
        };
    }

    public recordTransaction(tx: Omit<Transaction, 'id' | 'createdAt'>): Transaction {
        const ledgerEntry = ledgerService.addEntry({
            type: tx.type as any,
            asset: tx.asset,
            amount: tx.amount,
            balanceBefore: tx.balanceBefore || '0',
            balanceAfter: tx.balanceAfter || '0',
            wallet: tx.wallet,
            direction: tx.direction as any,
            status: tx.status as any,
            referenceId: tx.referenceId,
            symbol: tx.symbol,
            description: tx.description
        });
        return this.mapToTransaction(ledgerEntry);
    }

    public getTransactions(userId?: string): Transaction[] {
        let entries = ledgerService.getEntries().map(e => this.mapToTransaction(e));
        if (userId) {
            entries = entries.filter(t => t.userId === userId);
        }
        return entries;
    }

    public getTransaction(id: string): Transaction | undefined {
        const entry = ledgerService.getEntry(id);
        return entry ? this.mapToTransaction(entry) : undefined;
    }

    public getTransactionsByType(type: TransactionType, userId?: string): Transaction[] {
        return this.getTransactions(userId).filter(t => t.type === type);
    }

    public getTransactionsByAsset(asset: string, userId?: string): Transaction[] {
        return this.getTransactions(userId).filter(t => t.asset === asset);
    }

    public getTransactionsByWallet(wallet: WalletType, userId?: string): Transaction[] {
        return this.getTransactions(userId).filter(t => t.wallet === wallet);
    }

    public getTransactionsByReference(referenceId: string): Transaction[] {
        return ledgerService.getEntriesByReference(referenceId).map(e => this.mapToTransaction(e));
    }
}

export const transactionService = new TransactionService();
