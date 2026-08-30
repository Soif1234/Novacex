import { CustodyService } from '../custody/custody.service';
import { TreasuryService } from './treasury.service';
import { SafeVerificationService } from './safe-verification.service';
import { logger } from '../../config/logger';
import { WithdrawalRequest } from '../custody/custody.types';
import { CustodyTransactionNotFoundError } from '../custody/custody.errors';
import crypto from 'crypto';
import { Decimal } from 'decimal.js';

/** A physical blockchain tx hash — the ONLY value allowed in tx_hash. */
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Map a custody status onto the treasury_transactions status domain
 * (PENDING, SIGNING, BROADCAST, CONFIRMED, FAILED, REORGED, RECONCILIATION_REQUIRED).
 */
function toTreasuryStatus(custodyStatus: string): string {
  switch (custodyStatus) {
    case 'CONFIRMED': return 'CONFIRMED';
    case 'FAILED':
    case 'REJECTED':
    case 'REVERSED': return 'FAILED';
    case 'SIGNING': return 'SIGNING';
    case 'BROADCAST': return 'BROADCAST';
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
    adminId: string
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

    const clientWithdrawalId = `treasury-${network}-${asset}-${crypto.randomUUID()}`;

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
        sourceAddress: 'KMS_HOT_WALLET',
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
        `INSERT INTO admin_audit_logs (admin_id, action, resource, details, ip_address, user_agent)
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
