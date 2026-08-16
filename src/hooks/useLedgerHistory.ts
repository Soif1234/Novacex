import { useState, useEffect } from 'react';
import { ledgerService, LedgerEntry } from '../services/wallet/LedgerService';

export function useLedgerHistory() {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);

  useEffect(() => {
    // Initial fetch
    setEntries(ledgerService.getEntries());

    // Subscribe to changes
    const unsubscribe = ledgerService.subscribe(() => {
      setEntries(ledgerService.getEntries());
    });

    return unsubscribe;
  }, []);

  return { entries };
}
