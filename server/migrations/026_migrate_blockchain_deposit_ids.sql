-- Migration 024: Migrate Blockchain Deposit IDs (P1-C Correction)
--
-- Safely recalculates deterministic primary keys for historical EVM deposits
-- to prevent native/ERC20 identity collisions and double-crediting.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Create a temporary mapping table to safely establish the old -> new ID relationship
CREATE TEMP TABLE id_migration_map (
    old_id VARCHAR(255) PRIMARY KEY,
    new_id VARCHAR(255) UNIQUE
);

-- 2. Populate mapping for historical NATIVE deposits (EVM only)
INSERT INTO id_migration_map (old_id, new_id)
SELECT
    id,
    encode(digest('NATIVE:' || chain_id || ':' || transaction_hash || ':' || log_index, 'sha256'), 'hex')
FROM blockchain_deposits
WHERE chain_id = 'ethereum' AND token_contract IS NULL;

-- 3. Populate mapping for historical ERC-20 deposits (EVM only)
INSERT INTO id_migration_map (old_id, new_id)
SELECT
    id,
    encode(digest('ERC20:' || chain_id || ':' || transaction_hash || ':' || log_index, 'sha256'), 'hex')
FROM blockchain_deposits
WHERE chain_id = 'ethereum' AND token_contract IS NOT NULL;

-- 4. Drop the foreign key constraint on pending_sweeps to allow ID mutation
ALTER TABLE pending_sweeps DROP CONSTRAINT IF EXISTS pending_sweeps_deposit_id_fkey;

-- 5. Update primary keys in blockchain_deposits
UPDATE blockchain_deposits bd
SET id = map.new_id
FROM id_migration_map map
WHERE bd.id = map.old_id;

-- 6. Update foreign key references in pending_sweeps
UPDATE pending_sweeps ps
SET deposit_id = map.new_id
FROM id_migration_map map
WHERE ps.deposit_id = map.old_id;

-- 7. Re-establish the foreign key constraint
ALTER TABLE pending_sweeps
ADD CONSTRAINT pending_sweeps_deposit_id_fkey
FOREIGN KEY (deposit_id) REFERENCES blockchain_deposits(id);

-- 8. Update embedded references in ledger_transactions (prevent double-credit)
UPDATE ledger_transactions lt
SET reference_id = 'crypto_dep_' || map.new_id
FROM id_migration_map map
WHERE lt.reference_id = 'crypto_dep_' || map.old_id;

-- Clean up the temporary map
DROP TABLE id_migration_map;

COMMIT;
