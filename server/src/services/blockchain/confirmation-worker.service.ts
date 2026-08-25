/**
 * Phase 9.4 — Confirmation Worker Service
 *
 * Periodically updates confirmation_count for CONFIRMING deposits and
 * transitions CONFIRMING → CONFIRMED when the confirmation threshold
 * is reached.
 *
 * FORMULA: confirmation_count = max(0, currentBlockHeight - blockNumber + 1)
 *
 * CRITICAL BOUNDARY:
 * This service only updates blockchain_deposits state. It does NOT
 * create wallet_balances, ledger_transactions, or ledger_entries.
 * Phase 9.5 owns crediting.
 */

import { IDatabaseConnection } from '../../config/database';
import { IBlockchainSource } from './types';
import { logger } from '../../config/logger';

export interface ConfirmationRunResult {
  network: string;
  updatedConfirming: number;
  updatedConfirmed: number;
  errors: number;
}

export class ConfirmationWorkerService {
  private readonly network: string;

  constructor(
    private readonly database: IDatabaseConnection,
    private readonly source: IBlockchainSource,
  ) {
    this.network = this.source.chainId === 'ethereum' ? 'ETHEREUM' : 'BITCOIN';
  }

  /**
   * Execute one confirmation cycle:
   * 1. Get current block height from source
   * 2. Find all CONFIRMING deposits for this network
   * 3. Compute new confirmation_count
   * 4. Update rows that have reached the threshold
   */
  public async runOnce(): Promise<ConfirmationRunResult> {
    const result: ConfirmationRunResult = {
      network: this.network,
      updatedConfirming: 0,
      updatedConfirmed: 0,
      errors: 0,
    };

    try {
      // 1. Get current block height
      let currentBlockHeight: number;
      try {
        currentBlockHeight = await this.source.getBlockNumber();
      } catch (err: any) {
        logger.error('ConfirmationWorker: failed to get block height', {
          network: this.network,
          error: err.message,
        });
        result.errors++;
        return result;
      }

      // 2. Find all deposits in DETECTED or CONFIRMING state
      const depositsRes = await this.database.query<any>(
        `SELECT id, block_number AS "blockNumber", required_confirmations AS "requiredConfirmations",
                confirmation_count AS "confirmationCount", status
         FROM blockchain_deposits
         WHERE network = $1 AND status IN ('DETECTED', 'CONFIRMING')`,
        [this.network],
      );

      const now = new Date();
      for (const row of depositsRes.rows) {
        try {
          const newConfCount = Math.max(0, currentBlockHeight - row.blockNumber + 1);
          const newStatus = newConfCount >= row.requiredConfirmations ? 'CONFIRMED' : 'CONFIRMING';

          await this.database.query(
            `UPDATE blockchain_deposits
             SET confirmation_count = $1, status = $2, confirmed_at = CASE WHEN $2 = 'CONFIRMED' AND confirmed_at IS NULL THEN $3 ELSE confirmed_at END,
                 updated_at = $3
             WHERE id = $4`,
            [newConfCount, newStatus, now, row.id],
          );

          if (newStatus === 'CONFIRMED') {
            result.updatedConfirmed++;
          } else {
            result.updatedConfirming++;
          }
        } catch (err: any) {
          result.errors++;
          logger.error('ConfirmationWorker: update error', {
            id: row.id,
            error: err.message,
          });
        }
      }

      if (result.updatedConfirmed > 0) {
        logger.info('ConfirmationWorker: deposits confirmed', {
          network: this.network,
          confirmed: result.updatedConfirmed,
          confirming: result.updatedConfirming,
          currentBlockHeight,
        });
      }
    } catch (err: any) {
      result.errors++;
      logger.error('ConfirmationWorker: run failed', {
        network: this.network,
        error: err.message,
      });
    }

    return result;
  }
}