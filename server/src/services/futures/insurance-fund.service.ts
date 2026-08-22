import { IDatabaseConnection, db } from '../../config/database';
import { LedgerService, ledgerService } from '../ledger/ledger.service';
import { decimalCompare, decimalAdd, decimalSubtract } from '../ledger/decimal';
import { logger } from '../../config/logger';

export const SYSTEM_BOT_USER_ID = '00000000-0000-0000-0000-000000000000';
export const INSURANCE_FUND_ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';

export class InsuranceFundService {
  constructor(
    private database: IDatabaseConnection = db,
    private ledger: LedgerService = ledgerService
  ) {}

  /**
   * Retrieves the current available balance of the insurance fund for a specific asset.
   */
  public async getBalance(asset: string = 'FUTURES_USDT'): Promise<string> {
    const bal = await this.ledger.getBalance(INSURANCE_FUND_ACCOUNT_ID, asset);
    return bal.availableBalance;
  }
}

export const insuranceFundService = new InsuranceFundService();
