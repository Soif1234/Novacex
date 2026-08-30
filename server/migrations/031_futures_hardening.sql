-- Migration 031: Futures Hardening (Phase 0F)
--
-- Adds:
--  1. collateral_asset and maintenance_margin_rate to futures_positions
--     (enables persisted collateral tracking and contract-specific MMR)
--  2. epoch BIGINT + UNIQUE(symbol, epoch) to futures_funding_history
--     (prevents double application of funding across restarts)
--  3. Funding epoch advisory lock serialization (handled in code via pg_advisory_xact_lock)

-- 1. Add collateral_asset & maintenance_margin_rate to futures_positions
ALTER TABLE futures_positions
  ADD COLUMN IF NOT EXISTS collateral_asset VARCHAR(20) NOT NULL DEFAULT 'FUTURES_USDT',
  ADD COLUMN IF NOT EXISTS maintenance_margin_rate NUMERIC(36, 18) NOT NULL DEFAULT '0.005';

-- 2. Add epoch column to futures_funding_history for idempotent funding settlement
ALTER TABLE futures_funding_history
  ADD COLUMN IF NOT EXISTS epoch BIGINT;

-- Create a unique index on (symbol, epoch) to prevent double funding for the same epoch
CREATE UNIQUE INDEX IF NOT EXISTS uq_futures_funding_epoch
  ON futures_funding_history (symbol, epoch)
  WHERE epoch IS NOT NULL;

-- 3. Add access_denied status for the new liquidation authorization error
-- (No enum change needed — we throw a typed error, not a DB status)