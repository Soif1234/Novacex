import { IDatabaseConnection } from '../../config/database';
import { db } from '../../config/database';
import { logger } from '../../config/logger';
import { Decimal } from 'decimal.js';
import crypto from 'crypto';

export interface TreasuryConfig {
  id: number;
  network: string;
  chainId: string;
  safeAddress: string;
  ownerAddress: string;
  threshold: number;
  lowWaterUsd: string;
  highWaterUsd: string;
}

export interface TreasuryTransaction {
  id?: number;
  network: string;
  chainId: string;
  asset: string;
  tokenContract: string | null;
  sourceAddress: string;
  destinationAddress: string;
  amount: string; // Exact base unit string
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'REORGED' | 'RECONCILIATION_REQUIRED';
}

export class TreasuryService {
  constructor(private readonly pool: IDatabaseConnection) {}

  public async getTreasuryConfig(network: string): Promise<TreasuryConfig | null> {
    const res = await this.pool.query(
      `SELECT * FROM treasury_config WHERE network = $1 LIMIT 1`,
      [network]
    );
    if (res.rows.length === 0) return null;
    const row: any = res.rows[0];
    return {
      id: row.id,
      network: row.network,
      chainId: row.chain_id,
      safeAddress: row.safe_address,
      ownerAddress: row.owner_address,
      threshold: row.threshold,
      lowWaterUsd: row.low_water_usd,
      highWaterUsd: row.high_water_usd
    };
  }

  /**
   * Idempotently insert a treasury transaction.
   * Concurrent processing of the exact same event will safely conflict on the unique constraint.
   */
  public async insertTreasuryTransaction(tx: TreasuryTransaction): Promise<boolean> {
    try {
      await this.pool.query(
        `INSERT INTO treasury_transactions
         (network, chain_id, asset, token_contract, source_address, destination_address, amount, tx_hash, log_index, block_number, block_hash, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (network, tx_hash, log_index) DO NOTHING`,
        [
          tx.network,
          tx.chainId,
          tx.asset,
          tx.tokenContract,
          tx.sourceAddress,
          tx.destinationAddress,
          tx.amount,
          tx.txHash,
          tx.logIndex,
          tx.blockNumber,
          tx.blockHash,
          tx.status
        ]
      );
      // We don't necessarily know if it was inserted or skipped from DO NOTHING result in pg simply,
      // but returning true indicates no DB errors. For strict idempotency check we'd use rowCount.
      return true;
    } catch (err: any) {
      logger.error(`TreasuryService: Failed to insert treasury tx: ${err.message}`);
      throw err;
    }
  }

  public async updateTransactionStatus(network: string, txHash: string, logIndex: number, newStatus: string): Promise<void> {
    await this.pool.query(
      `UPDATE treasury_transactions SET status = $1, updated_at = NOW()
       WHERE network = $2 AND tx_hash = $3 AND log_index = $4`,
      [newStatus, network, txHash, logIndex]
    );
  }

  public async recordReconciliationEvent(
    network: string,
    expectedState: any,
    actualState: any,
    reason: string,
    txHash?: string
  ): Promise<void> {
    const eventId = crypto.randomUUID();
    await this.pool.query(
      `INSERT INTO treasury_reconciliation_events
       (event_id, treasury_network, expected_state, actual_state, reason, tx_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'OPEN')`,
      [eventId, network, JSON.stringify(expectedState), JSON.stringify(actualState), reason, txHash || null]
    );
  }
}

export const treasuryService = new TreasuryService(db);
