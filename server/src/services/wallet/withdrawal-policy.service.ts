import { db, IDatabaseConnection } from '../../config/database';
import { env } from '../../config/env';
import { decimalCompare } from '../ledger/decimal';
import { logger } from '../../config/logger';
import { AppError } from '../../middleware/errorHandler';

export interface WithdrawalPolicyDecision {
  decision: 'APPROVE' | 'REVIEW';
  reasons: string[];
}

export class WithdrawalPolicyService {
  constructor(private database: IDatabaseConnection = db) {}

  /**
   * Evaluate whether a withdrawal request can be auto-approved or requires manual review.
   */
  public async evaluate(
    userId: string,
    accountId: string,
    asset: string,
    network: string,
    amount: string,
    destinationAddress: string
  ): Promise<WithdrawalPolicyDecision> {
    const reasons: string[] = [];

    // 0. Account Status check
    const userRes = await this.database.query('SELECT account_status FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) {
      throw new AppError('User not found', 404, 'NOT_FOUND');
    }
    const user = userRes.rows[0] as any;
    const status = user.account_status ?? user.accountStatus;
    if (status !== 'ACTIVE') {
      throw new AppError(`User account is not active (${status}). Withdrawals are prohibited.`, 403, 'FORBIDDEN_ACCOUNT_STATUS');
    }

    // 1. High-value threshold check (Safe decimal string comparison)
    // LOCKED RULE: amount < threshold → APPROVE; amount == threshold → APPROVE; amount > threshold → REVIEW.
    const threshold = env.WITHDRAWAL_REVIEW_THRESHOLD;
    if (!threshold || threshold.trim() === '' || !/^\d+(\.\d+)?$/.test(threshold)) {
      reasons.push('WITHDRAWAL_REVIEW_THRESHOLD_NOT_CONFIGURED');
    } else {
      if (decimalCompare(amount, threshold) > 0) {
        reasons.push(`High-value withdrawal: amount (${amount}) > threshold (${threshold})`);
      }
    }

    // 2. First-time destination check
    const isFirstTime = await this.isFirstTimeDestination(userId, asset, network, destinationAddress);
    if (isFirstTime) {
      reasons.push(`First-time destination address for ${asset} on ${network}`);
    }

    if (reasons.length > 0) {
      logger.info('Withdrawal policy triggered manual review', { userId, accountId, asset, network, amount, reasons });
      return { decision: 'REVIEW', reasons };
    }

    return { decision: 'APPROVE', reasons: [] };
  }

  private async isFirstTimeDestination(
    userId: string,
    asset: string,
    network: string,
    destinationAddress: string
  ): Promise<boolean> {
    const res = await this.database.query(
      `SELECT 1
       FROM withdrawals w
       JOIN accounts a ON w.account_id = a.id
       WHERE a.user_id = $1
         AND w.asset = $2
         AND w.network = $3
         AND w.destination_address = $4
         AND w.status = 'COMPLETED'
       LIMIT 1`,
      [userId, asset, network, destinationAddress]
    );
    return res.rows.length === 0;
  }
}

export const withdrawalPolicyService = new WithdrawalPolicyService();
