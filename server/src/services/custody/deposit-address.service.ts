/**
 * Phase 9.3 — DepositAddressService
 *
 * NovaCEX-side persistence and lifecycle for deposit addresses. This service:
 * - is USER-scoped (one ACTIVE address per (userId, asset, network));
 * - delegates provider-side address generation to the CAL (ICustodyAdapter);
 * - persists the address metadata in `deposit_addresses` (migration 017);
 * - is idempotent and race-safe (partial unique index + conflict handling);
 * - enforces user ownership, asset/network validity, active-network and
 *   address-format checks, and memo requirements;
 * - FAILS CLOSED when CUSTODY_ENABLED=false (via the CAL);
 * - NEVER touches wallet_balances, ledger_entries, ledger_transactions,
 *   orders, trades, futures_positions, margin, funding, or any financial math.
 *
 * Lifecycle (approved Phase 9.3 design):
 *   ACTIVE -> ROTATED  |  ACTIVE -> REVOKED
 * Old rows are retained (never DELETEd) for audit history.
 */

import crypto from 'crypto';
import { db, IDatabaseConnection } from '../../config/database';
import {
  isSupportedNetwork,
  isSupportedAddressFormat,
  isValidContractAddress,
} from '../../models/asset-network.model';
import { DepositAddressEntity, DepositAddressStatus, mapDepositAddressRow, toDepositAddressKey } from '../../models/deposit-address.model';
import {
  CustodyDisabledError,
  InvalidCustodyRequestError,
  UnsupportedAssetNetworkError,
  CustodyOperationRejectedError,
} from './custody.errors';
import { CustodyService, custodyService } from './custody.service';
import { GetOrCreateDepositAddressRequest } from './custody.types';

export interface DepositAddressServiceOptions {
  /** The CAL — must be enabled for any address operation to proceed. */
  custody: CustodyService;
  database?: IDatabaseConnection;
}

export interface GetOrCreateDepositAddressParams {
  /** Authenticated user (the ONLY user the operation may target). */
  userId: string;
  asset: string;
  network: string;
}

export interface RotateDepositAddressResult {
  rotated: DepositAddressEntity;
  current: DepositAddressEntity;
}

export class DepositAddressService {
  private readonly custody: CustodyService;
  private readonly database: IDatabaseConnection;

  constructor(options: DepositAddressServiceOptions) {
    this.custody = options.custody;
    this.database = options.database ?? db;
  }

  // -------------------------------------------------------------------------
  // Guards
  // -------------------------------------------------------------------------

  private assertCustodyEnabled(): void {
    if (!this.custody.isEnabled()) {
      throw new CustodyDisabledError();
    }
  }

  private async assertActiveUser(userId: string): Promise<void> {
    const res = await this.database.query<any>('SELECT id, account_status AS "accountStatus" FROM users WHERE id = $1', [userId]);
    const user = res.rows[0];
    if (!user) {
      throw new InvalidCustodyRequestError(`User "${userId}" not found`);
    }
    if ((user.accountStatus || user.account_status) !== 'ACTIVE') {
      throw new CustodyOperationRejectedError(`User "${userId}" is not ACTIVE (deposit address assignment denied)`, {
        userId,
        status: user.accountStatus || user.account_status,
      });
    }
  }

  private async loadAssetNetwork(asset: string, network: string): Promise<{
    isActive: boolean;
    requiresMemo: boolean;
    addressFormat: string;
  }> {
    const res = await this.database.query<any>(
      'SELECT asset, network, is_active AS "isActive", requires_memo AS "requiresMemo", address_format AS "addressFormat" FROM asset_networks WHERE asset = $1 AND network = $2',
      [asset, network],
    );
    const row = res.rows[0];
    if (!row) {
      throw new UnsupportedAssetNetworkError(asset, network);
    }
    if (!row.isActive) {
      throw new UnsupportedAssetNetworkError(asset, network, 'network is inactive');
    }
    return row;
  }

  private validateProviderAddress(
    address: string,
    format: string,
    asset: string,
    network: string,
  ): void {
    if (!address || typeof address !== 'string' || address.trim().length === 0) {
      throw new InvalidCustodyRequestError('Provider returned an empty deposit address', { asset, network });
    }
    if (!isSupportedAddressFormat(format)) {
      // Unknown format — accept to avoid false rejections (mirrors model behavior).
      return;
    }
    if (!isValidContractAddress(address, format as 'EVM_HEX' | 'BITCOIN_BECH32')) {
      throw new InvalidCustodyRequestError(
        `Provider returned an address that does not match the expected "${format}" format`,
        { asset, network, address: address.slice(0, 12) },
      );
    }
  }

  // -------------------------------------------------------------------------
  // Get-or-create (idempotent, race-safe)
  // -------------------------------------------------------------------------

  public async getOrCreateDepositAddress(
    params: GetOrCreateDepositAddressParams,
  ): Promise<DepositAddressEntity> {
    this.assertCustodyEnabled();
    const { userId, asset, network } = params;

    // 1. Ownership + identifier validation
    await this.assertActiveUser(userId);
    if (!asset || !network || asset.trim().length === 0 || network.trim().length === 0) {
      throw new InvalidCustodyRequestError('asset and network are required');
    }
    if (!isSupportedNetwork(network)) {
      throw new UnsupportedAssetNetworkError(asset, network);
    }
    const networkRow = await this.loadAssetNetwork(asset, network);

    // 2. Idempotency — existing ACTIVE address wins
    const existing = await this.getActiveAddress(userId, asset, network);
    if (existing) return existing;

    // 3. Ask the CAL/provider for an address (idempotency key = user:asset:network)
    const request: GetOrCreateDepositAddressRequest = {
      userId,
      asset,
      network,
      idempotencyKey: toDepositAddressKey(userId, asset, network),
    };
    const providerAddress = await this.custody.getOrCreateDepositAddress(request);

    // 4. Validate provider response: pair match, format, memo requirement
    if (providerAddress.asset !== asset || providerAddress.network !== network) {
      throw new InvalidCustodyRequestError(
        'Provider returned a deposit address for a different asset/network',
        { expected: `${asset}/${network}`, got: `${providerAddress.asset}/${providerAddress.network}` },
      );
    }
    this.validateProviderAddress(providerAddress.address, networkRow.addressFormat, asset, network);
    if (networkRow.requiresMemo && !providerAddress.memo) {
      throw new InvalidCustodyRequestError(
        `Provider must return a memo for ${asset}/${network} (requires_memo=true)`,
        { asset, network },
      );
    }

    // 5. Persist (race-safe: unique violation → re-select and return existing)
    try {
      const id = providerAddress.providerAddressId ?? cryptoUuid();
      const res = await this.database.query<any>(
        `INSERT INTO deposit_addresses
           (id, user_id, asset, network, provider_id, custody_account_id,
            provider_address_id, blockchain_address, memo, status, address_metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id, userId, asset, network,
          providerAddress.providerId,
          null,
          providerAddress.providerAddressId ?? null,
          providerAddress.address,
          providerAddress.memo ?? null,
          'ACTIVE',
          providerAddress.metadata ?? {},
        ],
      );
      const row = res.rows[0];
      if (row) return mapDepositAddressRow(row);
      return (await this.getActiveAddress(userId, asset, network))!;
    } catch (err: any) {
      if (err?.code === '23505') {
        // Concurrent creation — return the row another request committed.
        const raced = await this.getActiveAddress(userId, asset, network);
        if (raced) return raced;
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  public async getActiveAddress(userId: string, asset: string, network: string): Promise<DepositAddressEntity | null> {
    const res = await this.database.query<any>(
      `SELECT * FROM deposit_addresses WHERE user_id = $1 AND asset = $2 AND network = $3 AND status = 'ACTIVE' LIMIT 1`,
      [userId, asset, network],
    );
    const row = res.rows[0];
    return row ? mapDepositAddressRow(row) : null;
  }

  public async listDepositAddresses(userId: string): Promise<DepositAddressEntity[]> {
    const res = await this.database.query<any>(
      'SELECT * FROM deposit_addresses WHERE user_id = $1 ORDER BY created_at DESC',
      [userId],
    );
    return (res.rows ?? []).map((r: any) => mapDepositAddressRow(r));
  }

  // -------------------------------------------------------------------------
  // Lifecycle: rotation (atomic) and revocation
  // -------------------------------------------------------------------------

  public async rotateDepositAddress(
    params: GetOrCreateDepositAddressParams,
  ): Promise<RotateDepositAddressResult> {
    this.assertCustodyEnabled();
    const { userId, asset, network } = params;
    await this.assertActiveUser(userId);

    const existing = await this.getActiveAddress(userId, asset, network);
    if (!existing) {
      throw new InvalidCustodyRequestError(
        `No ACTIVE deposit address to rotate for ${asset}/${network}`,
        { userId, asset, network },
      );
    }

    // Atomic: revoke old (ROTATED) and create new ACTIVE in one transaction.
    const result = await this.database.transaction(async (client) => {
      const upd = await client.query<any>(
        `UPDATE deposit_addresses SET status = $1, revoked_at = $2, updated_at = NOW() WHERE id = $3`,
        ['ROTATED', new Date(), existing.id],
      );
      const rotatedRow = upd.rows[0] ?? existing;
      const rotated = mapDepositAddressRow({ ...rotatedRow, status: 'ROTATED', revokedAt: new Date() });

      const current = await this.getOrCreateDepositAddressInner(client, { userId, asset, network });
      return { rotated, current };
    });
    return result;
  }

  public async revokeDepositAddress(
    params: GetOrCreateDepositAddressParams,
  ): Promise<DepositAddressEntity> {
    this.assertCustodyEnabled();
    const { userId, asset, network } = params;
    await this.assertActiveUser(userId);

    const existing = await this.getActiveAddress(userId, asset, network);
    if (!existing) {
      throw new InvalidCustodyRequestError(
        `No ACTIVE deposit address to revoke for ${asset}/${network}`,
        { userId, asset, network },
      );
    }

    const res = await this.database.query<any>(
      `UPDATE deposit_addresses SET status = $1, revoked_at = $2, updated_at = NOW() WHERE id = $3`,
      ['REVOKED', new Date(), existing.id],
    );
    const row = res.rows[0];
    return mapDepositAddressRow({
      ...(row ?? existing),
      status: 'REVOKED' as DepositAddressStatus,
      revokedAt: new Date(),
    });
  }

  // -------------------------------------------------------------------------
  // Internal (transaction-aware) get-or-create used by rotation
  // -------------------------------------------------------------------------

  private async getOrCreateDepositAddressInner(
    client: IDatabaseConnection,
    params: GetOrCreateDepositAddressParams,
  ): Promise<DepositAddressEntity> {
    const { userId, asset, network } = params;
    const networkRow = await this.loadAssetNetwork(asset, network);

    const existing = await this.getActiveAddressVia(client, userId, asset, network);
    if (existing) return existing;

    // Rotation path: force the provider to mint a FRESH address so it never
    // collides with the just-rotated (provider-unique) address.
    const request: GetOrCreateDepositAddressRequest = {
      userId,
      asset,
      network,
      idempotencyKey: toDepositAddressKey(userId, asset, network),
      forceNew: true,
    };
    const providerAddress = await this.custody.getOrCreateDepositAddress(request);
    if (providerAddress.asset !== asset || providerAddress.network !== network) {
      throw new InvalidCustodyRequestError('Provider returned a deposit address for a different asset/network');
    }
    this.validateProviderAddress(providerAddress.address, networkRow.addressFormat, asset, network);
    if (networkRow.requiresMemo && !providerAddress.memo) {
      throw new InvalidCustodyRequestError(`Provider must return a memo for ${asset}/${network}`, { asset, network });
    }

    const id = providerAddress.providerAddressId ?? cryptoUuid();
    const res = await client.query<any>(
      `INSERT INTO deposit_addresses
         (id, user_id, asset, network, provider_id, custody_account_id,
          provider_address_id, blockchain_address, memo, status, address_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id, userId, asset, network,
        providerAddress.providerId,
        null,
        providerAddress.providerAddressId ?? null,
        providerAddress.address,
        providerAddress.memo ?? null,
        'ACTIVE',
        providerAddress.metadata ?? {},
      ],
    );
    const row = res.rows[0];
    if (row) return mapDepositAddressRow(row);
    const backstop = await this.getActiveAddressVia(client, userId, asset, network);
    if (!backstop) {
      throw new InvalidCustodyRequestError('Deposit address could not be persisted');
    }
    return backstop;
  }

  private async getActiveAddressVia(
    client: IDatabaseConnection,
    userId: string,
    asset: string,
    network: string,
  ): Promise<DepositAddressEntity | null> {
    const res = await client.query<any>(
      `SELECT * FROM deposit_addresses WHERE user_id = $1 AND asset = $2 AND network = $3 AND status = 'ACTIVE' LIMIT 1`,
      [userId, asset, network],
    );
    const row = res.rows[0];
    return row ? mapDepositAddressRow(row) : null;
  }
}

function cryptoUuid(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Lazy singleton — constructed with the disabled-by-default CAL, so every
// deposit-address operation fails closed with CustodyDisabledError until
// CUSTODY_ENABLED=true (never before Phase 9.12/9.13).
// ---------------------------------------------------------------------------

export function createDepositAddressService(options?: Partial<DepositAddressServiceOptions>): DepositAddressService {
  if (options && options.custody) {
    return new DepositAddressService({
      custody: options.custody,
      database: options.database,
    });
  }
  return new DepositAddressService({ custody: custodyService });
}

export const depositAddressService = createDepositAddressService();
