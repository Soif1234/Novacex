-- Migration 022: Custody Hot Wallet State Management
-- Implements Phase 10.4 Step 6B required database schema.

-- 1. EVM Hot Wallet Nonces
-- Tracks the next available nonce for each EVM network namespace.
CREATE TABLE IF NOT EXISTS hot_wallet_nonces (
    network VARCHAR(32) NOT NULL,
    address VARCHAR(42) NOT NULL,
    next_nonce BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (network, address)
);

-- 2. Bitcoin Hot Wallet UTXOs
-- Tracks available and locked UTXOs to prevent double spending during concurrent withdrawal signing.
CREATE TABLE IF NOT EXISTS hot_wallet_utxos (
    txid VARCHAR(128) NOT NULL,
    vout INT NOT NULL,
    network VARCHAR(32) NOT NULL,
    amount NUMERIC(36, 18) NOT NULL CHECK (amount > 0),
    status VARCHAR(32) NOT NULL DEFAULT 'AVAILABLE',
    locked_at TIMESTAMPTZ,
    PRIMARY KEY (txid, vout, network)
);

-- Index to efficiently find available UTXOs for a specific network
CREATE INDEX IF NOT EXISTS idx_hot_wallet_utxos_available ON hot_wallet_utxos(network, status);

-- 3. Pending Custody Sweeps
-- Tracks unswept blockchain deposits that need to be swept to the hot wallet.
CREATE TABLE IF NOT EXISTS pending_sweeps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deposit_id VARCHAR(255) NOT NULL REFERENCES blockchain_deposits(id),
    network VARCHAR(32) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    sweep_txid VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(deposit_id)
);

-- Index to efficiently query pending sweeps by network and status
CREATE INDEX IF NOT EXISTS idx_pending_sweeps_status ON pending_sweeps(network, status);

-- 4. Withdrawal Nonce Persistence
-- Adds network_nonce to the existing withdrawals table to support EVM speed-ups (Replace-By-Fee).
ALTER TABLE withdrawals
ADD COLUMN IF NOT EXISTS network_nonce BIGINT;
