import crypto from 'crypto';
import { db, IDatabaseConnection } from '../../config/database';
import { AccountType } from '../../models/account.model';
import { WithdrawalEntity } from '../../models/ledger.model';
import { ledgerService, LedgerService } from '../ledger/ledger.service';
import { amlService, AmlService } from '../compliance/aml.service';
import { withdrawalPolicyService } from './withdrawal-policy.service';
import { auditService } from '../admin/audit.service';
import { RecordAuditLogDto } from '../../models/admin.model';
import { validateAmount, decimalNormalize, decimalAdd, decimalCompare, decimalIsPositive } from '../ledger/decimal';
import { logger } from '../../config/logger';
import { env } from '../../config/env';
import { AppError } from '../../middleware/errorHandler';
import { custodyService } from '../custody/custody.service';
import { CustodyTransactionNotFoundError } from '../custody/custody.errors';
import { manualTxVerificationService } from '../custody/manual-tx-verification.service';
import { eventBus } from '../market/event-bus';
import { NotificationEventType, WithdrawalNotificationEvent } from '../notification/notification.types';

export type WithdrawalResolutionDirective = 'FAILED' | 'COMPLETED';

/** A physical blockchain tx hash — the ONLY value accepted for confirmation. */
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export interface CryptoWithdrawDto {
  userId: string;
  asset: string;
  network: string;
  amount: string;
  destinationAddress: string;
  destinationMemo?: string;
  referenceId: string;
}

export class WithdrawalService {
  constructor(
    private database: IDatabaseConnection = db,
    private ledger: LedgerService = ledgerService,
    private aml: AmlService = amlService
  ) {}

  public async cryptoWithdraw(dto: CryptoWithdrawDto): Promise<WithdrawalEntity> {
    const { userId, asset, network, amount, destinationAddress, destinationMemo, referenceId } = dto;
    validateAmount(amount);

    const withdrawal = await this.database.transaction(async (txClient) => {
      // 0. Serialize concurrent withdrawals per user: lock the user row BEFORE the
      //    AML aggregate is read so two simultaneous requests cannot both observe
      //    the same pre-transaction 24h usage and collectively exceed the limit.
      const userLockRes = await txClient.query<any>(
        'SELECT id FROM users WHERE id = $1 FOR UPDATE',
        [userId]
      );
      if (userLockRes.rows.length === 0) {
        throw new AppError('User not found', 404, 'NOT_FOUND');
      }

      // 1. Fetch FUNDING account
      const accRes = await txClient.query<any>(
        'SELECT id, type FROM accounts WHERE user_id = $1 AND type = $2',
        [userId, 'FUNDING']
      );
      if (accRes.rows.length === 0) {
        throw new AppError('FUNDING account not found for user', 404, 'ACCOUNT_NOT_FOUND');
      }
      const accountId = accRes.rows[0].id;

      // 2. Validate asset and network
      const netRes = await txClient.query<any>(
        'SELECT * FROM asset_networks WHERE asset = $1 AND network = $2',
        [asset, network]
      );
      if (netRes.rows.length === 0) {
        throw new AppError(`Asset ${asset} on network ${network} is not supported`, 400, 'UNSUPPORTED_ASSET_NETWORK');
      }
      const networkConfig = netRes.rows[0];
      const isActive = networkConfig.is_active ?? networkConfig.isActive;
      if (!isActive) {
        throw new AppError(`Network ${network} is currently inactive`, 400, 'NETWORK_INACTIVE');
      }

      const minWithdrawal = networkConfig.min_withdrawal ?? networkConfig.minWithdrawal ?? '0';
      const withdrawalFee = networkConfig.withdrawal_fee ?? networkConfig.withdrawalFee ?? '0';
      const requiresMemo = networkConfig.requires_memo ?? networkConfig.requiresMemo ?? false;
      const addressFormat = networkConfig.address_format ?? networkConfig.addressFormat ?? 'EVM_HEX';

      if (requiresMemo && !destinationMemo) {
        throw new AppError(`Destination memo is required for ${network}`, 400, 'MISSING_MEMO');
      }

      if (decimalCompare(amount, String(minWithdrawal)) < 0) {
        throw new AppError(`Withdrawal amount is below minimum of ${minWithdrawal}`, 400, 'BELOW_MINIMUM');
      }

      const totalDeduction = decimalAdd(amount, withdrawalFee);

      // 3. Evaluate risk policy INSIDE the transaction, after the user row is locked,
      //    with the real account ID (closes the policy TOCTOU window).
      const policyResult = await withdrawalPolicyService.evaluate(userId, accountId, asset, network, amount, destinationAddress);
      const initialCryptoStatus = policyResult.decision === 'APPROVE' ? 'APPROVED' : 'PENDING_REVIEW';
      const reviewReason = policyResult.reasons.length > 0 ? policyResult.reasons.join(' | ') : null;

      // 4. AML Checks — pass txClient so the 24h aggregation runs on this
      //    transaction's connection, aligned with the user row lock above.
      await this.aml.validateWithdrawalCompliance({
        userId,
        asset,
        amount,
        destinationAddress
      }, txClient);

      // 5. Reserve funds using WITHDRAWAL (counts towards AML instantly)
      const ledgerTxId = await this.ledger.postTransaction({
        accountId,
        transactionType: 'WITHDRAWAL',
        referenceId: `wd_res_${referenceId}`,
        description: `Crypto withdrawal reservation ${asset}`,
        entries: [
          { accountId, asset, direction: 'DEBIT', amount: totalDeduction, balancePool: 'available' },
          { accountId, asset, direction: 'CREDIT', amount: totalDeduction, balancePool: 'locked' }
        ],
        metadata: { userId, destinationAddress, network, amount, fee: withdrawalFee }
      }, txClient);

      // 6. Create withdrawal record
      const withdrawalId = crypto.randomUUID();
      const insertRes = await txClient.query<any>(`
        INSERT INTO withdrawals (
          id, account_id, asset, network, amount, fee, status, crypto_status,
          destination_address, destination_memo, ledger_tx_id, created_at, updated_at, review_reason
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW(), $12
        ) RETURNING *
      `, [
        withdrawalId, accountId, asset, network, amount, withdrawalFee,
        'PENDING', initialCryptoStatus, destinationAddress, destinationMemo || null, ledgerTxId.transactionId, reviewReason
      ]);

      const row = insertRes.rows[0];
      return {
        id: row.id,
        accountId: row.account_id,
        asset: row.asset,
        network: row.network,
        amount: row.amount,
        fee: row.fee,
        status: row.status,
        cryptoStatus: row.crypto_status,
        destinationAddress: row.destination_address,
        destinationMemo: row.destination_memo,
        ledgerTxId: row.ledger_tx_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    });

    const uRes = await this.database.query<any>('SELECT email FROM users WHERE id = $1', [userId]);
    if (uRes.rows.length > 0) {
      const eventType = withdrawal.cryptoStatus === 'PENDING_REVIEW' ? NotificationEventType.WITHDRAWAL_PENDING_REVIEW : NotificationEventType.WITHDRAWAL_REQUESTED;
      eventBus.publish({
        id: "", timestamp: Date.now(), version: "1.0.0", type: eventType,
        payload: {
          userId,
          email: uRes.rows[0].email,
          withdrawalId: withdrawal.id,
          asset,
          amount,
          network
        }
      });
    }

    return withdrawal;
  }

  public async approveWithdrawal(withdrawalId: string): Promise<void> {
    const approved = await this.database.transaction(async (txClient) => {
      const wRes = await txClient.query<any>(
        'SELECT status, crypto_status FROM withdrawals WHERE id = $1 FOR UPDATE',
        [withdrawalId]
      );
      if (wRes.rows.length === 0) throw new AppError('Withdrawal not found', 404, 'NOT_FOUND');

      const w = wRes.rows[0];
      if (w.status !== 'PENDING' || (w.crypto_status !== 'PENDING' && w.crypto_status !== 'RESERVED')) {
        throw new AppError('Withdrawal is not pending approval', 400, 'INVALID_STATE');
      }

      await txClient.query(
        "UPDATE withdrawals SET crypto_status = 'APPROVED', updated_at = NOW() WHERE id = $1",
        [withdrawalId]
      );
    });
  }

  public async getWithdrawalsPendingReview(limit = 100): Promise<any[]> {
    const res = await this.database.query<any>(
      `SELECT w.id, w.asset, w.network, w.amount, w.fee, w.destination_address as "destinationAddress", w.destination_memo as "destinationMemo", w.created_at as "createdAt", w.review_reason as "reviewReason", a.user_id as "userId", w.crypto_status as "cryptoStatus", w.status
       FROM withdrawals w
       JOIN accounts a ON w.account_id = a.id
       WHERE w.crypto_status IN ('PENDING_REVIEW', 'READY_FOR_MANUAL_EXECUTION', 'UNKNOWN')
       ORDER BY w.created_at ASC
       LIMIT $1`,
      [limit]
    );
    return res.rows;
  }

  public async approveWithdrawalAdmin(withdrawalId: string, adminUserId: string, reviewReason?: string, audit?: RecordAuditLogDto): Promise<void> {
    const approved = await this.database.transaction(async (txClient) => {
      const wRes = await txClient.query<any>(
        `SELECT w.*, a.user_id
         FROM withdrawals w
         JOIN accounts a ON w.account_id = a.id
         WHERE w.id = $1 FOR UPDATE`,
        [withdrawalId]
      );
      if (wRes.rows.length === 0) throw new AppError('Withdrawal not found', 404, 'NOT_FOUND');

      const w = wRes.rows[0];
      if (w.user_id === adminUserId) {
        throw new AppError('Administrators cannot approve their own withdrawals', 403, 'FORBIDDEN_SELF_APPROVAL');
      }

      if (w.status !== 'PENDING' || w.crypto_status !== 'PENDING_REVIEW') {
        throw new AppError('Withdrawal is not pending review', 400, 'INVALID_STATE');
      }

      await txClient.query(
        `UPDATE withdrawals
         SET crypto_status = 'APPROVED', reviewed_by = $1, reviewed_at = NOW(), review_reason = COALESCE($2, review_reason), updated_at = NOW()
         WHERE id = $3`,
        [adminUserId, reviewReason || null, withdrawalId]
      );

      // Record audit INSIDE the same transaction for atomicity.
      // If the audit INSERT fails, the whole transaction rolls back.
      if (audit) {
        await auditService.record(audit, txClient);
      }
    });
  }

  public async rejectWithdrawalAdmin(withdrawalId: string, adminUserId: string, reviewReason: string, audit?: RecordAuditLogDto): Promise<void> {
    const rejected = await this.database.transaction(async (txClient) => {
      const wRes = await txClient.query<any>(
        `SELECT w.*, a.user_id
         FROM withdrawals w
         JOIN accounts a ON w.account_id = a.id
         WHERE w.id = $1 FOR UPDATE`,
        [withdrawalId]
      );
      if (wRes.rows.length === 0) throw new AppError('Withdrawal not found', 404, 'NOT_FOUND');

      const w = wRes.rows[0];
      if (w.user_id === adminUserId) {
        throw new AppError('Administrators cannot reject their own withdrawals', 403, 'FORBIDDEN_SELF_ACTION');
      }

      if (w.status !== 'PENDING' || w.crypto_status !== 'PENDING_REVIEW') {
        throw new AppError('Withdrawal is not pending review', 400, 'INVALID_STATE');
      }

      const totalDeduction = decimalAdd(w.amount, w.fee);

      // Release funds back to available
      await this.ledger.postTransaction({
        accountId: w.account_id,
        transactionType: 'ADJUSTMENT',
        referenceId: `wd_rel_${w.id}`,
        description: `Release rejected crypto withdrawal ${w.asset}`,
        entries: [
          { accountId: w.account_id, asset: w.asset, direction: 'DEBIT', amount: totalDeduction, balancePool: 'locked' },
          { accountId: w.account_id, asset: w.asset, direction: 'CREDIT', amount: totalDeduction, balancePool: 'available' }
        ]
      }, txClient);

      await txClient.query(
        `UPDATE withdrawals
         SET status = 'REJECTED', crypto_status = 'CANCELLED', review_reason = $1, reviewed_by = $2, reviewed_at = NOW(), failure_reason = 'Rejected by administrator', updated_at = NOW()
         WHERE id = $3`,
        [reviewReason, adminUserId, withdrawalId]
      );

      // Record audit INSIDE the same transaction for atomicity.
      // If the audit INSERT fails, the whole transaction rolls back.
      if (audit) {
        await auditService.record(audit, txClient);
      }
    });
  }

  public async getApprovedWithdrawals(limit: number): Promise<WithdrawalEntity[]> {
    const res = await this.database.query<any>(
      `SELECT * FROM withdrawals WHERE status = 'PENDING' AND crypto_status = 'APPROVED' ORDER BY created_at ASC LIMIT $1`,
      [limit]
    );
    return res.rows.map(this.mapEntity);
  }


  public async replaceWithdrawal(id: string, adminUserId: string, gasPolicy: any): Promise<any> {
    const { custodyService } = await import('../custody/custody.service');
    return await this.database.transaction(async (txClient) => {
      const res = await txClient.query(
        'SELECT id, status, crypto_status FROM withdrawals WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (res.rows.length === 0) throw new AppError('Withdrawal not found', 404, 'NOT_FOUND');

      const w = res.rows[0] as any;
      if (w.status !== 'PENDING' || (w.crypto_status !== 'BROADCAST' && w.crypto_status !== 'SUBMITTED' && w.crypto_status !== 'SIGNING')) {
         throw new AppError('Cannot speed up withdrawal in state ' + w.crypto_status, 400, 'INVALID_STATE');
      }

      const result = await custodyService.replaceWithdrawal(id, gasPolicy);

      await txClient.query(
        'INSERT INTO audit_logs (id, admin_user_id, action, target_resource_type, target_resource_id, previous_state, new_state, reason, created_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, NOW())',
        [adminUserId, 'SPEED_UP_WITHDRAWAL', 'WITHDRAWAL', id, JSON.stringify({ crypto_status: w.crypto_status }), JSON.stringify({ providerReference: result.providerReference }), 'Admin speed up']
      );

      return result;
    });
  }

  public async cancelWithdrawalOnChain(id: string, adminUserId: string, gasPolicy: any): Promise<any> {
    const { custodyService } = await import('../custody/custody.service');
    return await this.database.transaction(async (txClient) => {
      const res = await txClient.query(
        'SELECT id, status, crypto_status FROM withdrawals WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (res.rows.length === 0) throw new AppError('Withdrawal not found', 404, 'NOT_FOUND');

      const w = res.rows[0] as any;
      if (w.status !== 'PENDING' || (w.crypto_status !== 'BROADCAST' && w.crypto_status !== 'SUBMITTED' && w.crypto_status !== 'SIGNING')) {
         throw new AppError('Cannot cancel on-chain withdrawal in state ' + w.crypto_status, 400, 'INVALID_STATE');
      }

      const result = await custodyService.cancelWithdrawal(id, gasPolicy);

      await txClient.query(
        'INSERT INTO audit_logs (id, admin_user_id, action, target_resource_type, target_resource_id, previous_state, new_state, reason, created_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, NOW())',
        [adminUserId, 'CANCEL_ON_CHAIN_WITHDRAWAL', 'WITHDRAWAL', id, JSON.stringify({ crypto_status: w.crypto_status }), JSON.stringify({ providerReference: result.providerReference }), 'Admin cancel on-chain']
      );

      return result;
    });
  }


  public async claimApprovedWithdrawals(limit: number): Promise<WithdrawalEntity[]> {
    return this.database.transaction(async (txClient) => {
      const res = await txClient.query<any>(
        `SELECT * FROM withdrawals
         WHERE status = 'PENDING' AND crypto_status = 'APPROVED'
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [limit]
      );

      if (res.rows.length === 0) return [];

      const ids = res.rows.map((r: any) => r.id);

      await txClient.query(
        `UPDATE withdrawals SET crypto_status = 'SUBMITTING', updated_at = NOW() WHERE id = ANY($1)`,
        [ids]
      );

      return res.rows.map((row: any) => this.mapEntity({ ...row, crypto_status: 'SUBMITTING' }));
    });
  }

  public async claimStuckWithdrawals(limit: number, olderThanMinutes: number = 5): Promise<WithdrawalEntity[]> {
    return this.database.transaction(async (txClient) => {
      const res = await txClient.query<any>(
        `SELECT * FROM withdrawals
         WHERE status = 'PENDING' AND crypto_status IN ('SIGNING', 'UNKNOWN', 'SUBMITTING')
         AND updated_at < NOW() - INTERVAL '${olderThanMinutes} minutes'
         ORDER BY updated_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [limit]
      );

      if (res.rows.length === 0) return [];

      const ids = res.rows.map((r: any) => r.id);

      await txClient.query(
        `UPDATE withdrawals SET crypto_status = 'SUBMITTING', updated_at = NOW() WHERE id = ANY($1)`,
        [ids]
      );

      return res.rows.map((row: any) => this.mapEntity({ ...row, crypto_status: 'SUBMITTING' }));
    });
  }

  public async getActiveCustodyWithdrawals(limit: number): Promise<WithdrawalEntity[]> {
    const res = await this.database.query<any>(
      `SELECT * FROM withdrawals
       WHERE status = 'PENDING'
       AND crypto_status IN ('SUBMITTED', 'BROADCAST', 'CONFIRMING', 'UNKNOWN', 'SUBMITTING')
       ORDER BY updated_at ASC LIMIT $1`,
      [limit]
    );
    return res.rows.map(this.mapEntity);
  }

  public async markAsSubmitted(id: string, providerId: string, providerWithdrawalId: string): Promise<void> {
    await this.database.query(
      `UPDATE withdrawals
       SET crypto_status = 'SUBMITTED', provider_id = $1, provider_withdrawal_id = $2, updated_at = NOW()
       WHERE id = $3`,
      [providerId, providerWithdrawalId, id]
    );
  }

  /**
   * Phase 11K — manual Safe mode.
   * Transition an approved (claimed → SUBMITTING) withdrawal to
   * READY_FOR_MANUAL_EXECUTION. The backend does NOT sign or broadcast; a
   * human performs execution via Safe/MetaMask. Only transitions from the
   * claim-time SUBMITTING state; an idempotent no-op otherwise.
   */
  public async markReadyForManualExecution(id: string): Promise<void> {
    await this.database.query(
      `UPDATE withdrawals
       SET crypto_status = 'READY_FOR_MANUAL_EXECUTION', updated_at = NOW()
       WHERE id = $1 AND status = 'PENDING' AND crypto_status = 'SUBMITTING'`,
      [id]
    );
  }

  /**
   * Phase 11K — manual Safe mode.
   *
   * Administrator confirmation of a manual customer withdrawal execution.
   *
   * Security model:
   * - Only READY_FOR_MANUAL_EXECUTION withdrawals may be confirmed.
   * - A REAL, verifiable blockchain transaction hash is required.
   * - The transaction is independently verified on-chain (sender, destination,
   *   asset, amount, chainId, receipt) BEFORE SUBMITTED is written.
   * - An operator's assertion alone is never accepted.
   * - A tx_hash cannot be reused to settle a different withdrawal.
   * - No private key ever enters this path.
   *
   * On success: crypto_status -> SUBMITTED, tx_hash -> verified hash.
   * Ledger settlement happens later via completeWithdrawal (WithdrawalStatusWorker).
   */
  public async confirmManualWithdrawal(
    withdrawalId: string,
    txHash: string,
    adminUserId: string,
    audit?: RecordAuditLogDto
  ): Promise<void> {
    if (!TX_HASH_RE.test(txHash)) {
      throw new AppError('Transaction hash must be a 0x-prefixed 64-hex hash', 400, 'INVALID_TX_HASH');
    }

    try {
      await this.database.transaction(async (txClient) => {
      // 1. Lock the withdrawal row and join its owning user (self-action guard).
      const wRes = await txClient.query<any>(
        `SELECT w.*, a.user_id
         FROM withdrawals w
         JOIN accounts a ON w.account_id = a.id
         WHERE w.id = $1 FOR UPDATE`,
        [withdrawalId]
      );
      if (wRes.rows.length === 0) throw new AppError('Withdrawal not found', 404, 'NOT_FOUND');
      const w = wRes.rows[0];

      if (w.user_id === adminUserId) {
        throw new AppError('Administrators cannot confirm their own withdrawals', 403, 'FORBIDDEN_SELF_ACTION');
      }

      // 2. State guard: only READY_FOR_MANUAL_EXECUTION may be confirmed.
      if (w.status !== 'PENDING' || w.crypto_status !== 'READY_FOR_MANUAL_EXECUTION') {
        throw new AppError(
          `Withdrawal is not awaiting manual execution (crypto_status=${w.crypto_status})`,
          400,
          'INVALID_STATE'
        );
      }

      // 3. Duplicate tx_hash guard: one physical transaction settles at most
      //    one withdrawal intent.
      const dupRes = await txClient.query<any>(
        `SELECT id FROM withdrawals
         WHERE tx_hash = $1 AND crypto_status IN ('SUBMITTED', 'CONFIRMED', 'COMPLETED') AND id <> $2`,
        [txHash, withdrawalId]
      );
      if (dupRes.rows.length > 0) {
        throw new AppError('Transaction hash is already used by another withdrawal', 409, 'DUPLICATE_TX_HASH');
      }

      // 4. Independent on-chain verification (fail closed).
      //    Authorized sender for customer withdrawals is the configured cold
      //    EOA / MetaMask address (CUSTODY_HOT_WALLET_ADDRESS). If it is not
      //    configured, verification fails closed — we never guess a sender.
      if (!env.CUSTODY_HOT_WALLET_ADDRESS) {
        throw new AppError(
          'CUSTODY_HOT_WALLET_ADDRESS is not configured; manual withdrawal confirmation is disabled',
          503,
          'SENDER_NOT_CONFIGURED'
        );
      }
      const verification = await manualTxVerificationService.verifyWithdrawalTx({
        network: w.network,
        txHash,
        expectedSender: env.CUSTODY_HOT_WALLET_ADDRESS,
        expectedDestination: w.destination_address,
        asset: w.asset,
        expectedAmount: w.amount,
      });

      if (!verification.verified) {
        throw new AppError(
          `On-chain verification failed: ${verification.reason || 'unknown reason'}`,
          422,
          'ONCHAIN_VERIFICATION_FAILED'
        );
      }

      // 5. Atomically mark SUBMITTED with the verified tx hash.
      await txClient.query(
        `UPDATE withdrawals
         SET crypto_status = 'SUBMITTED',
             tx_hash = $1,
             provider_withdrawal_id = $1,
             provider_id = 'manual_safe',
             confirmed_by = $2,
             confirmed_at = NOW(),
             updated_at = NOW()
         WHERE id = $3`,
        [txHash, adminUserId, withdrawalId]
      );

      // 6. Audit inside the same transaction (failure rolls back confirmation).
      if (audit) {
        await auditService.record(audit, txClient);
      }
      });
    } catch (err: any) {
      // F1 (Phase 11K-B): the partial unique index uq_withdrawals_tx_hash is
      // the authoritative concurrency guard. Two concurrent confirmations of
      // the SAME physical tx_hash against DIFFERENT withdrawals both pass the
      // application-level duplicate check (neither sees the other's uncommitted
      // row), but the second UPDATE violates the unique index (23505). Translate
      // that DB violation into the same clean DUPLICATE_TX_HASH error the
      // sequential application guard produces. Everything else propagates.
      if (err?.code === '23505' || /duplicate key value violates unique constraint/.test(String(err?.message || ''))) {
        throw new AppError('Transaction hash is already used by another withdrawal', 409, 'DUPLICATE_TX_HASH');
      }
      throw err;
    }
  }

  public async updateCryptoStatus(id: string, cryptoStatus: string): Promise<void> {
    await this.database.query(
      `UPDATE withdrawals SET crypto_status = $1, updated_at = NOW() WHERE id = $2`,
      [cryptoStatus, id]
    );
  }

  /**
   * Phase 10.4 Step 6E-4C-2 (P1): read the live custody state for failure
   * handling. Claim-time entity snapshots are stale — requestWithdrawal may
   * have reserved a nonce (persisting network_nonce + crypto_status='SIGNING')
   * AFTER the claim row was read, so failure handling MUST re-read the row to
   * know whether a nonce is durably reserved.
   */
  public async getCryptoState(id: string): Promise<{ crypto_status: string | null; network_nonce: number | null }> {
    const res = await this.database.query<{ crypto_status: string; network_nonce: string | number | null }>(
      `SELECT crypto_status, network_nonce FROM withdrawals WHERE id = $1`,
      [id]
    );
    if (res.rows.length === 0) return { crypto_status: null, network_nonce: null };
    const r = res.rows[0];
    const nonce = r.network_nonce == null ? null : Number(r.network_nonce);
    return {
      crypto_status: r.crypto_status ?? null,
      network_nonce: nonce !== null && Number.isNaN(nonce) ? null : nonce,
    };
  }

  public async failWithdrawal(id: string, reason: string): Promise<void> {
    await this.database.transaction(async (txClient) => {
      const wRes = await txClient.query<any>('SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [id]);
      if (wRes.rows.length === 0) return;
      const w = wRes.rows[0];

      if (w.status !== 'PENDING') return;

      const totalDeduction = decimalAdd(w.amount, w.fee);

      await this.ledger.postTransaction({
        accountId: w.account_id,
        transactionType: 'ADJUSTMENT',
        referenceId: `wd_rel_${w.id}`,
        description: `Release failed crypto withdrawal ${w.asset}`,
        entries: [
          { accountId: w.account_id, asset: w.asset, direction: 'DEBIT', amount: totalDeduction, balancePool: 'locked' },
          { accountId: w.account_id, asset: w.asset, direction: 'CREDIT', amount: totalDeduction, balancePool: 'available' }
        ]
      }, txClient);

      await txClient.query(
        `UPDATE withdrawals
         SET status = 'FAILED', crypto_status = 'FAILED', failure_reason = $1, updated_at = NOW()
         WHERE id = $2`,
        [reason, id]
      );
    });
  }

  public async completeWithdrawal(id: string, txHash: string): Promise<void> {
    await this.database.transaction(async (txClient) => {
      const wRes = await txClient.query<any>('SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [id]);
      if (wRes.rows.length === 0) return;
      const w = wRes.rows[0];
      if (w.status !== 'PENDING') return;
      await this.settleCompletedWithdrawal(w, txHash, txClient);
    });
  }

  /**
   * Internal settlement logic shared by the status-worker completeWithdrawal and
   * the admin UNKNOWN-resolve COMPLETED path.  MUST be called within an active
   * transaction (txClient) that already holds the FOR UPDATE lock on the withdrawal row.
   */
  private async settleCompletedWithdrawal(w: any, txHash: string, txClient: IDatabaseConnection): Promise<void> {
    const SYSTEM_VAULT = '11111111-1111-1111-1111-111111111111';

    const settleEntries: any[] = [
      { accountId: w.account_id, asset: w.asset, direction: 'DEBIT', amount: w.amount, balancePool: 'locked' }
    ];
    await this.ledger.postTransaction({
      accountId: w.account_id,
      transactionType: 'WITHDRAWAL_SETTLE',
      referenceId: `wd_stl_${w.id}`,
      description: `Settle crypto withdrawal ${w.asset}`,
      entries: settleEntries
    }, txClient);

    if (w.fee && decimalIsPositive(String(w.fee))) {
      const feeEntries: any[] = [
        { accountId: w.account_id, asset: w.asset, direction: 'DEBIT', amount: w.fee, balancePool: 'locked' },
        { accountId: SYSTEM_VAULT, asset: w.asset, direction: 'CREDIT', amount: w.fee, balancePool: 'available' }
      ];
      await this.ledger.postTransaction({
        accountId: w.account_id,
        transactionType: 'WITHDRAWAL_FEE',
        referenceId: `wd_fee_${w.id}`,
        description: `Crypto withdrawal fee ${w.asset}`,
        entries: feeEntries
      }, txClient);
    }

    await txClient.query(
      `UPDATE withdrawals
       SET status = 'COMPLETED', crypto_status = 'COMPLETED', tx_hash = $1, updated_at = NOW()
       WHERE id = $2`,
      [txHash || '', w.id]
    );
  }

  /**
   * P0-3: Safe evidence-based administrative resolution of UNKNOWN withdrawals.
   *
   * - FAILED:  provider confirms the withdrawal was never broadcast → release funds
   * - COMPLETED: provider confirms successful on-chain settlement → complete the withdrawal
   *
   * FAIL CLOSED: if the provider is unavailable or cannot provide sufficient evidence,
   * the resolution is rejected.
   */
  public async resolveWithdrawalAdmin(
    withdrawalId: string,
    adminUserId: string,
    directive: WithdrawalResolutionDirective,
    audit?: RecordAuditLogDto
  ): Promise<void> {
    await this.database.transaction(async (txClient) => {
      // 1. Lock the withdrawal row (join the owning user for self-action checks)
      const wRes = await txClient.query<any>(
        `SELECT w.*, a.user_id
         FROM withdrawals w
         JOIN accounts a ON w.account_id = a.id
         WHERE w.id = $1 FOR UPDATE`,
        [withdrawalId]
      );
      if (wRes.rows.length === 0) throw new AppError('Withdrawal not found', 404, 'NOT_FOUND');
      const w = wRes.rows[0];

      // 2. Self-action restriction
      if (w.user_id === adminUserId) {
        throw new AppError('Administrators cannot resolve their own withdrawals', 403, 'FORBIDDEN_SELF_ACTION');
      }

      // 3. Only UNKNOWN withdrawals can be resolved
      if (w.status !== 'PENDING' || w.crypto_status !== 'UNKNOWN') {
        throw new AppError('Only UNKNOWN withdrawals can be resolved', 400, 'INVALID_STATE');
      }

      // 4. Query the custody provider for authoritative evidence
      const evidence = await this.queryWithdrawalEvidence(w);

      if (directive === 'FAILED') {
        if (!evidence.nonBroadcast) {
          throw new AppError(
            'Resolution rejected: provider cannot confirm the withdrawal was never broadcast',
            409,
            'RESOLUTION_EVIDENCE_INSUFFICIENT'
          );
        }
        // Release the reserved funds (amount + fee) back to available
        const totalDeduction = decimalAdd(w.amount, w.fee);
        await this.ledger.postTransaction({
          accountId: w.account_id,
          transactionType: 'ADJUSTMENT',
          referenceId: `wd_resolve_rel_${w.id}`,
          description: `Release UNKNOWN resolved-as-failed crypto withdrawal ${w.asset}`,
          entries: [
            { accountId: w.account_id, asset: w.asset, direction: 'DEBIT', amount: totalDeduction, balancePool: 'locked' },
            { accountId: w.account_id, asset: w.asset, direction: 'CREDIT', amount: totalDeduction, balancePool: 'available' }
          ]
        }, txClient);

        await txClient.query(
          `UPDATE withdrawals
           SET status = 'FAILED', crypto_status = 'FAILED', failure_reason = $1, updated_at = NOW()
           WHERE id = $2`,
          ['Resolved as failed by administrator: provider confirmed non-broadcast', w.id]
        );
      } else {
        // COMPLETED — require authoritative evidence of successful settlement
        if (!evidence.confirmed) {
          throw new AppError(
            'Resolution rejected: provider cannot confirm successful settlement',
            409,
            'RESOLUTION_EVIDENCE_INSUFFICIENT'
          );
        }
        await this.settleCompletedWithdrawal(w, evidence.txHash || '', txClient);
      }

      // 5. Audit INSIDE the same transaction (failure rolls back the resolution)
      if (audit) {
        await auditService.record(audit, txClient);
      }
    });
  }

  /**
   * Query the custody provider for authoritative evidence about an UNKNOWN withdrawal.
   * FAIL CLOSED: if the provider is unavailable or custody is disabled, no evidence is
   * produced and any requested resolution is rejected.
   */
  private async queryWithdrawalEvidence(w: any): Promise<{ nonBroadcast: boolean; confirmed: boolean; txHash?: string }> {
    try {
      const custodyResult = await custodyService.getWithdrawalStatus(w.id);
      const status = custodyResult.status;
      // A withdrawal recorded but never broadcast (PENDING/SIGNING), or explicitly
      // failed/rejected/reversed is non-broadcast.  BROADCAST is in-flight and
      // neither safe to fail nor confirmed.
      return {
        nonBroadcast: status === 'PENDING' || status === 'SIGNING' || status === 'FAILED' || status === 'REJECTED' || status === 'REVERSED',
        confirmed: status === 'CONFIRMED',
        txHash: custodyResult.providerReference,
      };
    } catch (err) {
      if (err instanceof CustodyTransactionNotFoundError) {
        // Authoritative: the provider has NO record of this withdrawal → never submitted/broadcast.
        return { nonBroadcast: true, confirmed: false };
      }
      // Provider unavailable / custody disabled / capability missing → FAIL CLOSED.
      logger.error('Withdrawal resolution: custody evidence query failed', {
        withdrawalId: w.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return { nonBroadcast: false, confirmed: false };
    }
  }

  public async cancelWithdrawal(id: string): Promise<void> {
    await this.database.transaction(async (txClient) => {
      const wRes = await txClient.query<any>('SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [id]);
      if (wRes.rows.length === 0) throw new AppError('Withdrawal not found', 404, 'NOT_FOUND');
      const w = wRes.rows[0];

      if (w.status !== 'PENDING' || (w.crypto_status !== 'PENDING' && w.crypto_status !== 'RESERVED' && w.crypto_status !== 'APPROVED' && w.crypto_status !== 'READY_FOR_MANUAL_EXECUTION')) {
        throw new AppError('Cannot cancel a withdrawal that has been submitted', 400, 'INVALID_STATE');
      }

      const totalDeduction = decimalAdd(w.amount, w.fee);

      await this.ledger.postTransaction({
        accountId: w.account_id,
        transactionType: 'ADJUSTMENT',
        referenceId: `wd_cxl_${w.id}`,
        description: `Cancel crypto withdrawal ${w.asset}`,
        entries: [
          { accountId: w.account_id, asset: w.asset, direction: 'DEBIT', amount: totalDeduction, balancePool: 'locked' },
          { accountId: w.account_id, asset: w.asset, direction: 'CREDIT', amount: totalDeduction, balancePool: 'available' }
        ]
      }, txClient);

      await txClient.query(
        `UPDATE withdrawals
         SET status = 'REJECTED', crypto_status = 'CANCELLED', updated_at = NOW()
         WHERE id = $1`,
        [id]
      );
    });
  }

  private mapEntity(row: any): WithdrawalEntity {
    return {
      id: row.id,
      accountId: row.account_id,
      asset: row.asset,
      network: row.network,
      amount: row.amount,
      fee: row.fee,
      status: row.status,
      cryptoStatus: row.crypto_status,
      destinationAddress: row.destination_address,
      destinationMemo: row.destination_memo,
      providerId: row.provider_id,
      providerWithdrawalId: row.provider_withdrawal_id,
      failureReason: row.failure_reason,
      txHash: row.tx_hash,
      ledgerTxId: row.ledger_tx_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}

export const withdrawalService = new WithdrawalService();
