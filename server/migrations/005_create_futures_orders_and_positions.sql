-- Migration 005: Create Futures Positions, Orders, Margin, Funding, and Liquidations

DO $$ BEGIN
    CREATE TYPE position_side AS ENUM ('LONG', 'SHORT');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE position_status AS ENUM ('OPEN', 'CLOSED', 'LIQUIDATED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE margin_mode AS ENUM ('ISOLATED', 'CROSS');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 1. Futures Positions Table
CREATE TABLE IF NOT EXISTS futures_positions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    symbol VARCHAR(30) NOT NULL,
    side position_side NOT NULL,
    quantity NUMERIC(36, 18) NOT NULL CHECK (quantity >= 0),
    entry_price NUMERIC(36, 18) NOT NULL CHECK (entry_price > 0),
    mark_price NUMERIC(36, 18) NOT NULL CHECK (mark_price > 0),
    liquidation_price NUMERIC(36, 18) NOT NULL,
    leverage INT NOT NULL DEFAULT 10 CHECK (leverage >= 1 AND leverage <= 125),
    margin_mode margin_mode NOT NULL DEFAULT 'ISOLATED',
    initial_margin NUMERIC(36, 18) NOT NULL CHECK (initial_margin >= 0),
    maintenance_margin NUMERIC(36, 18) NOT NULL CHECK (maintenance_margin >= 0),
    realized_pnl NUMERIC(36, 18) NOT NULL DEFAULT 0,
    status position_status NOT NULL DEFAULT 'OPEN',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(account_id, symbol, side)
);
CREATE INDEX IF NOT EXISTS idx_futures_positions_account_status ON futures_positions(account_id, status);
CREATE INDEX IF NOT EXISTS idx_futures_positions_symbol ON futures_positions(symbol) WHERE status = 'OPEN';

-- 2. Futures Orders Table (Derivative-specific order extensions)
CREATE TABLE IF NOT EXISTS futures_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    symbol VARCHAR(30) NOT NULL,
    position_side position_side NOT NULL,
    leverage INT NOT NULL DEFAULT 10 CHECK (leverage >= 1 AND leverage <= 125),
    margin_mode margin_mode NOT NULL DEFAULT 'ISOLATED',
    reduce_only BOOLEAN NOT NULL DEFAULT FALSE,
    close_position BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_futures_orders_order ON futures_orders(order_id);

-- 3. Futures TP/SL Configurations Table
CREATE TABLE IF NOT EXISTS futures_tpsl_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    position_id UUID NOT NULL REFERENCES futures_positions(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    symbol VARCHAR(30) NOT NULL,
    position_side position_side NOT NULL,
    take_profit_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    take_profit_price NUMERIC(36, 18),
    stop_loss_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    stop_loss_price NUMERIC(36, 18),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_futures_tpsl_position ON futures_tpsl_configs(position_id);

-- 4. Futures Funding History Table
CREATE TABLE IF NOT EXISTS futures_funding_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    symbol VARCHAR(30) NOT NULL,
    funding_rate NUMERIC(10, 8) NOT NULL,
    mark_price NUMERIC(36, 18) NOT NULL,
    index_price NUMERIC(36, 18),
    settled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_futures_funding_symbol_settled ON futures_funding_history(symbol, settled_at DESC);

-- 5. Futures Liquidations Table
CREATE TABLE IF NOT EXISTS futures_liquidations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    position_id UUID NOT NULL REFERENCES futures_positions(id),
    account_id UUID NOT NULL REFERENCES accounts(id),
    symbol VARCHAR(30) NOT NULL,
    side position_side NOT NULL,
    quantity NUMERIC(36, 18) NOT NULL,
    bankruptcy_price NUMERIC(36, 18) NOT NULL,
    liquidation_price NUMERIC(36, 18) NOT NULL,
    loss_amount NUMERIC(36, 18) NOT NULL,
    insurance_fund_delta NUMERIC(36, 18) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_futures_liquidations_account ON futures_liquidations(account_id, created_at DESC);
