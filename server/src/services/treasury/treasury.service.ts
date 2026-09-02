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
  txHash: string | null;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  status: 'PENDING' | 'READY_FOR_MANUAL_EXECUTION' | 'CONFIRMED' | 'FAILED' | 'REORGED' | 'RECONCILIATION_REQUIRED';
  clientWithdrawalId?: string;
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
  public async insertTreasuryTransaction(tx: TreasuryTransaction, dbClient: any = this.pool): Promise<boolean> {
    try {
      await dbClient.query(
        `INSERT INTO treasury_transactions
         (network, chain_id, asset, token_contract, source_address, destination_address, amount, tx_hash, log_index, block_number, block_hash, status, client_withdrawal_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
          tx.status,
          tx.clientWithdrawalId || null
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

  public async getSyncStatus(network: string): Promise<{ lastBlockNumber: number; lastBlockHash: string } | null> {
    const res = await this.pool.query<any>(
      `SELECT last_block_number, last_block_hash FROM treasury_sync_status WHERE network = $1`,
      [network]
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      lastBlockNumber: Number(row.last_block_number),
      lastBlockHash: row.last_block_hash
    };
  }

  public async updateSyncStatus(network: string, blockNumber: number, blockHash: string, dbClient: any = this.pool): Promise<void> {
    await dbClient.query(
      `INSERT INTO treasury_sync_status (network, last_block_number, last_block_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (network) DO UPDATE SET
       last_block_number = EXCLUDED.last_block_number,
       last_block_hash = EXCLUDED.last_block_hash,
       updated_at = NOW()`,
      [network, blockNumber, blockHash]
    );
  }

  public async getAllowedAssets(network: string): Promise<{ asset: string; contractAddress: string | null }[]> {
    const res = await this.pool.query<any>(
      `SELECT asset, contract_address FROM asset_networks WHERE network = $1 AND is_active = TRUE`,
      [network]
    );
    return res.rows.map(r => ({
      asset: r.asset,
      contractAddress: r.contract_address
    }));
  }

  public getDatabase(): IDatabaseConnection {
    return this.pool;
  }
}

export const treasuryService = new TreasuryService(db);
