import { db, IDatabaseConnection } from '../../config/database';
import { kycService, KycService } from './kyc.service';
import { KYC_TIER_DAILY_LIMITS, KycTier } from '../../models/kyc.model';
import { decimalAdd, decimalCompare, decimalNormalize, decimalSubtract } from '../ledger/decimal';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../config/logger';

export class AmlService {
  private kyc: KycService;

  constructor(
    private database: IDatabaseConnection = db,
    kyc?: KycService
  ) {
    this.kyc = kyc || new KycService(database);
  }

  /**
   * Check if an external crypto address is on the sanctions/blacklist
   */
  public async isAddressSanctioned(address: string): Promise<{ sanctioned: boolean; reason?: string }> {
    if (!address || !address.trim()) {
      return { sanctioned: false };
    }

    const cleanAddress = address.trim();
    const res = await this.database.query<any>(
      `SELECT id, address, reason, source
       FROM sanctioned_addresses
       WHERE address = $1 AND is_active = TRUE`,
      [cleanAddress]
    );

    if (res.rows.length > 0) {
      return {
        sanctioned: true,
        reason: res.rows[0].reason,
      };
    }

    return { sanctioned: false };
  }

  /**
   * Add an address to the AML sanction blacklist
   */
  public async addSanctionedAddress(address: string, reason: string, source = 'OFAC'): Promise<void> {
    await this.database.query(
      `INSERT INTO sanctioned_addresses (address, reason, source, is_active)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (address) DO UPDATE SET is_active = TRUE, reason = $2, updated_at = NOW()`,
      [address.trim(), reason.trim(), source.trim()]
    );
    logger.warn('Address added to AML sanctions blacklist', { address, reason, source });
  }

  /**
   * Calculate cumulative withdrawals for user across all accounts in the last 24 hours
   */
  public async get24HourWithdrawalTotal(userId: string): Promise<string> {
    // Find all accounts owned by this user
    const accRes = await this.database.query<any>(
      'SELECT id FROM accounts WHERE user_id = $1',
      [userId]
    );

    if (accRes.rows.length === 0) {
      return '0.000000000000000000';
    }

    const accountIds = accRes.rows.map((a) => a.id);

    // Sum ledger entries for WITHDRAWAL in last 24 hours, excluding failed/cancelled
    const txRes = await this.database.query<any>(
      `SELECT COALESCE(w.amount, le.amount) as amount
       FROM ledger_transactions lt
       JOIN ledger_entries le ON lt.id = le.transaction_id
       LEFT JOIN withdrawals w ON w.ledger_tx_id = lt.id
       WHERE lt.account_id = ANY($1)
         AND lt.transaction_type = 'WITHDRAWAL'
         AND le.direction = 'DEBIT'
         AND (w.id IS NULL OR w.status NOT IN ('FAILED', 'REJECTED', 'CANCELLED'))
         AND lt.created_at >= NOW() - INTERVAL '24 hours'`,
      [accountIds]
    );

    let total = '0.000000000000000000';
    for (const row of txRes.rows) {
      if (row.amount) {
        total = decimalAdd(total, row.amount);
      }
    }

    return total;
  }

  /**
   * Check withdrawal compliance (sanction check + KYC tier limits)
   */
  public async validateWithdrawalCompliance(params: {
    userId: string;
    asset: string;
    amount: string;
    destinationAddress?: string;
  }): Promise<void> {
    const { userId, asset, amount, destinationAddress } = params;

    // 1. Sanctions screening
    if (destinationAddress) {
      const sanctionCheck = await this.isAddressSanctioned(destinationAddress);
      if (sanctionCheck.sanctioned) {
        logger.warn('Withdrawal blocked by AML sanctions check', {
          userId,
          destinationAddress,
          reason: sanctionCheck.reason,
        });
        throw new AppError(
          `Withdrawal rejected: Destination address is flagged on sanctions blacklist (${sanctionCheck.reason || 'OFAC'})`,
          403,
          'SANCTIONED_ADDRESS_DETECTED'
        );
      }
    }

    // 2. Fetch KYC Profile and Tier
    const profile = await this.kyc.getProfile(userId);
    const tier: KycTier = profile.status === 'VERIFIED' ? profile.tier : 'TIER_0';
    const dailyLimit = KYC_TIER_DAILY_LIMITS[tier] || '0.000000000000000000';

    if (tier === 'TIER_0' || dailyLimit === '0.000000000000000000') {
      throw new AppError(
        'Withdrawal rejected: Unverified account (Tier 0). Please complete identity verification (KYC) to enable withdrawals.',
        403,
        'KYC_VERIFICATION_REQUIRED'
      );
    }

    // 3. Rolling 24-hour limit verification
    const used24h = await this.get24HourWithdrawalTotal(userId);
    const projected24h = decimalAdd(used24h, amount);

    if (decimalCompare(projected24h, dailyLimit) > 0) {
      const remaining = decimalSubtract(dailyLimit, used24h);
      const safeRemaining = decimalCompare(remaining, '0') > 0 ? remaining : '0.000000000000000000';

      logger.warn('Withdrawal rejected: Exceeds 24h KYC tier limit', {
        userId,
        tier,
        dailyLimit,
        used24h,
        requestedAmount: amount,
        remaining: safeRemaining,
      });

      throw new AppError(
        `Withdrawal exceeds 24-hour KYC limit for ${tier}. Limit: ${dailyLimit}, Used: ${used24h}, Remaining: ${safeRemaining}. Upgrade KYC tier to increase limit.`,
        403,
        'KYC_DAILY_LIMIT_EXCEEDED'
      );
    }
  }
}

export const amlService = new AmlService();
