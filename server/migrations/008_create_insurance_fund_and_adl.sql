-- Migration 008: Create Insurance Fund and ADL Tables

-- 1. Create a dedicated SYSTEM_BOT user if it doesn't exist
INSERT INTO users (id, email, role, account_status, created_at, updated_at)
VALUES (
    '00000000-0000-0000-0000-000000000000',
    'system.bot@novacex.io',
    'SYSTEM_BOT',
    'ACTIVE',
    NOW(),
    NOW()
) ON CONFLICT (email) DO NOTHING;

-- 2. Create the SYSTEM_VAULT account for the Insurance Fund
INSERT INTO accounts (id, user_id, type, created_at, updated_at)
VALUES (
    '11111111-1111-1111-1111-111111111111',
    '00000000-0000-0000-0000-000000000000',
    'SYSTEM_VAULT',
    NOW(),
    NOW()
) ON CONFLICT (user_id, type) DO NOTHING;

-- 3. Create ADL Events tracking table
CREATE TABLE IF NOT EXISTS futures_adl_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    liquidation_id UUID NOT NULL REFERENCES futures_liquidations(id),
    counterparty_account_id UUID NOT NULL REFERENCES accounts(id),
    symbol VARCHAR(20) NOT NULL,
    side VARCHAR(10) NOT NULL,
    reduced_quantity NUMERIC(36, 18) NOT NULL,
    execution_price NUMERIC(36, 18) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_futures_adl_events_account ON futures_adl_events(counterparty_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_futures_adl_events_liquidation ON futures_adl_events(liquidation_id);
