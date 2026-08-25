/**
 * Phase 9.4 — Blockchain Source Abstraction
 *
 * Provider-neutral interface for reading blockchain data from any
 * underlying source (RPC, indexer, API, mock).
 *
 * All source implementations MUST be disabled unless explicitly configured.
 * No real blockchain requests during tests. No provider credentials stored
 * in source files.
 */

import crypto from 'crypto';

// ---------------------------------------------------------------------------
// BlockchainSource Interface
// ---------------------------------------------------------------------------

export interface GetLogsRequest {
  fromBlock: number;
  toBlock: number;
  /** Contract addresses to filter logs by (ERC-20 Transfer events). */
  addresses?: string[];
  /** Topic signatures to filter by (e.g. Transfer event sig). */
  topics?: string[][];
}

export interface BlockHeader {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
  /** Raw block payload for audit trail. */
  rawPayload: Record<string, unknown> | null;
}

export interface TransactionData {
  hash: string;
  from: string;
  to: string | null;
  value: string;              // raw hex or decimal string
  blockNumber: number;
  blockHash: string;
  timestamp: number;
  input: string;
  rawPayload: Record<string, unknown> | null;
}

export interface LogEntry {
  address: string;            // contract address that emitted the log
  topics: string[];           // topic[0] = event signature
  data: string;               // hex-encoded log data
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
  removed: boolean;           // true if log was removed by a reorg
  rawPayload: Record<string, unknown> | null;
}

export interface AddressTransaction {
  txHash: string;
  voutIndex: number;
  blockNumber: number;
  blockHash: string;
  timestamp: number;
  from: string;
  to: string;
  value: string;
  rawPayload: Record<string, unknown> | null;
}

export interface HealthCheckResult {
  healthy: boolean;
  currentBlockHeight: number;
  latencyMs: number;
  error?: string;
}

export interface IBlockchainSource {
  readonly chainId: string;       // 'ethereum' | 'bitcoin'
  readonly displayName: string;   // e.g. 'Ethereum RPC', 'Bitcoin API'

  /** Get the latest known block number. */
  getBlockNumber(): Promise<number>;

  /** Get a full block by number (header + transactions). */
  getBlock(blockNumber: number): Promise<BlockHeader | null>;

  /** Get a transaction by hash. */
  getTransaction(txHash: string): Promise<TransactionData | null>;

  /**
   * Get event logs matching the given filter.
   * Used for ERC-20 Transfer event polling on Ethereum.
   */
  getLogs(request: GetLogsRequest): Promise<LogEntry[]>;

  /**
   * Get transactions involving a specific address between block ranges.
   * Used for Bitcoin address monitoring.
   */
  getAddressTransactions(
    address: string,
    fromBlock: number,
    toBlock: number
  ): Promise<AddressTransaction[]>;

  /** Check source health and return current block height. */
  healthCheck(): Promise<HealthCheckResult>;
}

// ---------------------------------------------------------------------------
// Deterministic Event ID
// ---------------------------------------------------------------------------

/**
 * Compute the deterministic id for a blockchain event.
 *
 * EVM (ERC-20 / native): sha256(chainId + ":" + txHash + ":" + logIndex)
 * Bitcoin:               sha256(chainId + ":" + txHash + ":" + voutIndex)
 */
export function computeBlockchainEventId(
  chainId: string,
  transactionHash: string,
  logIndex: number
): string {
  const payload = `${chainId}:${transactionHash}:${logIndex}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// ---------------------------------------------------------------------------
// Event Signature Constants
// ---------------------------------------------------------------------------

/** ERC-20 Transfer event topic hash: keccak256("Transfer(address,address,uint256)") */
export const ERC20_TRANSFER_EVENT_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Alias used by the monitor and tests. */
export const ERC20_TRANSFER_TOPIC = ERC20_TRANSFER_EVENT_TOPIC;

/** Maximum number of consecutive errors before alerting. */
export const MAX_CONSECUTIVE_ERRORS = 10;