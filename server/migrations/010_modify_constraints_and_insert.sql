-- Migration 010: Modify constraints and insert ADL Suspense Account

ALTER TABLE wallet_balances DROP CONSTRAINT IF EXISTS wallet_balances_available_balance_check;
ALTER TABLE wallet_balances ADD CONSTRAINT wallet_balances_available_balance_check 
    CHECK (available_balance >= 0 OR account_id = '22222222-2222-2222-2222-222222222222');

INSERT INTO accounts (id, user_id, type, created_at, updated_at)
VALUES (
    '22222222-2222-2222-2222-222222222222',
    '00000000-0000-0000-0000-000000000000', 
    'SYSTEM_ADL_SUSPENSE',
    NOW(),
    NOW()
) ON CONFLICT (user_id, type) DO NOTHING;

ALTER TABLE futures_adl_events ALTER COLUMN counterparty_account_id DROP NOT NULL;
ALTER TABLE futures_adl_events ALTER COLUMN reduced_quantity DROP NOT NULL;
ALTER TABLE futures_adl_events ALTER COLUMN execution_price DROP NOT NULL;
ALTER TABLE futures_adl_events ADD COLUMN IF NOT EXISTS counterparty_position_id UUID REFERENCES futures_positions(id);

ALTER TABLE futures_adl_events ADD COLUMN IF NOT EXISTS status adl_event_status NOT NULL DEFAULT 'PENDING';
ALTER TABLE futures_adl_events ADD COLUMN IF NOT EXISTS target_deficit NUMERIC(36, 18) NOT NULL DEFAULT 0;
ALTER TABLE futures_adl_events ADD COLUMN IF NOT EXISTS resolved_deficit NUMERIC(36, 18) NOT NULL DEFAULT 0;
