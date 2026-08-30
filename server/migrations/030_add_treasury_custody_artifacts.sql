-- Phase 10.4 (unfreeze): Treasury custody boundary
--
-- 1. Dedicated treasury custody artifact store.
--    Structurally SEPARATE from the customer `withdrawal_transactions` table
--    (which carries an FK to withdrawals(id) and belongs to the customer
--    withdrawal lifecycle). Treasury artifacts are keyed by the immutable
--    treasuryIntentId and follow the same safety model as the customer
--    artifacts: exact raw signed bytes persisted BEFORE broadcast, durable
--    nonce reservation, broadcast recovery by rebroadcasting EXACT bytes.
--    ONE logical treasury intent = ONE physical transaction = ONE artifact row
--    (UNIQUE(treasury_intent_id), nonce reuse on retry — never a second tx).
--
-- 2. Physical transaction identity for treasury_transactions:
--    tx_hash MUST be either NULL (intent not yet broadcast) or an actual
--    32-byte blockchain tx hash. UUIDs / client ids / provider references are
--    rejected by the database itself.

CREATE TABLE IF NOT EXISTS treasury_custody_artifacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    treasury_intent_id VARCHAR(255) NOT NULL,
    network VARCHAR(32) NOT NULL,
    network_nonce BIGINT NOT NULL,
    tx_hash VARCHAR(128),
    raw_signed_tx TEXT,
    status VARCHAR(32) NOT NULL DEFAULT 'RESERVING',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_treasury_artifact_intent UNIQUE (treasury_intent_id),
    CONSTRAINT uq_treasury_artifact_tx UNIQUE (network, tx_hash),
    CONSTRAINT ck_treasury_artifact_status CHECK (
        status IN ('RESERVING', 'SIGNED', 'BROADCAST')
    )
);

CREATE INDEX IF NOT EXISTS idx_treasury_artifacts_status
    ON treasury_custody_artifacts(network, status);

-- Phase 10.6R code (manager recovery + monitor updates) writes updated_at on
-- treasury_transactions, but migration 022 never created the column. Adding
-- it here completes that schema (default preserves existing-row semantics).
ALTER TABLE treasury_transactions
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Physical identity guard on the treasury intent/physical table.
ALTER TABLE treasury_transactions
    DROP CONSTRAINT IF EXISTS ck_treasury_tx_hash_identity;
ALTER TABLE treasury_transactions
    ADD CONSTRAINT ck_treasury_tx_hash_identity
    CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-fA-F]{64}$');

ALTER TABLE treasury_transactions
    DROP CONSTRAINT IF EXISTS ck_treasury_tx_status;
ALTER TABLE treasury_transactions
    ADD CONSTRAINT ck_treasury_tx_status
    CHECK (status IN (
        'PENDING', 'SIGNING', 'BROADCAST',
        'CONFIRMED', 'FAILED', 'REORGED', 'RECONCILIATION_REQUIRED'
    ));
