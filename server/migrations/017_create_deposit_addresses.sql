-- Migration 017: Create Deposit Addresses Table (Phase 9.3 — Deposit Addresses)
--
-- Persists the deposit addresses NovaCEX assigns to users for receiving real
-- crypto deposits in a future production custody system. Phase 9.3 stores the
-- address METADATA only — no blockchain monitoring, no deposit detection, no
-- ledger crediting, no withdrawals, no real custody provider.
--
-- Identity model (approved design):
--   ONE active deposit address per (user_id, asset, network).
--   Addresses are USER-scoped (not per Spot/Futures/Funding account).
--   Phase 9.5 decides which internal account receives a verified deposit.
--
-- Lifecycle (approved design):
--   ACTIVE -> ROTATED  |  ACTIVE -> REVOKED
--   REQUESTED/GENERATING states are NOT persisted in Phase 9.3.
--
-- Additive only: creates ONE new table; does not alter migrations 001-016,
-- wallet balances, the double-entry ledger, or any trading/futures schema.

-- 1. Deposit Addresses Table
CREATE TABLE IF NOT EXISTS deposit_addresses (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    asset               VARCHAR(20) NOT NULL REFERENCES assets(symbol),
    network             VARCHAR(32) NOT NULL,
    -- Provider/workspace context (provider-neutral; real provider ids later)
    provider_id         VARCHAR(64) NOT NULL,
    custody_account_id  VARCHAR(128),
    provider_address_id VARCHAR(128),
    -- The assigned on-chain address + optional destination tag/memo
    blockchain_address  TEXT NOT NULL,
    memo                VARCHAR(255),
    -- Lifecycle: ACTIVE | ROTATED | REVOKED
    status              VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    address_metadata    JSONB NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at          TIMESTAMPTZ,
    -- Composite FK: only known (asset, network) pairs from Phase 9.1 are valid
    FOREIGN KEY (asset, network) REFERENCES asset_networks(asset, network)
);

-- 2. Indexes
-- One ACTIVE address per (user_id, asset, network); history rows (ROTATED/
-- REVOKED) are retained and excluded from this uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS uq_deposit_addresses_active
    ON deposit_addresses(user_id, asset, network)
    WHERE status = 'ACTIVE';

-- User lookup (address history for a user)
CREATE INDEX IF NOT EXISTS idx_deposit_addresses_user
    ON deposit_addresses(user_id);

-- Network lookup (admin/ops)
CREATE INDEX IF NOT EXISTS idx_deposit_addresses_network
    ON deposit_addresses(network);

-- Unique provider-side address (prevents duplicate provider rows)
CREATE UNIQUE INDEX IF NOT EXISTS uq_deposit_addresses_provider
    ON deposit_addresses(provider_id, provider_address_id)
    WHERE provider_address_id IS NOT NULL;
