/**
 * Phase 9.4 — Blockchain Monitor Service
 *
 * Core monitor: polls a blockchain source, normalizes on-chain observations,
 * validates against NovaCEX domain rules, and persists to blockchain_deposits.
 *
 * CRITICAL BOUNDARY:
 * Phase 9.4 ends at DETECT → VALIDATE → NORMALIZE → PERSIST → CONFIRMATION STATE
 * → REORG STATE. This service NEVER creates wallet_balances, ledger_transactions,
 * or ledger_entries. Phase 9.5 owns crediting.
 *
 * DESIGN:
 * 1. Read checkpoint → get current block height → detect reorg → scan new blocks
 * 2. Identify supported deposit events → normalize → validate → match address
 * 3. Persist with ON CONFLICT DO NOTHING → advance checkpoint
 * 4. Circuit breaker: is_deposits_enabled=false → deposits REJECTED
 */

import { IDatabaseConnection } from '../../config/database';
import { logger } from '../../config/logger';
import { IBlockchainSource, computeBlockchainEventId, ERC20_TRANSFER_TOPIC } from './types';
import { BlockchainDepositEntity, BlockchainEvent, BlockchainDepositStatus, normalizeBlockchainAmount } from '../../models/blockchain-deposit.model';
import { isValidContractAddress } from '../../models/asset-network.model';
import { SystemSubsystem, CircuitBreakerMode } from '../../models/system.model';
import { CreateThreatAlertDto } from '../../models/reconciliation.model';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Reorg tracking depth per network (in blocks). */
const REORG_DEPTH: Record<string, number> = {
  ETHEREUM: 6,
  BITCOIN: 1,
};

/** Maximum consecutive provider errors before alert is created. */
const MAX_CONSECUTIVE_ERRORS = 10;

// ---------------------------------------------------------------------------
// Error / Context Types
// ---------------------------------------------------------------------------

export interface MonitorRejection {
  reason: string;
  detail?: string;
}

export interface MonitorRunResult {
  network: string;
  scannedBlocks: number;
  detected: number;
  inserted: number;
  rejected: number;
  reorged: number;
  errors: number;
  checkpointAdvanced: boolean;
}

// ---------------------------------------------------------------------------
// Monitor Service
// ---------------------------------------------------------------------------

export class BlockchainMonitorService {
  private readonly network: string;
  private readonly chainId: string;
  /** Cache of recent block hashes for reorg detection, keyed by block number. */
  private recentBlockHashes = new Map<number, string>();
  private consecutiveErrors = 0;
  private lastAlertedError = 0;

  constructor(
    private readonly database: IDatabaseConnection,
    private readonly source: IBlockchainSource,
    private readonly circuitBreakerService?: {
      isSubsystemOperational: (subsystem: SystemSubsystem) => Promise<{
        operational: boolean;
        reason?: string | null;
        mode: CircuitBreakerMode;
      }>;
    },
    private readonly threatAlertService?: {
      createAlert: (dto: CreateThreatAlertDto) => Promise<any>;
    },
  ) {
    this.chainId = source.chainId;
    // Map chainId to NovaCEX network name
    this.network = this.chainId === 'ethereum' ? 'ETHEREUM' : 'BITCOIN';
  }

  /** The NovaCEX network name this monitor is responsible for. */
  public getNetwork(): string {
    return this.network;
  }

  // -------------------------------------------------------------------------
  // Main Run
  // -------------------------------------------------------------------------

  /**
   * Execute one full monitoring cycle: scan new blocks, detect events,
   * persist observations, handle reorg, advance checkpoint.
   */
  public async runOnce(): Promise<MonitorRunResult> {
    const result: MonitorRunResult = {
      network: this.network,
      scannedBlocks: 0,
      detected: 0,
      inserted: 0,
      rejected: 0,
      reorged: 0,
      errors: 0,
      checkpointAdvanced: false,
    };

    try {
      // 1. Read checkpoint
      const checkpoint = await this.readCheckpoint();
      if (!checkpoint) {
        logger.warn('BlockchainMonitor: no checkpoint found, skipping run', { network: this.network });
        return result;
      }

      // 2. Get current block height
      let currentHeight: number;
      try {
        currentHeight = await this.source.getBlockNumber();
      } catch (err: any) {
        this.consecutiveErrors++;
        await this.maybeAlert(err);
        logger.error('BlockchainMonitor: failed to get current block height', {
          network: this.network,
          error: err.message,
          consecutiveErrors: this.consecutiveErrors,
        });
        result.errors++;
        return result;
      }

      // 3. Detect reorg: check if the stored last block hash matches the chain
      if (checkpoint.lastBlockHash && checkpoint.lastBlockNumber > 0) {
        const reorgDepth = await this.detectReorg(checkpoint.lastBlockNumber, checkpoint.lastBlockHash);
        if (reorgDepth > 0) {
          const reorged = await this.handleReorg(reorgDepth, checkpoint.lastBlockNumber);
          result.reorged += reorged;
          // Rewind checkpoint — re-read after reorg handling
          const rewoundCheckpoint = await this.readCheckpoint();
          if (rewoundCheckpoint) {
            checkpoint.lastBlockNumber = rewoundCheckpoint.lastBlockNumber;
            checkpoint.lastBlockHash = rewoundCheckpoint.lastBlockHash;
          }
        }
      }

      // 4. Determine scan range
      const fromBlock = checkpoint.lastBlockNumber + 1;
      const toBlock = currentHeight;

      if (fromBlock > toBlock) {
        // No new blocks — update checkpoint timestamp anyway
        await this.updateCheckpointTimestamp();
        result.checkpointAdvanced = true;
        this.consecutiveErrors = 0;
        return result;
      }

      result.scannedBlocks = toBlock - fromBlock + 1;

      // 5. Check deposits circuit breaker
      let depositsEnabled = true;
      if (this.circuitBreakerService) {
        try {
          const cb = await this.circuitBreakerService.isSubsystemOperational('DEPOSITS');
          depositsEnabled = cb.operational;
        } catch {
          // If circuit breaker unavailable, assume deposits enabled
          depositsEnabled = true;
        }
      }

      // 6. For each block, fetch events and process
      //    Batch by block range for efficiency
      const batchSize = Math.min(100, toBlock - fromBlock + 1);
      for (let start = fromBlock; start <= toBlock; start += batchSize) {
        const end = Math.min(start + batchSize - 1, toBlock);

        try {
          const events = await this.fetchEventsForBlockRange(start, end);

          for (const rawEvent of events) {
            result.detected++;
            // 6a. Validate asset/network/contract/address
            const validation = await this.validateEvent(rawEvent, depositsEnabled);
            if (!validation.valid) {
              result.rejected++;
              // Persist rejected event for audit trail (only when the asset
              // is resolvable — unknown tokens have no valid FK target).
              if (rawEvent.asset) {
                await this.persistEvent(rawEvent, validation.status, validation.rejection);
              }
              continue;
            }
            // 6b. Persist accepted event
            await this.persistEvent(rawEvent, validation.status, null);
            result.inserted++;
          }
        } catch (err: any) {
          this.consecutiveErrors++;
          result.errors++;
          logger.error('BlockchainMonitor: batch scan error', {
            network: this.network,
            fromBlock: start,
            toBlock: end,
            error: err.message,
          });
          await this.maybeAlert(err);
          // Do NOT advance checkpoint past a failed batch
          return result;
        }

        // 7. Update recent block hashes for reorg tracking
        await this.updateRecentBlockHashes(start, end);
      }

      // 8. Advance checkpoint
      await this.advanceCheckpoint(toBlock);
      result.checkpointAdvanced = true;
      this.consecutiveErrors = 0;

      if (result.detected > 0) {
        logger.info('BlockchainMonitor: run complete', {
          network: this.network,
          scannedBlocks: result.scannedBlocks,
          detected: result.detected,
          inserted: result.inserted,
          rejected: result.rejected,
          reorged: result.reorged,
        });
      }
    } catch (err: any) {
      this.consecutiveErrors++;
      result.errors++;
      logger.error('BlockchainMonitor: run failed', {
        network: this.network,
        error: err.message,
      });
      await this.maybeAlert(err);
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Event Fetching
  // -------------------------------------------------------------------------

  /**
   * Fetch events from the blockchain source for a range of blocks.
   * Returns normalized BlockchainEvent objects.
   */
  private async fetchEventsForBlockRange(fromBlock: number, toBlock: number): Promise<BlockchainEvent[]> {
    const events: BlockchainEvent[] = [];

    if (this.network === 'ETHEREUM') {
      const allAddresses = await this.getActiveDepositAddresses();
      if (allAddresses.length === 0) {
        return []; // Empty address set: avoid querying the entire chain unnecessarily
      }

      const assetRes = await this.database.query<any>(
        `SELECT DISTINCT contract_address
         FROM asset_networks
         WHERE network = $1 AND contract_address IS NOT NULL`,
        [this.network]
      );
      const tokenContracts = assetRes.rows.map((r: any) => r.contract_address);

      let logs: any[] = [];
      if (tokenContracts.length > 0) {
        const ADDRESS_BATCH_SIZE = 500;
        for (let i = 0; i < allAddresses.length; i += ADDRESS_BATCH_SIZE) {
          const batch = allAddresses.slice(i, i + ADDRESS_BATCH_SIZE);
          const paddedAddresses = batch.map((addr: string) =>
            '0x' + addr.toLowerCase().replace('0x', '').padStart(64, '0')
          );

          const batchLogs = await this.source.getLogs({
            fromBlock,
            toBlock,
            addresses: tokenContracts,
            topics: [
              [ERC20_TRANSFER_TOPIC],
              null,
              paddedAddresses
            ],
          });
          logs.push(...batchLogs);
        }

        // Defensively deduplicate logs to ensure a legitimate event appears exactly once
        const uniqueLogs = new Map<string, any>();
        for (const log of logs) {
          const key = `${log.transactionHash}:${log.logIndex}`;
          uniqueLogs.set(key, log);
        }
        logs = Array.from(uniqueLogs.values());
      }

      for (const log of logs) {
        if (log.removed) continue; // Skip reorg-removed logs

        // Parse ERC-20 Transfer event data
        // topics[1] = from (address), topics[2] = to (address)
        // data = amount (uint256)
        const fromAddress = this.parseEvmAddress(log.topics[1]);
        const toAddress = this.parseEvmAddress(log.topics[2]);
        const amount = this.parseEvmUint256(log.data);

        if (!fromAddress || !toAddress || !amount) continue;

        // Get block metadata for timestamp
        let blockTimestamp = new Date();
        try {
          const block = await this.source.getBlock(log.blockNumber);
          if (block) {
            blockTimestamp = new Date(block.timestamp * 1000);
          }
        } catch {
          // Use current time as fallback
        }

        events.push({
          chainId: 'ethereum',
          network: 'ETHEREUM',
          asset: '', // resolved by token contract matching
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber,
          blockHash: log.blockHash,
          blockTimestamp,
          logIndex: log.logIndex,
          fromAddress,
          toAddress,
          amount,
          rawAmount: amount,
          tokenContract: log.address.toLowerCase(),
          decimals: 0, // resolved from asset_networks
          requiredConfirmations: 0, // resolved from asset_networks
          rawPayload: log.rawPayload,
        });
      }

      // Detect native ETH transfers to active deposit addresses on this network.
      // Errors MUST propagate to the batch handler so the checkpoint is
      // never advanced past a block whose address scan failed (RPC outage).
      const ethAddresses = await this.getActiveDepositAddresses();
      for (const addr of ethAddresses) {
        const txs = await this.source.getAddressTransactions(addr, fromBlock, toBlock);
        for (const tx of txs) {
          let blockTimestamp = new Date();
          try {
            const block = await this.source.getBlock(tx.blockNumber);
            if (block) {
              blockTimestamp = new Date(block.timestamp * 1000);
            }
          } catch {
            // Use current time as fallback
          }

          events.push({
            chainId: 'ethereum',
            network: 'ETHEREUM',
            asset: '', // resolved as ETH in validation
            transactionHash: tx.txHash,
            blockNumber: tx.blockNumber,
            blockHash: tx.blockHash,
            blockTimestamp,
            logIndex: tx.voutIndex,
            fromAddress: tx.from,
            toAddress: tx.to,
            amount: tx.value,
            rawAmount: tx.value,
            tokenContract: null,
            decimals: 0, // resolved from asset_networks
            requiredConfirmations: 0, // resolved from asset_networks
            rawPayload: tx.rawPayload,
          });
        }
      }
    } else if (this.network === 'BITCOIN') {
      // For Bitcoin, we scan all active deposit addresses
      const activeAddresses = await this.getActiveDepositAddresses();
      for (const addr of activeAddresses) {
        try {
          const txs = await this.source.getAddressTransactions(addr, fromBlock, toBlock);
          for (const tx of txs) {
            let blockTimestamp = new Date();
            try {
              const block = await this.source.getBlock(tx.blockNumber);
              if (block) {
                blockTimestamp = new Date(block.timestamp * 1000);
              }
            } catch {
              // Use current time as fallback
            }

            events.push({
              chainId: 'bitcoin',
              network: 'BITCOIN',
              asset: '', // resolved — only BTC is valid on BITCOIN network
              transactionHash: tx.txHash,
              blockNumber: tx.blockNumber,
              blockHash: tx.blockHash,
              blockTimestamp,
              logIndex: tx.voutIndex,
              fromAddress: tx.from,
              toAddress: tx.to,
              amount: tx.value,
              rawAmount: tx.value,
              tokenContract: null,
              decimals: 0, // resolved from asset_networks
              requiredConfirmations: 0, // resolved from asset_networks
              rawPayload: tx.rawPayload,
            });
          }
        } catch {
          // Skip individual address errors
        }
      }
    }

    return events;
  }

  // -------------------------------------------------------------------------
  // Event Validation
  // -------------------------------------------------------------------------

  private async validateEvent(
    event: BlockchainEvent,
    depositsEnabled: boolean,
  ): Promise<{ valid: boolean; status: BlockchainDepositStatus; rejection: MonitorRejection | null }> {
    // 1. Fetch asset_network row for this (asset, network)
    //    For ERC-20, we need to resolve asset by contract address
    //    For Bitcoin, only BTC is valid
    //    For native ETH, only ETH is valid

    try {
      let asset = '';
      let networkRow: any = null;

      if (this.network === 'ETHEREUM' && event.tokenContract) {
        // ERC-20: resolve asset by contract address
        const res = await this.database.query<any>(
          `SELECT asset, network, is_active AS "isActive", decimals, confirmations_required AS "confirmationsRequired",
                  contract_address AS "contractAddress", address_format AS "addressFormat"
           FROM asset_networks
           WHERE LOWER(contract_address) = LOWER($1) AND network = $2`,
          [event.tokenContract, 'ETHEREUM'],
        );
        networkRow = res.rows[0] ?? null;
        if (networkRow) {
          asset = networkRow.asset;
        }
      } else if (this.network === 'ETHEREUM' && !event.tokenContract) {
        // Native ETH: resolve by asset=ETH, network=ETHEREUM
        const res = await this.database.query<any>(
          `SELECT asset, network, is_active AS "isActive", decimals, confirmations_required AS "confirmationsRequired",
                  contract_address AS "contractAddress", address_format AS "addressFormat"
           FROM asset_networks
           WHERE asset = $1 AND network = $2`,
          ['ETH', this.network],
        );
        networkRow = res.rows[0] ?? null;
        if (networkRow) {
          asset = networkRow.asset;
        }
      } else if (this.network === 'BITCOIN') {
        const res = await this.database.query<any>(
          `SELECT asset, network, is_active AS "isActive", decimals, confirmations_required AS "confirmationsRequired",
                  contract_address AS "contractAddress", address_format AS "addressFormat"
           FROM asset_networks
           WHERE asset = $1 AND network = $2`,
          ['BTC', this.network],
        );
        networkRow = res.rows[0] ?? null;
        if (networkRow) {
          asset = networkRow.asset;
        }
      }

      // Asset/network must be known
      if (!networkRow) {
        return {
          valid: false,
          status: 'REJECTED',
          rejection: {
            reason: 'UNSUPPORTED_ASSET_NETWORK',
            detail: event.tokenContract
              ? `No asset_network found for contract ${event.tokenContract} on ${this.network}`
              : `No asset_network found for ${this.network} network`,
          },
        };
      }

      // Resolve event fields from the network row immediately, so that
      // rejected events (inactive network, unknown address, deposits halted)
      // are still persisted with a valid asset FK for the audit trail.
      event.asset = asset;
      event.decimals = networkRow.decimals;
      event.requiredConfirmations = networkRow.confirmationsRequired;
      event.amount = normalizeBlockchainAmount(event.rawAmount, networkRow.decimals);

      // Asset/network must be active
      if (!networkRow.isActive) {
        return {
          valid: false,
          status: 'REJECTED',
          rejection: {
            reason: 'INACTIVE_ASSET_NETWORK',
            detail: `${asset}/${this.network} is inactive`,
          },
        };
      }

      // Token contract check: if event has a token contract, it must match
      if (event.tokenContract && networkRow.contractAddress) {
        if (event.tokenContract.toLowerCase() !== networkRow.contractAddress.toLowerCase()) {
          return {
            valid: false,
            status: 'REJECTED',
            rejection: {
              reason: 'TOKEN_CONTRACT_MISMATCH',
              detail: `Event contract ${event.tokenContract} does not match ${networkRow.contractAddress} for ${asset}/${this.network}`,
            },
          };
        }
      }

      // Native/token consistency: if event has no tokenContract but networkRow has one (or vice versa)
      if (!event.tokenContract && networkRow.contractAddress) {
        // ERC-20 expected but native transfer received
        return {
          valid: false,
          status: 'REJECTED',
          rejection: {
            reason: 'EXPECTED_TOKEN_CONTRACT',
            detail: `${asset}/${this.network} requires token contract ${networkRow.contractAddress}, but event has no contract`,
          },
        };
      }
      if (event.tokenContract && !networkRow.contractAddress) {
        // Native expected but token received
        return {
          valid: false,
          status: 'REJECTED',
          rejection: {
            reason: 'EXPECTED_NATIVE',
            detail: `${asset}/${this.network} is native, but event has a token contract`,
          },
        };
      }

      // Validate destination address format
      if (!isValidContractAddress(event.toAddress, networkRow.addressFormat)) {
        return {
          valid: false,
          status: 'REJECTED',
          rejection: {
            reason: 'INVALID_ADDRESS_FORMAT',
            detail: `Address ${event.toAddress.slice(0, 12)}... does not match format ${networkRow.addressFormat}`,
          },
        };
      }

      // Match destination address against known deposit_addresses on this network (ACTIVE, ROTATED, or REVOKED).
      // Cryptographic identity is (user_id, network) — one CREATE2 forwarder can receive multiple supported assets.
      const addressMatches = await this.database.query<any>(
        `SELECT id, user_id AS "userId", asset, network, status
         FROM deposit_addresses
         WHERE LOWER(blockchain_address) = LOWER($1) AND network = $2 AND status IN ('ACTIVE', 'ROTATED', 'REVOKED')`,
        [event.toAddress, this.network],
      );

      if (addressMatches.rows.length === 0) {
        return {
          valid: false,
          status: 'REJECTED',
          rejection: {
            reason: 'UNKNOWN_DEPOSIT_ADDRESS',
            detail: `No known deposit_address found for ${event.toAddress.slice(0, 12)}... on ${this.network}`,
          },
        };
      }

      // Assert single ownership: all matching rows for this physical address MUST belong to the same user
      const userIds = new Set(addressMatches.rows.map((r: any) => r.userId || r.user_id));
      if (userIds.size > 1) {
        logger.error('CRITICAL: Multiple users associated with single blockchain address', {
          address: event.toAddress,
          network: this.network,
          userIds: Array.from(userIds),
        });
        return {
          valid: false,
          status: 'REJECTED',
          rejection: {
            reason: 'AMBIGUOUS_DEPOSIT_ADDRESS',
            detail: `Multiple users found for deposit address ${event.toAddress.slice(0, 12)}...`,
          },
        };
      }

      return { valid: true, status: 'DETECTED', rejection: null };
    } catch (err: any) {
      logger.error('BlockchainMonitor: validation error', {
        network: this.network,
        txHash: event.transactionHash,
        error: err.message,
      });
      return {
        valid: false,
        status: 'REJECTED',
        rejection: {
          reason: 'VALIDATION_ERROR',
          detail: err.message,
        },
      };
    }
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /**
   * Persist a normalized event to blockchain_deposits.
   * Uses ON CONFLICT DO NOTHING semantics (idempotent).
   */
  private async persistEvent(
    event: BlockchainEvent,
    status: BlockchainDepositStatus,
    rejection: MonitorRejection | null,
  ): Promise<void> {
    let eventType: 'NATIVE' | 'ERC20' | undefined = undefined;
    if (event.chainId === 'ethereum') {
      eventType = event.tokenContract ? 'ERC20' : 'NATIVE';
    }

    const id = computeBlockchainEventId(
      event.chainId,
      event.transactionHash,
      event.logIndex,
      eventType
    );

    const now = new Date();
    const detectedAt = now;
    const confirmedAt = status === 'CONFIRMED' ? now : null;
    const reorgedAt = status === 'REORGED' ? now : null;

    // Build raw_payload from event
    const rawPayload = event.rawPayload ?? {};

    try {
      await this.database.query(
        `INSERT INTO blockchain_deposits (
          id, chain_id, asset, network,
          transaction_hash, block_number, block_hash, block_timestamp,
          log_index, from_address, to_address,
          amount, raw_amount, token_contract, decimals,
          confirmation_count, required_confirmations,
          status, detected_at, confirmed_at, reorged_at,
          raw_payload, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11,
          $12, $13, $14, $15,
          $16, $17,
          $18, $19, $20, $21,
          $22, $23, $24
        ) ON CONFLICT (id) DO NOTHING`,
        [
          id,
          event.chainId,
          event.asset,
          event.network,
          event.transactionHash,
          event.blockNumber,
          event.blockHash,
          event.blockTimestamp,
          event.logIndex,
          event.fromAddress ?? null,
          event.toAddress,
          event.amount,
          event.rawAmount,
          event.tokenContract ?? null,
          event.decimals,
          0, // confirmation_count — initial
          event.requiredConfirmations,
          status,
          detectedAt,
          confirmedAt,
          reorgedAt,
          JSON.stringify(rawPayload),
          now,
          now,
        ],
      );
    } catch (err: any) {
      // ON CONFLICT DO NOTHING handles duplicates
      // Log unexpected errors
      if (err.code !== '23505') {
        logger.error('BlockchainMonitor: persist error', {
          id,
          network: this.network,
          txHash: event.transactionHash,
          error: err.message,
          code: err.code,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Reorg Detection & Handling
  // -------------------------------------------------------------------------

  /**
   * Detect if a reorg has occurred by checking the stored block hash
   * against the current chain state.
   * Returns the reorg depth (0 = no reorg).
   */
  private async detectReorg(blockNumber: number, expectedHash: string): Promise<number> {
    try {
      const block = await this.source.getBlock(blockNumber);
      if (!block) return 0;
      if (block.hash.toLowerCase() !== expectedHash.toLowerCase()) {
        // Reorg detected — find the depth
        const depth = REORG_DEPTH[this.network] ?? 6;
        logger.warn('BlockchainMonitor: reorg detected', {
          network: this.network,
          blockNumber,
          expectedHash: expectedHash.slice(0, 16),
          actualHash: block.hash.slice(0, 16),
          depth,
        });
        return depth;
      }
      return 0;
    } catch {
      return 0;
    }
  }

  /**
   * Handle a detected reorg: mark affected deposits as REORGED,
   * rewind checkpoint to safe depth.
   * Returns the number of deposits marked REORGED.
   */
  private async handleReorg(depth: number, lastBlockNumber: number): Promise<number> {
    const reorgFrom = Math.max(0, lastBlockNumber - depth);
    const reorgTo = lastBlockNumber;

    // Mark all deposits in the reorged block range as REORGED
    const affected = await this.database.query<any>(
      `SELECT * FROM blockchain_deposits
       WHERE network = $1 AND block_number BETWEEN $2 AND $3 AND status IN ('DETECTED', 'CONFIRMING', 'CONFIRMED')`,
      [this.network, reorgFrom, reorgTo],
    );

    const now = new Date();
    for (const row of affected.rows) {
      try {
        await this.database.query(
          `UPDATE blockchain_deposits
           SET status = 'REORGED', reorged_at = $1, updated_at = NOW()
           WHERE id = $2`,
          [now, row.id],
        );

        // If Phase 9.5 has already credited this deposit, alert administrators
        const isCredited = row.is_credited === true || row.is_credited === 'true';
        if (isCredited) {
          logger.error('CRITICAL: Credited deposit was reorged!', { id: row.id, network: this.network });
          if (this.threatAlertService) {
            try {
              await this.threatAlertService.createAlert({
                severity: 'CRITICAL',
                category: 'REORGED_CREDITED_DEPOSIT',
                title: `Reorg on Credited Deposit - ${this.network}`,
                description: `Deposit ${row.id} was reorged after being credited. Manual intervention required.`,
              });
            } catch {
              // Ignore failure to create alert
            }
          }
        }
      } catch (err: any) {
        logger.error('BlockchainMonitor: reorg update error', {
          id: row.id,
          error: err.message,
        });
      }
    }

    // Rewind checkpoint to the safe block before the reorg
    const safeBlock = reorgFrom > 0 ? reorgFrom - 1 : 0;
    await this.rewindCheckpoint(safeBlock);

    const reorgCount = affected.rows.length;
    logger.warn('BlockchainMonitor: reorg handled', {
      network: this.network,
      reorgFrom,
      reorgTo,
      safeBlock,
      depositsMarked: reorgCount,
    });

    return reorgCount;
  }

  // -------------------------------------------------------------------------
  // Checkpoint Management
  // -------------------------------------------------------------------------

  private async readCheckpoint(): Promise<{ lastBlockNumber: number; lastBlockHash: string | null } | null> {
    try {
      const res = await this.database.query<any>(
        `SELECT network, last_block_number AS "lastBlockNumber", last_block_hash AS "lastBlockHash",
                last_processed_at AS "lastProcessedAt", consecutive_errors AS "consecutiveErrors"
         FROM monitor_checkpoints WHERE network = $1`,
        [this.network],
      );
      if (res.rows.length === 0) return null;
      return {
        lastBlockNumber: res.rows[0].lastBlockNumber,
        lastBlockHash: res.rows[0].lastBlockHash ?? null,
      };
    } catch (err: any) {
      logger.error('BlockchainMonitor: failed to read checkpoint', {
        network: this.network,
        error: err.message,
      });
      return null;
    }
  }

  private async advanceCheckpoint(blockNumber: number): Promise<void> {
    // Get the block hash for the newly scanned block
    let blockHash: string | null = null;
    try {
      const block = await this.source.getBlock(blockNumber);
      if (block) blockHash = block.hash;
    } catch {
      // Continue without hash
    }

    const now = new Date();
    try {
      await this.database.query(
        `UPDATE monitor_checkpoints
         SET last_block_number = $1, last_block_hash = $2,
             last_processed_at = $3, consecutive_errors = 0
         WHERE network = $4`,
        [blockNumber, blockHash, now, this.network],
      );
    } catch (err: any) {
      logger.error('BlockchainMonitor: failed to advance checkpoint', {
        network: this.network,
        blockNumber,
        error: err.message,
      });
    }
  }

  private async updateCheckpointTimestamp(): Promise<void> {
    const now = new Date();
    try {
      await this.database.query(
        `UPDATE monitor_checkpoints
         SET last_processed_at = $1, consecutive_errors = 0
         WHERE network = $2`,
        [now, this.network],
      );
    } catch {
      // Non-critical
    }
  }

  private async rewindCheckpoint(blockNumber: number): Promise<void> {
    try {
      await this.database.query(
        `UPDATE monitor_checkpoints
         SET last_block_number = $1, last_block_hash = NULL,
             last_processed_at = NOW(), consecutive_errors = 0
         WHERE network = $2`,
        [blockNumber, this.network],
      );
    } catch (err: any) {
      logger.error('BlockchainMonitor: failed to rewind checkpoint', {
        network: this.network,
        blockNumber,
        error: err.message,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Block Hash Cache (for reorg detection across runs)
  // -------------------------------------------------------------------------

  private async updateRecentBlockHashes(fromBlock: number, toBlock: number): Promise<void> {
    for (let n = fromBlock; n <= toBlock; n++) {
      try {
        const block = await this.source.getBlock(n);
        if (block) {
          this.recentBlockHashes.set(n, block.hash);
        }
      } catch {
        // Skip
      }
    }
    // Prune old entries beyond reorg depth
    const maxDepth = REORG_DEPTH[this.network] ?? 6;
    for (const [num] of this.recentBlockHashes) {
      if (num < toBlock - maxDepth * 2) {
        this.recentBlockHashes.delete(num);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Parse a 20-byte EVM address from a hex-encoded topic (padded to 32 bytes).
   */
  private parseEvmAddress(topic: string): string | null {
    if (!topic || typeof topic !== 'string') return null;
    const cleaned = topic.replace(/^0x/, '');
    if (cleaned.length < 40) return null;
    return '0x' + cleaned.slice(-40).toLowerCase();
  }

  /**
   * Parse a uint256 value from hex-encoded log data.
   * Returns decimal string representation.
   */
  private parseEvmUint256(data: string): string | null {
    if (!data || typeof data !== 'string') return null;
    const cleaned = data.replace(/^0x/, '');
    if (!/^[0-9a-fA-F]+$/.test(cleaned)) return null;
    try {
      return BigInt('0x' + cleaned).toString(10);
    } catch {
      return null;
    }
  }

  /**
   * Get all active deposit addresses for this network, optionally filtered
   * by asset (used to distinguish native ETH detection from ERC-20 logs).
   */
  private async getActiveDepositAddresses(asset?: string): Promise<string[]> {
    if (asset) {
      const res = await this.database.query<any>(
        `SELECT DISTINCT blockchain_address AS "blockchainAddress"
         FROM deposit_addresses
         WHERE network = $1 AND asset = $2 AND status IN ('ACTIVE', 'ROTATED', 'REVOKED')`,
        [this.network, asset],
      );
      return res.rows.map((r: any) => r.blockchainAddress);
    }
    const res = await this.database.query<any>(
      `SELECT DISTINCT blockchain_address AS "blockchainAddress"
       FROM deposit_addresses
       WHERE network = $1 AND status IN ('ACTIVE', 'ROTATED', 'REVOKED')`,
      [this.network],
    );
    return res.rows.map((r: any) => r.blockchainAddress);
  }

  /**
   * Create a threat alert if consecutive errors exceed threshold.
   */
  private async maybeAlert(err: Error): Promise<void> {
    if (
      this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS &&
      this.consecutiveErrors - this.lastAlertedError >= 5
    ) {
      this.lastAlertedError = this.consecutiveErrors;
      logger.error('BlockchainMonitor: consecutive errors threshold exceeded', {
        network: this.network,
        consecutiveErrors: this.consecutiveErrors,
        error: err.message,
      });

      if (this.threatAlertService) {
        try {
          await this.threatAlertService.createAlert({
            severity: 'HIGH',
            category: 'BLOCKCHAIN_MONITOR_FAILURE',
            title: `Blockchain Monitor Failure — ${this.network}`,
            description: `${this.consecutiveErrors} consecutive errors on ${this.network}. Last error: ${err.message}`,
          });
        } catch {
          // Non-critical
        }
      }
    }
  }
}
