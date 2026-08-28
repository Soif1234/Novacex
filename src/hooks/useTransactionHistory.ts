import { useState, useEffect } from 'react';
import { apiClient } from '../services/api/client';
import { LedgerTransactionEntity } from '../services/api/types';
import { Transaction, TransactionDirection, TransactionStatus, TransactionType } from '../services/transactions/types';
import { Decimal } from 'decimal.js';

export function useTransactionHistory(userId: string = 'demo-user-1') {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;
    const fetchHistory = async () => {
      try {
        if (typeof window !== 'undefined') {
          const res = await apiClient.get<any>('/wallet/transactions');
          if (isMounted && res && res.entries) {
            const history = Array.isArray(res.entries) ? res.entries : [];
            const mapped: Transaction[] = history.map((t: LedgerTransactionEntity) => {
              const amountStr = (t as any).amount || '0';
              const dec = new Decimal(amountStr);
              return {
                id: t.id,
                userId: userId,
                type: (t.transactionType as TransactionType) || 'OTHER',
                asset: (t as any).asset,
                amount: dec.abs().toString(),
                balanceBefore: (t as any).balanceBefore || '0',
                balanceAfter: (t as any).balanceAfter || '0',
                wallet: 'SPOT',
                direction: dec.gt(0) ? 'CREDIT' : 'DEBIT',
                status: (t as any).status || 'COMPLETED',
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
    // Removed overly aggressive polling; rely on WS or refresh
    
    return () => {
      isMounted = false;
    };
  }, [userId]);

  return { transactions, loading };
}
