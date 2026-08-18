import { useState, useEffect } from 'react';
import { transactionService, Transaction } from '../services/transactions';

export function useTransactionHistory(userId: string = 'demo-user-1') {
  const [transactions, setTransactions] = useState<Transaction[]>([]);

  useEffect(() => {
    // Initial fetch
    setTransactions(transactionService.getTransactions(userId));

    // Subscribe to changes
    const unsubscribe = transactionService.subscribe(() => {
      setTransactions(transactionService.getTransactions(userId));
    });

    return () => {
      unsubscribe();
    };
  }, [userId]);

  return { transactions };
}
