-- Migration 020: Add Crypto Withdrawal Support Fields

-- 1. Extend Ledger Tx Type ENUM safely
DO $$ BEGIN
    ALTER TYPE ledger_tx_type ADD VALUE 'WITHDRAWAL_SETTLE';
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TYPE ledger_tx_type ADD VALUE 'WITHDRAWAL_FEE';
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 2. Extend Withdrawals Table
ALTER TABLE withdrawals 
  ADD COLUMN IF NOT EXISTS network VARCHAR(32),
  ADD COLUMN IF NOT EXISTS destination_memo TEXT,
  ADD COLUMN IF NOT EXISTS provider_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS provider_withdrawal_id VARCHAR(128),
  ADD COLUMN IF NOT EXISTS crypto_status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS failure_reason TEXT;

-- 3. Add necessary indexes
CREATE INDEX IF NOT EXISTS idx_withdrawals_crypto_status ON withdrawals(crypto_status);
CREATE INDEX IF NOT EXISTS idx_withdrawals_provider_id ON withdrawals(provider_withdrawal_id);
