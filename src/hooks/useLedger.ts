import { useState, useEffect } from 'react';
import { demoLedger, DemoLedger } from '../services/ledger';

export function useLedger(accountId: string = 'demo-user-1'): { balances: Record<string, string>, ledger: DemoLedger } {
  const [balances, setBalances] = useState(demoLedger.getAllBalances(accountId));

  useEffect(() => {
    const update = () => {
      setBalances(demoLedger.getAllBalances(accountId));
    };
    update();
    return demoLedger.subscribe(update);
  }, [accountId]);

  return { balances, ledger: demoLedger };
}
