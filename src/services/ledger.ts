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

  public getBalance(asset: string): string {
    return this.instance.getBalance(asset);
  }

  public getAllBalances(): Record<string, string> {
    return this.instance.getAllBalances();
  }

  public getHistory() {
    return this.instance.getHistory();
  }

  public credit(asset: string, amount: string | number, reason: string, ledgerType: string = 'OTHER', referenceId?: string): void {
    this.instance.credit(asset, amount, reason, ledgerType as LedgerEntryType, referenceId);
  }

  public debit(asset: string, amount: string | number, reason: string, ledgerType: string = 'OTHER', referenceId?: string): void {
    this.instance.debit(asset, amount, reason, ledgerType as LedgerEntryType, referenceId);
  }

  public reset(): void {
    this.instance.reset();
  }
}

// Export singleton proxying directly to canonical ledgerService
export const demoLedger = new DemoLedger(typeof window !== 'undefined');

