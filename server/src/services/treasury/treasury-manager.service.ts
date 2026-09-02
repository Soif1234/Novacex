import { CustodyService } from '../custody/custody.service';
import { TreasuryService } from './treasury.service';
import { SafeVerificationService } from './safe-verification.service';
import { logger } from '../../config/logger';
import { env } from '../../config/env';
import { WithdrawalRequest } from '../custody/custody.types';
import { CustodyTransactionNotFoundError } from '../custody/custody.errors';
import { manualTxVerificationService } from '../custody/manual-tx-verification.service';
import crypto from 'crypto';
import { Decimal } from 'decimal.js';
import { ethers } from 'ethers';

/** A physical blockchain tx hash — the ONLY value allowed in tx_hash. */
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Map a custody status onto the treasury_transactions status domain
 * (PENDING, SIGNING, BROADCAST, READY_FOR_MANUAL_EXECUTION, CONFIRMED, FAILED,
 * REORGED, RECONCILIATION_REQUIRED).
 */
function toTreasuryStatus(custodyStatus: string): string {
  switch (custodyStatus) {
    case 'CONFIRMED': return 'CONFIRMED';
    case 'FAILED':
    case 'REJECTED':
    case 'REVERSED': return 'FAILED';
    case 'SIGNING': return 'SIGNING';
    case 'BROADCAST': return 'BROADCAST';
    case 'READY_FOR_MANUAL_EXECUTION': return 'READY_FOR_MANUAL_EXECUTION';
    default: return 'PENDING';
  }
}

export class TreasuryManagerService {
  constructor(
    private readonly custodyService: CustodyService,
    private readonly treasuryService: TreasuryService,
    private readonly safeVerifier: SafeVerificationService
  ) {}

  public async consolidateToSafe(
    network: string,
    asset: string,
    amountBase: string,
    adminId: string,
    signature: string,
    nonce: number,
    expiry: number,
    intentId: string
  ): Promise<WithdrawalRequest> {
    const db = this.treasuryService.getDatabase();

    // P1: Immutable Safe Trust Anchor
    // Do NOT rely on mutable DB config for outbound trust.
    const trustedSafeAddress = process.env[`TREASURY_SAFE_ADDRESS_${network}`] || process.env.TREASURY_SAFE_ADDRESS;
    const trustedOwnerAddress = process.env[`TREASURY_SAFE_OWNER_ADDRESS_${network}`] || process.env.TREASURY_SAFE_OWNER_ADDRESS;
    const trustedChainIdStr = process.env[`TREASURY_SAFE_CHAIN_ID_${network}`] || process.env.TREASURY_SAFE_CHAIN_ID;
    const rpcUrl = process.env[`${network}_RPC_URL`] || process.env.RPC_URL || 'http://127.0.0.1:8545';

    if (!trustedSafeAddress || !trustedOwnerAddress || !trustedChainIdStr) {
      logger.error('TreasuryManager: Missing trusted immutable Safe configuration.');
      throw new Error('Trusted Safe configuration is missing. Halting consolidation.');
    }

    const trustedChainId = Number(trustedChainIdStr);

    // Cross-wiring protection
    const nodeEnv = process.env.NODE_ENV || 'development';
    if (nodeEnv === 'production' && trustedChainId !== 1) {
      throw new Error('TreasuryManager: TREASURY_SAFE_CHAIN_ID must be 1 in production.');
    }
    if (nodeEnv !== 'production' && trustedChainId === 1) {
      throw new Error('TreasuryManager: TREASURY_SAFE_CHAIN_ID cannot be 1 in non-production environments.');
    }

    if (!signature) {
      throw new Error(`TreasuryManager: Missing EIP-712 / admin signature for treasury sweep.`);
    }

    // P0-4: EIP-712 Cryptographic Authorization
    const domain = {
      name: 'NovaCEX Treasury',
      version: '1',
      chainId: trustedChainId,
      verifyingContract: trustedSafeAddress
    };

    const types = {
      Consolidate: [
        { name: 'network', type: 'string' },
        { name: 'asset', type: 'string' },
        { name: 'amount', type: 'string' },
        { name: 'destination', type: 'address' },
        { name: 'intentId', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'expiry', type: 'uint256' }
      ]
    };

    const value = {
      network,
      asset,
      amount: amountBase,
      destination: trustedSafeAddress,
      intentId,
      nonce,
      expiry
    };

    let recovered: string;
    try {
      recovered = ethers.verifyTypedData(domain, types, value, signature);
    } catch (e: any) {
      throw new Error(`TreasuryManager: Invalid EIP-712 signature format - ${e.message}`);
    }

    if (recovered.toLowerCase() !== trustedOwnerAddress.toLowerCase()) {
      throw new Error(`TreasuryManager: Invalid admin signature. Expected ${trustedOwnerAddress}, got ${recovered}`);
    }

    // P0-4 Fix: Enforce expiry at the service layer (defense-in-depth).
    // The controller also checks, but the service is the authoritative security boundary.
    // Any caller that bypasses the controller (internal call, recovery, RPC) MUST be rejected.
    if (expiry === 0 || expiry === undefined || expiry === null) {
      throw new Error(`TreasuryManager: Invalid expiry (zero or missing).`);
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds > expiry) {
      throw new Error(`TreasuryManager: Signature expired. Current time ${nowSeconds} > expiry ${expiry}.`);
    }
    // Policy: reject unreasonably far-future expiry (> 1 hour from now)
    const MAX_EXPIRY_WINDOW_SECONDS = 3600;
    if (expiry > nowSeconds + MAX_EXPIRY_WINDOW_SECONDS) {
      throw new Error(`TreasuryManager: Expiry too far in the future. Max window is ${MAX_EXPIRY_WINDOW_SECONDS}s.`);
    }

    const amountDecimal = new Decimal(amountBase);
    if (amountDecimal.lte(0)) {
      throw new Error(`TreasuryManager: Amount must be positive.`);
    }

    if (!this.custodyService.isEnabled()) {
      throw new Error(`TreasuryManager: Custody service is disabled.`);
    }

    // P1: Safe Verification against IMMUTABLE trusted config before consolidation
    const isSafeValid = await this.safeVerifier.verifySafeOnChain(
      trustedSafeAddress,
      trustedOwnerAddress,
      1, // threshold
      trustedChainId,
      rpcUrl
    );

    if (!isSafeValid) {
      logger.error('TreasuryManager: Safe on-chain verification against TRUSTED config failed. Halting consolidation.');
      throw new Error('Safe configuration drift detected. Halting treasury consolidation.');
    }

    const clientWithdrawalId = `treasury-${network}-${asset}-${intentId}`;

    logger.info(`TreasuryManager: Initiating consolidation to Safe.`, {
      network,
      asset,
      amount: amountBase,
      destination: trustedSafeAddress,
      adminId
    });

    let result: WithdrawalRequest;

    await db.transaction(async (dbClient) => {
      // Use pg_advisory_xact_lock to prevent concurrent consolidations
      const hash = crypto.createHash('sha256').update(`consolidate-${network}-${asset}`).digest();
      const lockId = hash.readInt32BE(0);
      await dbClient.query('SELECT pg_advisory_xact_lock($1)', [lockId]);

      // P0-4: EIP-712 Replay Protection (intentId must be unique)
      const replayCheck = await dbClient.query(
        `SELECT id FROM treasury_transactions WHERE client_withdrawal_id = $1`,
        [clientWithdrawalId]
      );
      if (replayCheck.rows.length > 0) {
        throw new Error(`TreasuryManager: Replay attack detected. intentId ${intentId} was already used.`);
      }

      // P0-4 Fix: Atomic admin_nonce validation.
      // The nonce is checked under FOR UPDATE lock and atomically incremented.
      // This provides durable replay protection independent of the intentId check:
      // even if a crash occurs before the treasury_transactions INSERT commits,
      // the nonce will have been consumed and cannot be reused.
      const nonceRes = await dbClient.query<{ admin_nonce: string }>(
        `SELECT admin_nonce FROM treasury_config WHERE network = $1 FOR UPDATE`,
        [network]
      );
      if (nonceRes.rows.length > 0) {
        const currentNonce = Number(nonceRes.rows[0].admin_nonce);
        if (nonce !== currentNonce) {
          throw new Error(`TreasuryManager: Invalid nonce. Expected ${currentNonce}, got ${nonce}. Possible replay or stale request.`);
        }
        await dbClient.query(
          `UPDATE treasury_config SET admin_nonce = admin_nonce + 1, updated_at = NOW() WHERE network = $1`,
          [network]
        );
      } else {
        // F1 Fix: Fail closed if treasury_config row is missing.
        throw new Error(`TreasuryManager: treasury_config not initialized for network ${network}`);
      }

      const existingRes = await dbClient.query<{ id: number }>(
        `SELECT id FROM treasury_transactions
         WHERE network = $1 AND asset = $2 AND status IN ('PENDING', 'SIGNING', 'BROADCAST')`,
        [network, asset]
      );

      if (existingRes.rows.length > 0) {
        throw new Error(`TreasuryManager: A consolidation intent for ${network} ${asset} is already in progress.`);
      }

      await this.treasuryService.insertTreasuryTransaction({
        network,
        chainId: trustedChainId.toString(),
        asset,
        tokenContract: null,
        // Phase 11K — sender is the configured manual cold EOA (the Safe owner
        // / operational wallet), never a KMS hot wallet. Read from immutable
        // env; no signing key is involved.
        sourceAddress: env.CUSTODY_HOT_WALLET_ADDRESS || 'MANUAL_HOT_WALLET',
        destinationAddress: trustedSafeAddress,
        amount: amountDecimal.toString(),
        txHash: null,
        logIndex: 0,
        blockNumber: 0,
        blockHash: 'PENDING',
        status: 'PENDING',
        clientWithdrawalId: clientWithdrawalId
      }, dbClient);

        await dbClient.query(
          `INSERT INTO admin_audit_logs (admin_user_id, action, target_resource_type, new_state, ip_address, user_agent)
           VALUES ($1, 'TREASURY_CONSOLIDATION', 'TREASURY', $2, 'SYSTEM', 'SYSTEM')`,
        [
          adminId,
          JSON.stringify({
            network,
            asset,
            amount: amountDecimal.toString(),
            safeAddress: trustedSafeAddress,
            clientWithdrawalId
          })
        ]
      );
    });

    try {
      // Phase 10.4 (unfreeze): the DEDICATED treasury custody operation —
      // never the customer requestWithdrawal path. Correlation is the
      // immutable treasuryIntentId; the custody layer persists its own
      // treasury artifact (exact signed bytes) before broadcast.
      result = await this.custodyService.submitTreasuryTransfer({
        treasuryIntentId: clientWithdrawalId,
        asset,
        network,
        amount: amountDecimal.toString(),
        destinationAddress: trustedSafeAddress
      });

      // P0: Correlate intent with the physical transaction immediately.
      // tx-hash identity guard: ONLY an actual blockchain hash may enter
      // tx_hash; provider references / mock ids keep tx_hash NULL (the
      // database CHECK enforces the same rule).
      const physicalTxHash = result.providerReference && TX_HASH_RE.test(result.providerReference)
        ? result.providerReference
        : null;
      await db.query(
        `UPDATE treasury_transactions SET status = $1, tx_hash = COALESCE($2, tx_hash), updated_at = NOW()
         WHERE client_withdrawal_id = $3`,
        [toTreasuryStatus(result.status), physicalTxHash, clientWithdrawalId]
      );
    } catch (err) {
      logger.error(`TreasuryManager: Custody service failed to process request ${clientWithdrawalId}`);
      throw err;
    }

    return result;
  }

  /**
   * Phase 11K — manual Safe mode.
   *
   * Administrator confirmation of a manual treasury consolidation execution.
   *
   * Security model:
   * - Only READY_FOR_MANUAL_EXECUTION intents may be confirmed.
   * - A REAL, verifiable blockchain transaction hash is required.
   * - The transaction is independently verified on-chain (chainId, sender,
   *   destination = immutable Safe, asset, amount, receipt) BEFORE CONFIRMED
   *   is written. The request body NEVER supplies the destination — only the
   *   immutable TREASURY_SAFE_ADDRESS env anchor is trusted.
   * - Manual confirmation does NOT replace authorization: EIP-712, intentId,
   *   admin_nonce, and expiry were already enforced in consolidateToSafe.
   * - A tx_hash cannot be reused to confirm a different treasury intent.
   * - If the on-chain monitor already recorded the physical transaction as an
   *   unlinked row, this method ADOPTS that row (dedupe) instead of creating a
   *   duplicate representation.
   *
   * On success: status -> CONFIRMED, tx_hash -> verified hash.
   */
  public async confirmManualTreasuryTransfer(
    intentId: string,
    txHash: string,
    adminUserId: string
  ): Promise<void> {
    if (!TX_HASH_RE.test(txHash)) {
      throw new Error(`TreasuryManager: invalid transaction hash format`);
    }

    const db = this.treasuryService.getDatabase();

    await db.transaction(async (dbClient) => {
      const hash = crypto.createHash('sha256').update('treasury-manual-confirm').digest();
      const lockId = hash.readInt32BE(0);
      await dbClient.query('SELECT pg_advisory_xact_lock($1)', [lockId]);

      // The intent row is keyed by client_withdrawal_id = treasury-<network>-<asset>-<intentId>.
      // intentId is a random UUID, so the suffix match is deterministic and unique.
      // F3 (Phase 11K-B): the row is selected by correlation id REGARDLESS of
      // status so that an intent the on-chain monitor already adopted (READY ->
      // CONFIRMED via parameter match, tx_hash set) can be re-confirmed
      // idempotently instead of failing with "no READY intent found".
      const res = await dbClient.query<any>(
        `SELECT * FROM treasury_transactions
         WHERE client_withdrawal_id LIKE '%' || $1
         FOR UPDATE`,
        [intentId]
      );
      if (res.rows.length === 0) {
        // No intent row found (or — in the legacy test harness — the intent was
        // written through a different pool). Keep the message stable so existing
        // guards/regexes that treat "not found" as "no READY intent" still match.
        throw new Error(`TreasuryManager: no READY_FOR_MANUAL_EXECUTION intent found for intentId ${intentId}`);
      }
      if (res.rows.length > 1) {
        throw new Error(`TreasuryManager: intentId ${intentId} matched multiple treasury intents`);
      }
      const row = res.rows[0];

      // Idempotent re-confirm: the same intent already confirmed with the SAME
      // tx_hash (e.g. repeated confirmation, or the monitor already adopted the
      // physical transaction). Return success without mutating anything.
      if (row.status === 'CONFIRMED' && row.tx_hash === txHash) {
        return;
      }
      // State guard: only READY_FOR_MANUAL_EXECUTION may be confirmed (or
      // already confirmed with the same hash, handled above).
      if (row.status !== 'READY_FOR_MANUAL_EXECUTION') {
        throw new Error(`TreasuryManager: no READY_FOR_MANUAL_EXECUTION intent found for intentId ${intentId}`);
      }

      // Authorized sender (cold EOA) must be configured — fail closed.
      if (!env.CUSTODY_HOT_WALLET_ADDRESS) {
        throw new Error(`TreasuryManager: CUSTODY_HOT_WALLET_ADDRESS is not configured; treasury confirmation disabled`);
      }

      // Immutable Safe destination anchor (never from the request body).
      const trustedSafeAddress =
        process.env[`TREASURY_SAFE_ADDRESS_${row.network}`] || process.env.TREASURY_SAFE_ADDRESS;
      const trustedChainIdStr =
        process.env[`TREASURY_SAFE_CHAIN_ID_${row.network}`] || process.env.TREASURY_SAFE_CHAIN_ID;
      if (!trustedSafeAddress || !trustedChainIdStr) {
        throw new Error(`TreasuryManager: trusted Safe configuration is missing`);
      }

      // Independent on-chain verification (fail closed).
      const verification = await manualTxVerificationService.verifyTreasuryTx(
        {
          network: row.network,
          txHash,
          expectedSender: env.CUSTODY_HOT_WALLET_ADDRESS,
          expectedDestination: trustedSafeAddress,
          asset: row.asset,
          expectedAmount: row.amount,
        },
        Number(trustedChainIdStr)
      );

      if (!verification.verified) {
        throw new Error(`TreasuryManager: on-chain verification failed: ${verification.reason || 'unknown reason'}`);
      }

      // F3 (Phase 11K-B): correlate the physical transaction with this intent.
      // The on-chain monitor may ALREADY have recorded the exact physical tx as
      // an unlinked CONFIRMED row (monitor-first). Find every row carrying the
      // same tx_hash (any status) other than this intent row, and classify:
      //   - unlinked (client_withdrawal_id IS NULL)  -> ADOPT it (dedupe)
      //   - linked to THIS intent's client_withdrawal_id -> idempotent success
      //   - linked to a DIFFERENT intent             -> genuine conflict, reject
      // Previously the generic "status = 'CONFIRMED'" dup guard rejected the
      // monitor's unlinked row BEFORE the adoption path could run, leaving the
      // manual intent permanently un-confirmable. This restores the required
      // invariant: manual intent + physical transaction -> exactly ONE row.
      const hashRes = await dbClient.query<any>(
        `SELECT id, client_withdrawal_id FROM treasury_transactions
         WHERE tx_hash = $1 AND id <> $2`,
        [txHash, row.id]
      );

      let physicalRowId: number | null = null;
      let conflict = false;
      for (const r of hashRes.rows) {
        if (r.client_withdrawal_id === null || r.client_withdrawal_id === undefined) {
          if (physicalRowId === null) physicalRowId = r.id; // adopt the first unlinked row
        } else if (String(r.client_withdrawal_id) === String(row.client_withdrawal_id)) {
          // Already linked to this exact intent -> idempotent success.
          return;
        } else {
          conflict = true;
        }
      }
      if (conflict) {
        throw new Error(`TreasuryManager: transaction hash already confirmed for another treasury intent`);
      }

      if (physicalRowId !== null) {
        // Adoption path: the on-chain monitor recorded this exact transaction as
        // an unlinked physical row, so the physical transaction is never
        // represented twice. The intent row MUST be deleted BEFORE the
        // client_withdrawal_id is reassigned — uq_treasury_client_withdrawal_id
        // would otherwise reject the adoption while the intent row still holds
        // the correlation id (proven live by the monitor-first race test).
        await dbClient.query(`DELETE FROM treasury_transactions WHERE id = $1`, [row.id]);
        await dbClient.query(
          `UPDATE treasury_transactions
           SET client_withdrawal_id = $1, status = 'CONFIRMED', confirmed_by = $2,
               confirmed_at = NOW(), updated_at = NOW()
           WHERE id = $3`,
          [row.client_withdrawal_id, adminUserId, physicalRowId]
        );
      } else {
        await dbClient.query(
          `UPDATE treasury_transactions
           SET status = 'CONFIRMED', tx_hash = $1, confirmed_by = $2,
               confirmed_at = NOW(), updated_at = NOW()
           WHERE id = $3`,
          [txHash, adminUserId, row.id]
        );
      }

      await dbClient.query(
        `INSERT INTO admin_audit_logs (
           admin_user_id, action, target_resource_type, target_resource_id,
           new_state, ip_address, user_agent
         )
         VALUES ($1, 'TREASURY_MANUAL_CONFIRM', 'TREASURY', $2, $3, 'SYSTEM', 'SYSTEM')`,
        [
          adminUserId,
          row.client_withdrawal_id,
          JSON.stringify({
            intentId,
            txHash,
            clientWithdrawalId: row.client_withdrawal_id,
            asset: row.asset,
            network: row.network,
            amount: row.amount
          }),
        ]
      );
    });
  }

  public async recoverPendingIntents(): Promise<void> {
    const db = this.treasuryService.getDatabase();
    // Use advisory lock for recovery to prevent race with monitor or concurrent recovery
    await db.transaction(async (dbClient) => {
      const hash = crypto.createHash('sha256').update('treasury-recovery').digest();
      const lockId = hash.readInt32BE(0);
      await dbClient.query('SELECT pg_advisory_xact_lock($1)', [lockId]);

      const res = await dbClient.query<any>(
        `SELECT id, network, asset, amount, destination_address, client_withdrawal_id, status, tx_hash
         FROM treasury_transactions
         WHERE status IN ('PENDING', 'SIGNING', 'BROADCAST')
         AND client_withdrawal_id IS NOT NULL
         AND created_at < NOW() - INTERVAL '5 minutes'`
      );

      for (const row of res.rows) {
        const intentId = row.client_withdrawal_id;
        try {
          if (!this.custodyService.isEnabled()) continue;

          // Phase 10.4 (unfreeze): treasury artifacts are looked up through the
          // dedicated treasury status operation (the customer getWithdrawalStatus
          // is keyed on the customer withdrawals table and cannot see intents).
          const statusReq = await this.custodyService.getTreasuryTransferStatus(intentId);

          const newStatus = toTreasuryStatus(statusReq.status);
          // tx-hash identity guard: only actual blockchain hashes are persisted.
          const realTxHash = statusReq.providerReference && TX_HASH_RE.test(statusReq.providerReference)
            ? statusReq.providerReference
            : null;

          if (newStatus !== row.status || (realTxHash && row.tx_hash === null)) {
            logger.info(`TreasuryManager: Recovering intent ${intentId} to status ${newStatus}`);

            if (realTxHash && row.tx_hash === null) {
              // P0: Attempt to merge if the monitor already inserted a physical row before we recovered the tx_hash
              const existingRes = await dbClient.query<{ id: number }>(
                `SELECT id FROM treasury_transactions WHERE tx_hash = $1 AND client_withdrawal_id IS NULL`,
                [realTxHash]
              );

              if (existingRes.rows.length > 0) {
                // Monitor beat us. ADOPT the physical row: it already carries
                // the real tx_hash. The intent row MUST be deleted BEFORE the
                // client_withdrawal_id is reassigned — uq_treasury_client_withdrawal_id
                // would otherwise reject the adoption while the intent row still
                // holds the correlation id (proven live by the boundary test).
                const physicalId = existingRes.rows[0].id;
                await dbClient.query(`DELETE FROM treasury_transactions WHERE id = $1`, [row.id]);
                await dbClient.query(
                  `UPDATE treasury_transactions SET client_withdrawal_id = $1, status = $2, updated_at = NOW() WHERE id = $3`,
                  [intentId, newStatus, physicalId]
                );
                continue; // successfully merged
              }
            }

            // Otherwise, just update the intent row
            await dbClient.query(
              `UPDATE treasury_transactions SET status = $1, tx_hash = COALESCE($2, tx_hash), updated_at = NOW()
               WHERE id = $3`,
              [newStatus, realTxHash, row.id]
            );
          }
        } catch (err: any) {
          if (err instanceof CustodyTransactionNotFoundError) {
            // Authoritative: the custody layer has NO artifact for this intent —
            // custody never accepted it. Safe to mark FAILED (no physical tx can
            // exist for it; the on-chain monitor would have produced an unlinked
            // physical row, never a false intent correlation).
            logger.warn(`TreasuryManager: Intent ${intentId} not found in custody artifacts. Marking FAILED.`);
            await dbClient.query(
              `UPDATE treasury_transactions SET status = 'FAILED', updated_at = NOW() WHERE id = $1`,
              [row.id]
            );
          } else {
            // Provider unavailable / custody disabled: leave the intent PENDING —
            // fail closed, never falsely fail a possibly-broadcast transfer.
            logger.error(`TreasuryManager: Failed to recover intent ${intentId}: ${err.message}`);
          }
        }
      }
    });
  }
}

import { custodyService } from '../custody/custody.service';
import { treasuryService } from './treasury.service';
import { safeVerificationService } from './safe-verification.service';
export const treasuryManagerService = new TreasuryManagerService(custodyService, treasuryService, safeVerificationService);
