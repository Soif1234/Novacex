import { CustodyService } from '../custody/custody.service';
import { TreasuryService } from './treasury.service';
import { logger } from '../../config/logger';
import { WithdrawalRequest } from '../custody/custody.types';
import crypto from 'crypto';
import { Decimal } from 'decimal.js';

export class TreasuryManagerService {
  constructor(
    private readonly custodyService: CustodyService,
    private readonly treasuryService: TreasuryService
  ) {}

  /**
   * Initiates a treasury transfer from the KMS Hot Wallet to the Safe.
   * This is explicitly for exchange-owned treasury operations and
   * MUST NOT alter customer ledger balances.
   */
  public async consolidateToSafe(network: string, asset: string, amountBase: string): Promise<WithdrawalRequest> {
    const config = await this.treasuryService.getTreasuryConfig(network);
    if (!config) {
      throw new Error(`TreasuryManager: No treasury config for network ${network}`);
    }

    const amountDecimal = new Decimal(amountBase);
    if (amountDecimal.lte(0)) {
      throw new Error(`TreasuryManager: Amount must be positive.`);
    }

    // Verify it's active in custody
    if (!this.custodyService.isEnabled()) {
      throw new Error(`TreasuryManager: Custody service is disabled.`);
    }

    const clientWithdrawalId = `treasury-${network}-${asset}-${crypto.randomUUID()}`;

    const request: WithdrawalRequest = {
      clientWithdrawalId,
      asset,
      network,
      amount: amountDecimal.toString(),
      destinationAddress: config.safeAddress,
      accountId: 'HOUSE_TREASURY',
      status: 'PENDING',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    logger.info(`TreasuryManager: Initiating consolidation to Safe.`, {
      network,
      asset,
      amount: amountBase,
      destination: config.safeAddress
    });

    const result = await this.custodyService.requestWithdrawal(request);

    // Normally we'd track this in a treasury_transfers table for the outbound leg,
    // but the monitor will catch the on-chain transfer to the Safe.
    return result;
  }
}
