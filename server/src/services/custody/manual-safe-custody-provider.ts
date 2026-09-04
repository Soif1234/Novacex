/**
 * Phase 11K — Manual Safe Custody Provider
 *
 * A production custody provider that implements the ICustodyAdapter interface
 * WITHOUT AWS KMS, WITHOUT private-key signing, WITHOUT Ethereum nonce
 * management, and WITHOUT blockchain transaction broadcast.
 *
 * # Architecture
 *
 * Safe 1-of-1
 * + MetaMask / cold EOA (configured via CUSTODY_HOT_WALLET_ADDRESS)
 * + manual customer withdrawals
 * + manual treasury transfers
 * + RPC monitoring/reconciliation
 * + NO AWS KMS in the active production/manual path.
 *
 * # What this provider DOES
 * - Creates/tracks manual execution intents (READY_FOR_MANUAL_EXECUTION)
 * - Reads on-chain transaction status for confirmation/reconciliation
 * - Verifies on-chain transaction evidence (via ManualTxVerificationService)
 * - Returns READY_FOR_MANUAL_EXECUTION from write operations instead of
 *   signing/broadcasting
 *
 * # What this provider DOES NOT
 * - Hold a private key
 * - Call AWS KMS
 * - Sign transactions
 * - Allocate Ethereum outbound nonces
 * - Broadcast blockchain transactions
 * - Store raw_signed_tx
 *
 * The same sender model applies to both customer withdrawals and treasury
 * transfers:
 * - SENDER:  CUSTODY_HOT_WALLET_ADDRESS (cold EOA / MetaMask, env-configured)
 * - Near-transfer:  withdrawal.destination_address (customer withdrawal)
 * - Treasury: TREASURY_SAFE_ADDRESS (immutable env, the Safe contract)
 */
import { ethers } from 'ethers';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { ICustodyAdapter } from './custody-adapter';
import {
  CustodyAccount,
  CustodyAssetNetwork,
  CustodyBalance,
  CustodyProviderCapability,
  CustodyProviderHealth,
  CustodyTransaction,
  CustodyTransactionStatus,
  DepositAddress,
  GetOrCreateDepositAddressRequest,
  HOUSE_TREASURY_ACCOUNT_ID,
  TreasuryTransferRequest,
  WithdrawalRequest,
  SweepStatusResult,
  ReplacementGasPolicy,
} from './custody.types';
import { CustodyTransactionNotFoundError } from './custody.errors';

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export class ManualSafeCustodyProvider implements ICustodyAdapter {
  public readonly providerId = 'manual_safe';

  constructor(private readonly database: any) {}

  // --------------------------------------------------------------------------
  // Capabilities
  // --------------------------------------------------------------------------
  public getCapabilities(): CustodyProviderCapability[] {
    return [
      CustodyProviderCapability.WITHDRAWAL_REQUEST,
      CustodyProviderCapability.WITHDRAWAL_STATUS,
      CustodyProviderCapability.TREASURY_TRANSFER,
      CustodyProviderCapability.DEPOSIT_ADDRESS,
    ];
  }

  public hasCapability(capability: CustodyProviderCapability): boolean {
    return this.getCapabilities().includes(capability);
  }

  // --------------------------------------------------------------------------
  // Read operations
  // --------------------------------------------------------------------------
  public async healthCheck(): Promise<CustodyProviderHealth> {
    return {
      providerId: this.providerId,
      healthy: true,
      latencyMs: 0,
      checkedAt: new Date(),
    };
  }

  public async getSupportedAssetNetworks(): Promise<CustodyAssetNetwork[]> {
    return [];
  }

  public async getAccounts(): Promise<CustodyAccount[]> {
    return [];
  }

  public async getBalances(_accountId?: string): Promise<CustodyBalance[]> {
    return [];
  }

  public async getOrCreateDepositAddress(request: GetOrCreateDepositAddressRequest): Promise<DepositAddress> {
    if (request.network !== 'ETHEREUM') {
      throw new Error(`Network ${request.network} is not supported by manual_safe provider`);
    }

    if (!env.CUSTODY_FACTORY_ADDRESS || !env.CUSTODY_IMPLEMENTATION_ADDRESS) {
      throw new Error(
        `Deposit addresses not configured for manual_safe provider: CUSTODY_FACTORY_ADDRESS and CUSTODY_IMPLEMENTATION_ADDRESS must be set`
      );
    }

    if (env.NODE_ENV === 'production') {
      if (env.CUSTODY_CHAIN_ID !== 1) {
        throw new Error(`Production requires CUSTODY_CHAIN_ID=1 (Ethereum Mainnet); found ${env.CUSTODY_CHAIN_ID}`);
      }
      if (!env.CUSTODY_INIT_CODE_HASH) {
        throw new Error('Production requires explicit CUSTODY_INIT_CODE_HASH');
      }
    }

    const factoryAddress = ethers.getAddress(env.CUSTODY_FACTORY_ADDRESS);
    const implementationAddress = ethers.getAddress(env.CUSTODY_IMPLEMENTATION_ADDRESS);

    const expectedInitCode = ethers.solidityPacked(
      ['bytes', 'bytes20', 'bytes'],
      [
        '0x3d602d80600a3d3981f3363d3d373d3d3d363d73',
        implementationAddress,
        '0x5af43d82803e903d91602b57fd5bf3',
      ]
    );
    const expectedInitCodeHash = ethers.keccak256(expectedInitCode);

    if (env.CUSTODY_INIT_CODE_HASH && env.CUSTODY_INIT_CODE_HASH !== expectedInitCodeHash) {
      throw new Error(
        `CRITICAL: initCodeHash mismatch. Expected ${expectedInitCodeHash} but got ${env.CUSTODY_INIT_CODE_HASH}`
      );
    }

    const salt = ethers.keccak256(
      ethers.solidityPacked(['string', 'string'], [request.userId, request.network])
    );

    const address = ethers.getCreate2Address(
      factoryAddress,
      salt,
      expectedInitCodeHash
    );

    return {
      address,
      asset: request.asset,
      network: request.network,
      userId: request.userId,
      requiresMemo: false,
      providerId: this.providerId,
      status: 'ACTIVE',
      createdAt: new Date(),
      metadata: {
        factoryAddress,
        implementationAddress,
        initCodeHash: expectedInitCodeHash,
        salt,
      },
    };
  }

  /**
   * Read the withdrawal row and, if a tx_hash exists, query the real chain for
   * the authoritative status. Otherwise map the DB crypto_status.
   *
   * This is the read-only reconciliation used by WithdrawalStatusWorker.
   */
  public async getWithdrawalStatus(clientWithdrawalId: string): Promise<WithdrawalRequest> {
    const res = await this.database.query(
      `SELECT id, account_id, asset, amount, network, destination_address, destination_memo,
              crypto_status, provider_withdrawal_id, tx_hash, created_at, updated_at
       FROM withdrawals WHERE id = $1`,
      [clientWithdrawalId]
    );
    if (res.rows.length === 0) {
      throw new CustodyTransactionNotFoundError(clientWithdrawalId);
    }

    const w = res.rows[0];
    const txHash: string | null = w.tx_hash || w.provider_withdrawal_id || null;
    let status: CustodyTransactionStatus = 'PENDING';

    if (txHash && TX_HASH_RE.test(txHash)) {
      status = await this.resolveTxStatus(w.network, txHash);
    } else {
      // No tx_hash yet — map from DB state.
      const cs = String(w.crypto_status || 'PENDING');
      if (cs === 'SUBMITTED' || cs === 'CONFIRMING' || cs === 'BROADCAST') {
        status = 'PENDING';
      } else if (cs === 'CONFIRMED' || cs === 'COMPLETED') {
        status = 'CONFIRMED';
      } else if (cs === 'FAILED' || cs === 'CANCELLED' || cs === 'REJECTED') {
        status = 'FAILED';
      } else {
        status = 'PENDING';
      }
    }

    return {
      clientWithdrawalId: w.id,
      accountId: w.account_id,
      asset: w.asset,
      amount: w.amount,
      network: w.network,
      destinationAddress: w.destination_address,
      destinationMemo: w.destination_memo,
      status,
      providerReference: txHash || undefined,
      providerWithdrawalId: txHash || undefined,
      createdAt: w.created_at,
      updatedAt: w.updated_at,
    };
  }

  public async getTransaction(_providerTransactionId: string): Promise<CustodyTransaction> {
    throw new CustodyTransactionNotFoundError(_providerTransactionId);
  }

  /**
   * Phase 11K — read-only treasury status lookup.
   * Queries the treasury_transactions row and, if a tx_hash exists, resolves
   * the on-chain status via RPC.
   */
  public async getTreasuryTransferStatus(treasuryIntentId: string): Promise<WithdrawalRequest> {
    const res = await this.database.query(
      `SELECT id, network, asset, amount, destination_address, tx_hash, status, created_at, updated_at
       FROM treasury_transactions
       WHERE client_withdrawal_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [treasuryIntentId]
    );
    const art = res.rows?.[0];
    if (!art) {
      throw new CustodyTransactionNotFoundError(`Treasury transfer ${treasuryIntentId}`);
    }

    const txHash: string | null = art.tx_hash || null;
    let status: CustodyTransactionStatus = 'PENDING';

    if (txHash && TX_HASH_RE.test(txHash)) {
      status = await this.resolveTxStatus(art.network, txHash);
    } else {
      const s = String(art.status || 'PENDING');
      if (s === 'CONFIRMED') status = 'CONFIRMED';
      else if (s === 'FAILED' || s === 'REORGED') status = 'FAILED';
      else status = 'PENDING';
    }

    return {
      clientWithdrawalId: treasuryIntentId,
      accountId: HOUSE_TREASURY_ACCOUNT_ID,
      asset: art.asset,
      network: art.network,
      amount: art.amount,
      destinationAddress: art.destination_address || '',
      status,
      providerReference: txHash || undefined,
      providerWithdrawalId: txHash || undefined,
      createdAt: art.created_at,
      updatedAt: art.updated_at,
    };
  }

  // --------------------------------------------------------------------------
  // Write operations — manual mode only
  // --------------------------------------------------------------------------

  /**
   * Customer withdrawal intent: the backend does NOT sign or broadcast.
   * Returns READY_FOR_MANUAL_EXECUTION. The worker transitions the DB row to
   * this state and a human operator performs the actual signing via Safe/MetaMask.
   */
  public async requestWithdrawal(request: WithdrawalRequest): Promise<WithdrawalRequest> {
    if (!request.clientWithdrawalId) {
      throw new Error('clientWithdrawalId is required');
    }
    if (!request.destinationAddress) {
      throw new Error('destinationAddress is required');
    }

    logger.info('[ManualSafeCustodyProvider] Withdrawal intent marked READY_FOR_MANUAL_EXECUTION', {
      withdrawalId: request.clientWithdrawalId,
      asset: request.asset,
      network: request.network,
      amount: request.amount,
      destination: request.destinationAddress,
    });

    return {
      ...request,
      status: 'READY_FOR_MANUAL_EXECUTION',
      providerWithdrawalId: undefined,
      providerReference: undefined,
      updatedAt: new Date(),
    };
  }

  /**
   * Treasury transfer intent: the backend does NOT sign or broadcast.
   * Returns READY_FOR_MANUAL_EXECUTION. The manager transitions the treasury
   * transaction row to this state.
   */
  public async submitTreasuryTransfer(request: TreasuryTransferRequest): Promise<WithdrawalRequest> {
    if (!request.treasuryIntentId) {
      throw new Error('treasuryIntentId is required');
    }
    if (!request.destinationAddress) {
      throw new Error('destinationAddress is required');
    }

    logger.info('[ManualSafeCustodyProvider] Treasury intent marked READY_FOR_MANUAL_EXECUTION', {
      treasuryIntentId: request.treasuryIntentId,
      asset: request.asset,
      network: request.network,
      amount: request.amount,
      destination: request.destinationAddress,
    });

    return {
      clientWithdrawalId: request.treasuryIntentId,
      accountId: HOUSE_TREASURY_ACCOUNT_ID,
      asset: request.asset,
      network: request.network,
      amount: request.amount,
      destinationAddress: request.destinationAddress,
      status: 'READY_FOR_MANUAL_EXECUTION',
      providerWithdrawalId: undefined,
      providerReference: undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  // --------------------------------------------------------------------------
  // Unsupported write operations (thrown by CAL if called)
  // --------------------------------------------------------------------------

  public async updateTransactionStatus(
    _providerTransactionId: string,
    _status: CustodyTransactionStatus
  ): Promise<CustodyTransaction> {
    throw new Error('updateTransactionStatus is not supported by the manual_safe provider');
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Resolve the on-chain status of a transaction hash.
   * Returns CONFIRMED / FAILED / BROADCAST (pending in mempool but not yet
   * mined) / PENDING (not found at all).
   */
  private async resolveTxStatus(network: string, txHash: string): Promise<CustodyTransactionStatus> {
    const rpcUrl = this.rpcUrl(network);
    if (!rpcUrl) return 'PENDING';

    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt && receipt.status !== undefined) {
        return receipt.status === 1 ? 'CONFIRMED' : 'FAILED';
      }
      const pending = await provider.getTransaction(txHash);
      return pending ? 'BROADCAST' : 'PENDING';
    } catch {
      return 'PENDING';
    }
  }

  private rpcUrl(network: string): string | null {
    if (!network) return null;
    if (network.toUpperCase() === 'ETHEREUM') return env.ETHEREUM_RPC_URL || null;
    return null;
  }
}