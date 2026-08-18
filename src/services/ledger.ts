import { ledgerService, LedgerService, LedgerEntryType } from './wallet/LedgerService';

export type { LedgerEntry } from './wallet/LedgerService';

export class DemoLedger {
  private instance: LedgerService;

  constructor(persist: boolean = true) {
    this.instance = persist ? ledgerService : new LedgerService(false);
  }

  public subscribe(callback: () => void): () => void {
    return this.instance.subscribe(callback);
  }

  public getBalance(asset: string, accountId?: string): string {
    return this.instance.getBalance(asset, accountId);
  }

  public getAllBalances(accountId?: string): Record<string, string> {
    return this.instance.getAllBalances(accountId);
  }

  public getHistory(accountId?: string) {
    return this.instance.getHistory(accountId);
  }

  public credit(asset: string, amount: string | number, reason: string, ledgerType: string = 'OTHER', referenceId?: string, accountId?: string): void {
    this.instance.credit(asset, amount, reason, ledgerType as LedgerEntryType, referenceId, accountId);
  }

  public debit(asset: string, amount: string | number, reason: string, ledgerType: string = 'OTHER', referenceId?: string, accountId?: string): void {
    this.instance.debit(asset, amount, reason, ledgerType as LedgerEntryType, referenceId, accountId);
  }

  public reset(accountId?: string): void {
    this.instance.reset(accountId);
  }
}

// Export singleton proxying directly to canonical ledgerService
export const demoLedger = new DemoLedger(typeof window !== 'undefined');
