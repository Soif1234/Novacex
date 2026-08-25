-- Migration 018: Create Blockchain Deposits Table (Phase 9.4 — Blockchain Monitoring)
--
-- Persists normalized, validated ON-CHAIN deposit observations detected by the
-- NovaCEX blockchain monitor. Phase 9.4 stores blockchain TRUTH only:
-- detection, validation, normalization, confirmation state, reorg state.
--
-- CRITICAL BOUNDARY: This table is NOT a wallet_balances or ledger record.
-- Phase 9.4 NEVER credits wallet_balances, creates ledger_transactions or
-- ledger_entries, and never touches trading/futures/reconciliation state.
-- Phase 9.5 owns verified deposit crediting.
--
-- Identity model (approved design):
--   One row per unique blockchain event. Deterministic id =
--   sha256(chainId + ":" + transactionHash + ":" + logIndex) for EVM,
--   sha256(chainId + ":" + transactionHash + ":" + voutIndex) for Bitcoin.
--   Duplicate poll/replay/restart is safe via the primary key.
--
-- Additive only: creates TWO new tables; does not alter migrations 001-017,
-- asset_networks, deposit_addresses, wallet balances, or the double-entry ledger.

-- 1. Blockchain Deposits Table
CREATE TABLE IF NOT EXISTS blockchain_deposits (
    id                      VARCHAR(255) PRIMARY KEY, -- deterministic sha256 id
    chain_id                VARCHAR(32) NOT NULL,     -- 'ethereum' | 'bitcoin'
    asset                   VARCHAR(20) NOT NULL REFERENCES assets(symbol),
    network                 VARCHAR(32) NOT NULL,
    transaction_hash        VARCHAR(128) NOT NULL,
    block_number            BIGINT NOT NULL,
    block_hash              VARCHAR(128) NOT NULL,
    block_timestamp         TIMESTAMPTZ NOT NULL,
    log_index               INT NOT NULL,             -- logIndex (EVM) | voutIndex (BTC)
    from_address            TEXT,
    to_address              TEXT NOT NULL,            -- the NovaCEX deposit address
    amount                  NUMERIC(36, 18) NOT NULL CHECK (amount > 0),
    raw_amount              TEXT NOT NULL,            -- on-chain raw value (wei/satoshi)
    token_contract          VARCHAR(255),             -- ERC-20 contract; NULL for native
    decimals                INT NOT NULL,             -- on-chain precision from asset_networks
    confirmation_count      INT NOT NULL DEFAULT 0,
    required_confirmations  INT NOT NULL,
    status                  VARCHAR(32) NOT NULL DEFAULT 'DETECTED',
    detected_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_at            TIMESTAMPTZ,
    reorged_at              TIMESTAMPTZ,
    raw_payload             JSONB,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Composite FK: only approved (asset, network) pairs from asset_networks are valid
    FOREIGN KEY (asset, network) REFERENCES asset_networks(asset, network)
);

-- Address matching lookup (monitor -> deposit_addresses)
CREATE INDEX IF NOT EXISTS idx_blockchain_deposits_addr
    ON blockchain_deposits(to_address, network, status);

-- Block scanning / checkpoint range queries
CREATE INDEX IF NOT EXISTS idx_blockchain_deposits_block
    ON blockchain_deposits(block_number, network);

-- Reorg / idempotency verification
CREATE INDEX IF NOT EXISTS idx_blockchain_deposits_tx
    ON blockchain_deposits(transaction_hash, network);

-- 2. Monitor Checkpoints Table (restart-safe scanning cursors)
CREATE TABLE IF NOT EXISTS monitor_checkpoints (
    network             VARCHAR(32) PRIMARY KEY,
    last_block_number   BIGINT NOT NULL DEFAULT 0,
    last_block_hash     VARCHAR(128),
    last_processed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    consecutive_errors  INT NOT NULL DEFAULT 0
);

-- Seed checkpoints for the approved Phase 9.1 networks
INSERT INTO monitor_checkpoints (network, last_block_number)
VALUES ('ETHEREUM', 0), ('BITCOIN', 0)
ON CONFLICT (network) DO NOTHING;
