import { useState, useEffect } from 'react';
import { demoLedger, DemoLedger } from '../services/ledger';

export function useLedger(): { balances: Record<string, string>, ledger: DemoLedger } {
  const [balances, setBalances] = useState(demoLedger.getAllBalances());

  useEffect(() => {
    return demoLedger.subscribe(() => {
      setBalances(demoLedger.getAllBalances());
    });
  }, []);

  return { balances, ledger: demoLedger };
}
