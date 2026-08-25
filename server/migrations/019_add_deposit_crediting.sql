-- Migration 019: Add Deposit Crediting state tracking

-- 1. Add tracking columns to blockchain_deposits
ALTER TABLE blockchain_deposits 
ADD COLUMN is_credited BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN ledger_tx_id UUID REFERENCES ledger_transactions(id);

-- 2. Create optimized index for the Deposit Crediting Worker
CREATE INDEX idx_blockchain_deposits_uncredited 
ON blockchain_deposits(network, status) 
WHERE status = 'CONFIRMED' AND is_credited = FALSE;
