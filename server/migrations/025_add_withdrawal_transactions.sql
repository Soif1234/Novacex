-- Migration 023: Add Withdrawal Transactions Architecture
-- Implements Phase 10.4 Step 6D-1D Signed Transaction Persistence & Recovery model.

-- 1. Withdrawal Transactions Table
-- Tracks every individual signing attempt (including speed-ups/replacements)
-- and persists the exact raw signed bytes required for broadcast recovery.
CREATE TABLE IF NOT EXISTS withdrawal_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    withdrawal_id UUID NOT NULL REFERENCES withdrawals(id),
    network VARCHAR(32) NOT NULL,
    network_nonce BIGINT NOT NULL,
    tx_hash VARCHAR(128) NOT NULL,
    raw_signed_tx TEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(network, tx_hash)
);

-- Index for efficient lookup of a withdrawal's transactions (to find the latest signing intent)
CREATE INDEX IF NOT EXISTS idx_withdrawal_transactions_wid ON withdrawal_transactions(withdrawal_id, created_at DESC);

-- Index for polling pending broadcasts for reconciliation
CREATE INDEX IF NOT EXISTS idx_withdrawal_transactions_status ON withdrawal_transactions(network, status);
