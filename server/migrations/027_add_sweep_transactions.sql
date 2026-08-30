-- Migration 025: Add Sweep Transactions
-- Tracks physical sweep transactions to ensure crash safety and allow grouped sweeping.

CREATE TABLE IF NOT EXISTS sweep_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    network VARCHAR(32) NOT NULL,
    network_nonce BIGINT NOT NULL,
    tx_hash VARCHAR(128) NOT NULL,
    raw_signed_tx TEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(network, tx_hash)
);

CREATE INDEX IF NOT EXISTS idx_sweep_transactions_status ON sweep_transactions(network, status);
