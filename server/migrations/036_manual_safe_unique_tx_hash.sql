-- Migration 036: Phase 11K-B — F1 unique withdrawal tx_hash
--
-- A database-level guarantee that one physical blockchain transaction hash
-- can settle at most one withdrawal. This is enforced by a partial unique
-- index: NULL tx_hash (most rows, not yet confirmed) and empty-string tx_hash
-- are excluded, so only real hashes are unique.
--
-- This is a STRICTLY additive change. No existing table, column, or constraint
-- is dropped or modified. The index is created IF NOT EXISTS, making it safe
-- for repeated application.
CREATE UNIQUE INDEX IF NOT EXISTS uq_withdrawals_tx_hash
ON withdrawals(tx_hash)
WHERE tx_hash IS NOT NULL AND tx_hash <> '';