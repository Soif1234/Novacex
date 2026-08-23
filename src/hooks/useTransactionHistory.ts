import { useState, useEffect } from 'react';
import { apiClient } from '../services/api/client';
import { LedgerTransactionEntity } from '../services/api/types';
import { Transaction, TransactionDirection, TransactionStatus, TransactionType } from '../services/transactions/types';

export function useTransactionHistory(userId: string = 'demo-user-1') {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;
    const fetchHistory = async () => {
      try {
        if (typeof window !== 'undefined') {
          const res = await apiClient.get<any>('/wallet/transactions');
          if (isMounted && res && res.transactions) {
            const history = Array.isArray(res.transactions) ? res.transactions : [];
            const mapped: Transaction[] = history.map((t: LedgerTransactionEntity) => {
              const amountDec = parseFloat((t as any).amount);
              return {
                id: t.id,
                userId: userId,
                type: (t.transactionType as TransactionType) || 'OTHER',
                asset: (t as any).asset,
                amount: Math.abs(amountDec).toString(),
                balanceBefore: '0',
                balanceAfter: '0',
                wallet: 'SPOT', // Default or derived
                direction: amountDec > 0 ? 'CREDIT' : 'DEBIT',
                status: 'COMPLETED',
                referenceId: t.referenceId,
                description: t.description,
                createdAt: new Date(t.createdAt).getTime()
              };
            });
            setTransactions(mapped);
          }
        }
      } catch (err) {
        console.error('Failed to fetch transaction history', err);
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchHistory();
    const interval = setInterval(fetchHistory, 15000);
    
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [userId]);

  return { transactions, loading };
}
