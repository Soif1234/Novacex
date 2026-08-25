import crypto from 'crypto';
import { db, IDatabaseConnection } from '../../config/database';
import { logger } from '../../config/logger';
import { LedgerService } from '../ledger/ledger.service';
import { circuitBreakerService } from '../system/circuit-breaker.service';
import { mapBlockchainDepositRow } from '../../models/blockchain-deposit.model';

export class DepositCreditingService {
  private ledgerService: LedgerService;

  constructor(private database: IDatabaseConnection = db) {
    this.ledgerService = new LedgerService(this.database);
  }

  public async processBacklog(batchSize = 50): Promise<void> {
    const cb = await circuitBreakerService.getState();
    if (!cb.isDepositsEnabled) {
      return; // Halted by circuit breaker
    }

    const depositsRes = await this.database.query<any>(
      `SELECT id FROM blockchain_deposits WHERE status = 'CONFIRMED' AND is_credited = FALSE ORDER BY created_at ASC LIMIT $1`,
      [batchSize]
    );

        for (const row of depositsRes.rows) {
      await this.processDepositSafely(row.id);
    }
  }

  private async processDepositSafely(depositId: string): Promise<void> {
    try {
      await this.database.transaction(async (txClient) => {
        const cb = await circuitBreakerService.getState();
        if (!cb.isDepositsEnabled) {
          throw new Error('Deposits halted');
        }

        const depRes = await txClient.query<any>(
          `SELECT * FROM blockchain_deposits WHERE id = $1 FOR UPDATE SKIP LOCKED`,
          [depositId]
        );
        if (depRes.rows.length === 0) return;

        const deposit = mapBlockchainDepositRow(depRes.rows[0]);

        if (deposit.status !== 'CONFIRMED') throw new Error(`Status is not CONFIRMED (is ${deposit.status})`);
        if (deposit.isCredited) throw new Error('Deposit is already credited');
        
        const amountStr = deposit.amount;
        if (!amountStr || typeof amountStr !== 'string') {
          throw new Error(`Invalid amount ${amountStr}`);
        }
        
        if (!/^[0-9]+(\.[0-9]+)?$/.test(amountStr)) {
          throw new Error(`Invalid amount ${amountStr}`);
        }
        
        if (!/[1-9]/.test(amountStr)) {
          throw new Error(`Invalid amount ${amountStr}`);
        }

        const addressRes = await txClient.query<any>(
          `SELECT user_id, status FROM deposit_addresses WHERE LOWER(blockchain_address) = LOWER($1) AND network = $2 AND asset = $3`,
          [deposit.toAddress, deposit.network, deposit.asset]
        );
        
        if (addressRes.rows.length === 0) {
          throw new Error(`Deposit address ownership not found for ${deposit.toAddress}`);
        }

        const userId = addressRes.rows[0].user_id ?? addressRes.rows[0].userId;

        const userRes = await txClient.query<any>(
          `SELECT account_status FROM users WHERE id = $1`,
          [userId]
        );
        if (userRes.rows.length === 0) {
          throw new Error('User not found');
        }

        const accountStatus = userRes.rows[0].account_status ?? userRes.rows[0].accountStatus;
        if (accountStatus !== 'ACTIVE') {
          throw new Error(`User status is ${accountStatus}, skipping auto-credit`);
        }

        const assetRes = await txClient.query<any>(
          `SELECT is_active FROM asset_networks WHERE asset = $1 AND network = $2`,
          [deposit.asset, deposit.network]
        );
        if (assetRes.rows.length === 0) {
           throw new Error(`Asset network not found`);
        }
        const isActive = assetRes.rows[0].is_active ?? assetRes.rows[0].isActive;
        if (!isActive) {
          throw new Error(`Asset network ${deposit.asset}:${deposit.network} is not active`);
        }

        const accRes = await txClient.query<any>(
          `SELECT id FROM accounts WHERE user_id = $1 AND type = 'FUNDING'`,
          [userId]
        );
        if (accRes.rows.length === 0) {
          throw new Error('User does not have a FUNDING account');
        }
        const accountId = accRes.rows[0].id;

        const referenceId = `crypto_dep_${deposit.id}`;
        
        const txResult = await this.ledgerService.postTransaction({
          accountId,
          transactionType: 'DEPOSIT',
          referenceId,
          description: `Crypto deposit of ${deposit.amount} ${deposit.asset} on ${deposit.network}`,
          entries: [
            {
              accountId,
              asset: deposit.asset,
              direction: 'CREDIT',
              amount: deposit.amount,
              balancePool: 'available',
            }
          ]
        }, txClient);

        await txClient.query(
          `INSERT INTO deposits (id, account_id, asset, amount, status, tx_hash, ledger_tx_id, created_at, updated_at) VALUES ($1, $2, $3, $4, 'COMPLETED', $5, $6, NOW(), NOW())`,
          [crypto.randomUUID(), accountId, deposit.asset, deposit.amount, deposit.transactionHash, txResult.transactionId]
        );

        await txClient.query(
          `UPDATE blockchain_deposits SET is_credited = TRUE, ledger_tx_id = $1, updated_at = NOW() WHERE id = $2`,
          [txResult.transactionId, deposit.id]
        );
      });
    } catch (err: any) {
      if (err.message === 'Deposits halted') return;
      logger.error('DepositCreditingService: failed to credit deposit', {
        depositId,
        error: err.message,
      });
    }
  }
}






