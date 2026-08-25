/**
 * Phase 9.3 — Deposit Address Entity
 *
 * Mirrors the `deposit_addresses` database table (migration 017).
 * This is a NovaCEX-persisted financial-adjacent record (address metadata),
 * NOT a wallet_balances/ledger row. Deposits are not yet credited — this
 * record only stores the external address assigned to a user for receiving
 * crypto on a specific (asset, network).
 *
 * Lifecycle states (approved Phase 9.3 design):
 *   ACTIVE  ->  ROTATED   |   ACTIVE  ->  REVOKED
 *
 * One ACTIVE address per (user_id, asset, network) is enforced by the
 * partial unique index `uq_deposit_addresses_active`.
 */

// ---------------------------------------------------------------------------
// Type Exports
// ---------------------------------------------------------------------------

export type DepositAddressStatus = 'ACTIVE' | 'ROTATED' | 'REVOKED';

export interface DepositAddressEntity {
  id: string;
  userId: string;
  asset: string;
  network: string;
  providerId: string;
  custodyAccountId?: string;
  providerAddressId?: string;
  blockchainAddress: string;
  memo?: string;
  status: DepositAddressStatus;
  addressMetadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  revokedAt?: Date;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Primary key for a deposit address within the NovaCEX domain.
 * Used as the idempotency key for provider address operations.
 */
export function toDepositAddressKey(userId: string, asset: string, network: string): string {
  return `${userId}:${asset.trim().toUpperCase()}:${network.trim().toUpperCase()}`;
}

/**
 * Map a raw database row (snake_case or camelCase) to a DepositAddressEntity.
 */
export function mapDepositAddressRow(row: Record<string, any>): DepositAddressEntity {
  return {
    id: row.id,
    userId: row.user_id ?? row.userId ?? row.userid,
    asset: row.asset,
    network: row.network,
    providerId: row.provider_id ?? row.providerId,
    custodyAccountId: row.custody_account_id ?? row.custodyAccountId ?? undefined,
    providerAddressId: row.provider_address_id ?? row.providerAddressId ?? undefined,
    blockchainAddress: row.blockchain_address ?? row.blockchainAddress,
    memo: row.memo ?? undefined,
    status: row.status as DepositAddressStatus,
    addressMetadata: row.address_metadata ?? row.addressMetadata ?? {},
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
    revokedAt: row.revoked_at ?? row.revokedAt ?? undefined,
  };
}