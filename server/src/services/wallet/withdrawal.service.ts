import crypto from 'crypto';
import { db, IDatabaseConnection } from '../../config/database';
import { AccountType } from '../../models/account.model';
import { WithdrawalEntity } from '../../models/ledger.model';
import { ledgerService, LedgerService } from '../ledger/ledger.service';
import { amlService, AmlService } from '../compliance/aml.service';
import { validateAmount, decimalNormalize, decimalAdd } from '../ledger/decimal';
import { logger } from '../../config/logger';
import { AppError } from '../../middleware/errorHandler';

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

    return this.database.transaction(async (txClient) => {
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

      if (parseFloat(amount) < parseFloat(minWithdrawal)) {
        throw new AppError(`Withdrawal amount is below minimum of ${minWithdrawal}`, 400, 'BELOW_MINIMUM');
      }
      
      const totalDeduction = decimalAdd(amount, withdrawalFee);

      // 3. AML Checks
      await this.aml.validateWithdrawalCompliance({
        userId,
        asset,
        amount,
        destinationAddress
      });

      // 4. Reserve funds using WITHDRAWAL (counts towards AML instantly)
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

      // 5. Create withdrawal record
      const withdrawalId = crypto.randomUUID();
      const insertRes = await txClient.query<any>(`
        INSERT INTO withdrawals (
          id, account_id, asset, network, amount, fee, status, crypto_status, 
          destination_address, destination_memo, ledger_tx_id, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW()
        ) RETURNING *
      `, [
        withdrawalId, accountId, asset, network, amount, withdrawalFee, 
        'PENDING', 'PENDING', destinationAddress, destinationMemo || null, ledgerTxId.transactionId
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
  }

  public async approveWithdrawal(withdrawalId: string): Promise<void> {
    await this.database.transaction(async (txClient) => {
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

  public async getApprovedWithdrawals(limit: number): Promise<WithdrawalEntity[]> {
    const res = await this.database.query<any>(
      `SELECT * FROM withdrawals WHERE status = 'PENDING' AND crypto_status = 'APPROVED' ORDER BY created_at ASC LIMIT $1`,
      [limit]
    );
    return res.rows.map(this.mapEntity);
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

  public async updateCryptoStatus(id: string, cryptoStatus: string): Promise<void> {
    await this.database.query(
      `UPDATE withdrawals SET crypto_status = $1, updated_at = NOW() WHERE id = $2`,
      [cryptoStatus, id]
    );
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
    const SYSTEM_VAULT = '11111111-1111-1111-1111-111111111111';
    
    await this.database.transaction(async (txClient) => {
      const wRes = await txClient.query<any>('SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [id]);
      if (wRes.rows.length === 0) return;
      const w = wRes.rows[0];

      if (w.status !== 'PENDING') return;

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

      if (parseFloat(w.fee) > 0) {
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
        [txHash || '', id]
      );
    });
  }

  public async cancelWithdrawal(id: string): Promise<void> {
    await this.database.transaction(async (txClient) => {
      const wRes = await txClient.query<any>('SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [id]);
      if (wRes.rows.length === 0) throw new AppError('Withdrawal not found', 404, 'NOT_FOUND');
      const w = wRes.rows[0];

      if (w.status !== 'PENDING' || (w.crypto_status !== 'PENDING' && w.crypto_status !== 'RESERVED' && w.crypto_status !== 'APPROVED')) {
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
