-- Migration 004: Create Trading Pairs, Spot Orders, and Trades

DO $$ BEGIN
    CREATE TYPE market_type AS ENUM ('SPOT', 'FUTURES');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE order_side AS ENUM ('BUY', 'SELL');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE order_type AS ENUM ('LIMIT', 'MARKET', 'STOP_LIMIT', 'TAKE_PROFIT_LIMIT');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE order_status AS ENUM ('NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 1. Trading Pairs Configuration Table
CREATE TABLE IF NOT EXISTS trading_pairs (
    symbol VARCHAR(30) PRIMARY KEY,
    base_asset VARCHAR(20) NOT NULL REFERENCES assets(symbol),
    quote_asset VARCHAR(20) NOT NULL REFERENCES assets(symbol),
    market_type market_type NOT NULL DEFAULT 'SPOT',
    tick_size NUMERIC(36, 18) NOT NULL DEFAULT '0.01',
    lot_size NUMERIC(36, 18) NOT NULL DEFAULT '0.001',
    min_notional NUMERIC(36, 18) NOT NULL DEFAULT '5.0',
    maker_fee_rate NUMERIC(10, 6) NOT NULL DEFAULT '0.001', -- 0.1%
    taker_fee_rate NUMERIC(10, 6) NOT NULL DEFAULT '0.001', -- 0.1%
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed core pairs
INSERT INTO trading_pairs (symbol, base_asset, quote_asset, market_type, tick_size, lot_size) VALUES
    ('BTCUSDT', 'BTC', 'USDT', 'SPOT', '0.01', '0.0001'),
    ('ETHUSDT', 'ETH', 'USDT', 'SPOT', '0.01', '0.001'),
    ('SOLUSDT', 'SOL', 'USDT', 'SPOT', '0.001', '0.01'),
    ('BTCUSDC', 'BTC', 'USDC', 'SPOT', '0.01', '0.0001')
ON CONFLICT (symbol) DO NOTHING;

-- 2. Orders Table
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_order_id VARCHAR(64),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    market market_type NOT NULL DEFAULT 'SPOT',
    symbol VARCHAR(30) NOT NULL,
    side order_side NOT NULL,
    type order_type NOT NULL,
    price NUMERIC(36, 18),
    quantity NUMERIC(36, 18) NOT NULL CHECK (quantity > 0),
    filled_quantity NUMERIC(36, 18) NOT NULL DEFAULT 0 CHECK (filled_quantity <= quantity),
    remaining_quantity NUMERIC(36, 18) NOT NULL CHECK (remaining_quantity >= 0),
    locked_amount NUMERIC(36, 18) NOT NULL DEFAULT 0 CHECK (locked_amount >= 0),
    locked_asset VARCHAR(20) NOT NULL REFERENCES assets(symbol),
    status order_status NOT NULL DEFAULT 'NEW',
    time_in_force VARCHAR(10) NOT NULL DEFAULT 'GTC',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_account_status ON orders(account_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_symbol_status ON orders(symbol, status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);

-- 3. Trades / Execution Fills Table
CREATE TABLE IF NOT EXISTS trades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    market market_type NOT NULL DEFAULT 'SPOT',
    symbol VARCHAR(30) NOT NULL,
    side order_side NOT NULL,
    price NUMERIC(36, 18) NOT NULL CHECK (price > 0),
    quantity NUMERIC(36, 18) NOT NULL CHECK (quantity > 0),
    quote_quantity NUMERIC(36, 18) NOT NULL CHECK (quote_quantity > 0),
    fee NUMERIC(36, 18) NOT NULL DEFAULT 0 CHECK (fee >= 0),
    fee_asset VARCHAR(20) NOT NULL REFERENCES assets(symbol),
    is_maker BOOLEAN NOT NULL DEFAULT FALSE,
    counterparty_order_id UUID REFERENCES orders(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trades_order ON trades(order_id);
CREATE INDEX IF NOT EXISTS idx_trades_account_created ON trades(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_symbol_created ON trades(symbol, created_at DESC);
