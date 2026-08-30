-- Migration 027: Durable Sweep Intents + Custody Reconciliation Events
-- Phase 10.4 Step 6E-4C-2 corrections (P0/P2).
--
-- 1. sweep_intents: a durable intent row created ATOMICALLY with the hot-wallet
--    nonce reservation. Guarantees that a crash after nonce allocation but
--    before sweep_transactions insertion can never burn a nonce: recovery
--    reuses intent.network_nonce after verifying chain state.
--
-- 2. pending_sweeps.sweep_intent_id: links every logical pending_sweep row
--    participating in a physical sweep attempt to its durable intent.
--
-- 3. custody_reconciliation_events: operational (NON-ledger) record of custody
--    discrepancies: EXTRA_FUNDS, SHORTFALL, ZERO_BALANCE_UNEXPLAINED,
--    STALE_BROADCAST, NONCE_DIVERGENCE. Never touches wallet_balances or
--    ledger_entries.

CREATE TABLE IF NOT EXISTS sweep_intents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    network VARCHAR(32) NOT NULL,
    address VARCHAR(42) NOT NULL,
    asset VARCHAR(32) NOT NULL,
    network_nonce BIGINT NOT NULL,
    -- SIGNING (nonce reserved, no artifact) | SIGNED (artifact persisted)
    -- | BROADCAST | CONFIRMED | FAILED | RECONCILIATION (manual intervention)
    status VARCHAR(32) NOT NULL DEFAULT 'SIGNING',
    sweep_txid VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sweep_intents_group
    ON sweep_intents(network, address, asset, status);

CREATE INDEX IF NOT EXISTS idx_sweep_intents_txid
    ON sweep_intents(sweep_txid) WHERE sweep_txid IS NOT NULL;

ALTER TABLE pending_sweeps
    ADD COLUMN IF NOT EXISTS sweep_intent_id UUID REFERENCES sweep_intents(id);

CREATE TABLE IF NOT EXISTS custody_reconciliation_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    network VARCHAR(32) NOT NULL,
    address VARCHAR(42),
    asset VARCHAR(32),
    kind VARCHAR(64) NOT NULL,
    expected_amount NUMERIC(38, 18),
    physical_amount NUMERIC(38, 18),
    details JSONB,
    status VARCHAR(32) NOT NULL DEFAULT 'OPEN',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_custody_reconciliation_open
    ON custody_reconciliation_events(network, kind, status);
