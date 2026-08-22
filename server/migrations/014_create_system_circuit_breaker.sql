-- Migration 014: Create System Circuit Breaker Table

-- 1. Create Circuit Breaker Mode Enum
DO $$ BEGIN
    CREATE TYPE circuit_breaker_mode AS ENUM (
        'SYSTEM_ACTIVE',
        'HALT_ALL',
        'HALT_TRADING',
        'HALT_WITHDRAWALS',
        'CUSTOM'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 2. Create System Circuit Breakers Table
CREATE TABLE IF NOT EXISTS system_circuit_breakers (
    id VARCHAR(32) PRIMARY KEY DEFAULT 'SYSTEM_GLOBAL',
    mode circuit_breaker_mode NOT NULL DEFAULT 'SYSTEM_ACTIVE',
    is_spot_trading_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    is_futures_trading_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    is_withdrawals_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    is_deposits_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    halt_reason TEXT,
    halted_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Seed Default Active System State
INSERT INTO system_circuit_breakers (
    id, mode, is_spot_trading_enabled, is_futures_trading_enabled, is_withdrawals_enabled, is_deposits_enabled
) VALUES (
    'SYSTEM_GLOBAL', 'SYSTEM_ACTIVE', TRUE, TRUE, TRUE, TRUE
) ON CONFLICT (id) DO NOTHING;
