/**
 * Phase 9.4 — Blockchain Deposit Entity
 *
 * Mirrors the `blockchain_deposits` database table (migration 018).
 * This is a NovaCEX on-chain observation record: detection, validation,
 * normalization, confirmation state, and reorg state.
 *
 * CRITICAL BOUNDARY:
 * This is NOT a wallet_balances row or a ledger entry. Phase 9.4 stores
 * blockchain TRUTH only. Phase 9.5 owns crediting.
 *
 * Lifecycle states (approved Phase 9.4 design):
 *   DETECTED -> CONFIRMING -> CONFIRMED
 *   DETECTED -> REJECTED
 *   CONFIRMED -> REORGED
 */

// ---------------------------------------------------------------------------
// Type Exports
// ---------------------------------------------------------------------------

export type BlockchainDepositStatus = 'DETECTED' | 'CONFIRMING' | 'CONFIRMED' | 'REJECTED' | 'REORGED';

export type BlockchainChainId = 'ethereum' | 'bitcoin';

export type BlockchainNetwork = 'ETHEREUM' | 'BITCOIN';

export interface BlockchainDepositEntity {
  id: string;                    // deterministic: sha256(chainId + ":" + txHash + ":" + logIndex)
  chainId: BlockchainChainId;
  asset: string;
  network: BlockchainNetwork;
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  blockTimestamp: Date;
  logIndex: number;              // EVM logIndex | Bitcoin voutIndex
  fromAddress: string | null;
  toAddress: string;             // the NovaCEX deposit address
  amount: string;                // decimal string (on-chain / 10^decimals)
  rawAmount: string;             // on-chain raw value (wei / satoshi)
  tokenContract: string | null;  // ERC-20 contract address; null for native
  decimals: number;              // on-chain precision from asset_networks
  confirmationCount: number;
  requiredConfirmations: number;
  status: BlockchainDepositStatus;
  detectedAt: Date;
  confirmedAt: Date | null;
  reorgedAt: Date | null;
  isCredited: boolean;
  ledgerTxId: string | null;
  rawPayload: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MonitorCheckpointEntity {
  network: BlockchainNetwork;
  lastBlockNumber: number;
  lastBlockHash: string | null;
  lastProcessedAt: Date;
  consecutiveErrors: number;
}

/**
 * Normalized blockchain event BEFORE it is persisted.
 * This is the provider-neutral representation of an on-chain observation.
 */
export interface BlockchainEvent {
  chainId: BlockchainChainId;
  network: BlockchainNetwork;
  asset: string;
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  blockTimestamp: Date;
  logIndex: number;
  fromAddress: string | null;
  toAddress: string;
  amount: string;
  rawAmount: string;
  tokenContract: string | null;
  decimals: number;
  requiredConfirmations: number;
  rawPayload: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute confirmation count from current block height.
 * Formula: max(0, currentBlockHeight - blockNumber + 1)
 */
export function computeConfirmations(currentBlockHeight: number, blockNumber: number): number {
  return Math.max(0, currentBlockHeight - blockNumber + 1);
}

/**
 * Normalize an on-chain raw amount (wei / satoshi) to a human decimal string
 * using the asset network's on-chain precision.
 * Uses BigInt — never floating point.
 * Example: rawAmount=1000000, decimals=6 -> "1"
 */
export function normalizeBlockchainAmount(rawAmount: string, decimals: number): string {
  try {
    const raw = BigInt(rawAmount);
    const factor = BigInt(10) ** BigInt(decimals);
    const intPart = raw / factor;
    const fracPart = raw % factor;
    if (fracPart === 0n) return intPart.toString();
    const fracStr = fracPart.toString().padStart(decimals, '0').replace(/0+$/, '');
    return `${intPart}.${fracStr}`;
  } catch {
    return rawAmount;
  }
}

/**
 * Map a raw database row (snake_case or camelCase) to a BlockchainDepositEntity.
 */
export function mapBlockchainDepositRow(row: Record<string, any>): BlockchainDepositEntity {
  return {
    id: row.id,
    chainId: row.chain_id ?? row.chainId,
    asset: row.asset,
    network: row.network,
    transactionHash: row.transaction_hash ?? row.transactionHash,
    blockNumber: row.block_number ?? row.blockNumber,
    blockHash: row.block_hash ?? row.blockHash,
    blockTimestamp: row.block_timestamp ?? row.blockTimestamp,
    logIndex: row.log_index ?? row.logIndex,
    fromAddress: row.from_address ?? row.fromAddress ?? null,
    toAddress: row.to_address ?? row.toAddress,
    amount: row.amount,
    rawAmount: row.raw_amount ?? row.rawAmount,
    tokenContract: row.token_contract ?? row.tokenContract ?? null,
    decimals: row.decimals,
    confirmationCount: row.confirmation_count ?? row.confirmationCount ?? 0,
    requiredConfirmations: row.required_confirmations ?? row.requiredConfirmations,
    status: row.status as BlockchainDepositStatus,
    detectedAt: row.detected_at ?? row.detectedAt,
    confirmedAt: row.confirmed_at ?? row.confirmedAt ?? null,
    reorgedAt: row.reorged_at ?? row.reorgedAt ?? null,
    isCredited: row.is_credited ?? row.isCredited ?? false,
    ledgerTxId: row.ledger_tx_id ?? row.ledgerTxId ?? null,
    rawPayload: row.raw_payload ?? row.rawPayload ?? null,
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
  };
}

/**
 * Map a raw database row to a MonitorCheckpointEntity.
 */
export function mapMonitorCheckpointRow(row: Record<string, any>): MonitorCheckpointEntity {
  return {
    network: row.network,
    lastBlockNumber: row.last_block_number ?? row.lastBlockNumber,
    lastBlockHash: row.last_block_hash ?? row.lastBlockHash ?? null,
    lastProcessedAt: row.last_processed_at ?? row.lastProcessedAt,
    consecutiveErrors: row.consecutive_errors ?? row.consecutiveErrors,
  };
}
