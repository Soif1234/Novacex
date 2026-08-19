-- Migration 002: Create Accounts, Assets, and Wallet Balances

DO $$ BEGIN
    CREATE TYPE account_type AS ENUM ('SPOT', 'FUTURES', 'FUNDING', 'SYSTEM_VAULT');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 1. Accounts Table (Sub-accounts per user)
CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type account_type NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, type)
);
CREATE INDEX IF NOT EXISTS idx_accounts_user_type ON accounts(user_id, type);

-- 2. Assets Registry Table
CREATE TABLE IF NOT EXISTS assets (
    symbol VARCHAR(20) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    decimals INT NOT NULL DEFAULT 8,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_fiat BOOLEAN NOT NULL DEFAULT FALSE,
    min_withdrawal_amount NUMERIC(36, 18) DEFAULT 0,
    withdrawal_fee NUMERIC(36, 18) DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default initial assets
INSERT INTO assets (symbol, name, decimals, is_active, is_fiat) VALUES
    ('USDT', 'Tether USD', 8, true, false),
    ('USDC', 'USD Coin', 8, true, false),
    ('BTC', 'Bitcoin', 8, true, false),
    ('ETH', 'Ethereum', 8, true, false),
    ('SOL', 'Solana', 8, true, false),
    ('XRP', 'Ripple', 8, true, false),
    ('DOGE', 'Dogecoin', 8, true, false),
    ('FUTURES_USDT', 'Futures Collateral USDT', 8, true, false)
ON CONFLICT (symbol) DO NOTHING;

-- 3. Wallet Balances Table (Per-Account, Per-Asset Available and Locked Balances)
CREATE TABLE IF NOT EXISTS wallet_balances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    asset VARCHAR(20) NOT NULL REFERENCES assets(symbol),
    available_balance NUMERIC(36, 18) NOT NULL DEFAULT 0 CHECK (available_balance >= 0),
    locked_balance NUMERIC(36, 18) NOT NULL DEFAULT 0 CHECK (locked_balance >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(account_id, asset)
);
CREATE INDEX IF NOT EXISTS idx_wallet_balances_account ON wallet_balances(account_id);
