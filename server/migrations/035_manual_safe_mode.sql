-- Migration 035: Phase 11K — Manual Safe Mode
--
-- Adds the minimal schema for manual (KMS-free) customer withdrawals and
-- treasury transfers:
--
--   1. withdrawals: physical tx_hash + manual confirmation audit columns.
--      (withdrawals.tx_hash does NOT exist in any prior migration; the legacy
--      completeWithdrawal path referenced it, so this completes the schema.)
--   2. treasury_transactions: manual confirmation audit columns.
--   3. treasury_transactions status CHECK extended to allow the
--      READY_FOR_MANUAL_EXECUTION state.
--
-- STRICTLY additive. No existing table is dropped, no existing column is
-- removed, and the KMS-era tables (hot_wallet_nonces, withdrawal_transactions,
-- treasury_custody_artifacts, sweep_intents, sweep_transactions,
-- pending_sweeps) are preserved for compatibility.

-- 1. Withdrawal manual execution columns.
ALTER TABLE withdrawals
    ADD COLUMN IF NOT EXISTS tx_hash VARCHAR(128);
ALTER TABLE withdrawals
    ADD COLUMN IF NOT EXISTS confirmed_by VARCHAR(255);
ALTER TABLE withdrawals
    ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

-- 2. Treasury manual confirmation audit columns.
ALTER TABLE treasury_transactions
    ADD COLUMN IF NOT EXISTS confirmed_by VARCHAR(255);
ALTER TABLE treasury_transactions
    ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

-- 3. Treasury status domain: allow READY_FOR_MANUAL_EXECUTION.
ALTER TABLE treasury_transactions
    DROP CONSTRAINT IF EXISTS ck_treasury_tx_status;
ALTER TABLE treasury_transactions
    ADD CONSTRAINT ck_treasury_tx_status
    CHECK (status IN (
        'PENDING', 'SIGNING', 'BROADCAST', 'READY_FOR_MANUAL_EXECUTION',
        'CONFIRMED', 'FAILED', 'REORGED', 'RECONCILIATION_REQUIRED'
    ));
