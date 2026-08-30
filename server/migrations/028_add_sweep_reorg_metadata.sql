-- Migration 026: Add Reorg Metadata to Sweep Transactions
-- Adds block_number, block_hash, and confirmed_at to track on-chain finality and reorgs for sweeps.

ALTER TABLE sweep_transactions
ADD COLUMN IF NOT EXISTS block_number BIGINT,
ADD COLUMN IF NOT EXISTS block_hash VARCHAR(128),
ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sweep_transactions_confirmed ON sweep_transactions(network, status, block_number) WHERE status = 'CONFIRMED';
