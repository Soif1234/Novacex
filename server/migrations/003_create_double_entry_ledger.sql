-- Migration 003: Create Double-Entry Ledger and Fund Flow Transactions

DO $$ BEGIN
    CREATE TYPE ledger_tx_type AS ENUM (
        'DEPOSIT',
        'WITHDRAWAL',
        'INTERNAL_TRANSFER',
        'SPOT_ORDER_LOCK',
        'SPOT_ORDER_UNLOCK',
        'SPOT_TRADE_SETTLE',
        'FUTURES_MARGIN_LOCK',
        'FUTURES_MARGIN_RELEASE',
        'FUTURES_PNL_REALIZED',
        'FUTURES_FUNDING_PAYMENT',
        'FUTURES_LIQUIDATION',
        'TRADING_FEE'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE entry_direction AS ENUM ('CREDIT', 'DEBIT');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE transfer_status AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'REJECTED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 1. Ledger Transactions Table (Atomic business event wrapper)
CREATE TABLE IF NOT EXISTS ledger_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    transaction_type ledger_tx_type NOT NULL,
    reference_id VARCHAR(128) NOT NULL, -- Idempotency Key
    description TEXT NOT NULL,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(account_id, reference_id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_tx_account_created ON ledger_transactions(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_tx_ref ON ledger_transactions(reference_id);

-- 2. Ledger Entries Table (Double-entry journal lines)
CREATE TABLE IF NOT EXISTS ledger_entries (
    id BIGSERIAL PRIMARY KEY,
    transaction_id UUID NOT NULL REFERENCES ledger_transactions(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    asset VARCHAR(20) NOT NULL REFERENCES assets(symbol),
    direction entry_direction NOT NULL,
    amount NUMERIC(36, 18) NOT NULL CHECK (amount > 0),
    balance_after NUMERIC(36, 18) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_account_asset ON ledger_entries(account_id, asset, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_tx ON ledger_entries(transaction_id);

-- 3. Deposits Table
CREATE TABLE IF NOT EXISTS deposits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id),
    asset VARCHAR(20) NOT NULL REFERENCES assets(symbol),
    amount NUMERIC(36, 18) NOT NULL CHECK (amount > 0),
    status transfer_status NOT NULL DEFAULT 'COMPLETED',
    tx_hash VARCHAR(128),
    ledger_tx_id UUID REFERENCES ledger_transactions(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deposits_account ON deposits(account_id, created_at DESC);

-- 4. Withdrawals Table
CREATE TABLE IF NOT EXISTS withdrawals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id),
    asset VARCHAR(20) NOT NULL REFERENCES assets(symbol),
    amount NUMERIC(36, 18) NOT NULL CHECK (amount > 0),
    fee NUMERIC(36, 18) NOT NULL DEFAULT 0 CHECK (fee >= 0),
    status transfer_status NOT NULL DEFAULT 'PENDING',
    destination_address TEXT NOT NULL,
    tx_hash VARCHAR(128),
    ledger_tx_id UUID REFERENCES ledger_transactions(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_account ON withdrawals(account_id, created_at DESC);

-- 5. Internal Transfers Table (Cross-wallet transfers e.g. SPOT <-> FUTURES)
CREATE TABLE IF NOT EXISTS internal_transfers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    from_account_id UUID NOT NULL REFERENCES accounts(id),
    to_account_id UUID NOT NULL REFERENCES accounts(id),
    asset VARCHAR(20) NOT NULL REFERENCES assets(symbol),
    amount NUMERIC(36, 18) NOT NULL CHECK (amount > 0),
    status transfer_status NOT NULL DEFAULT 'COMPLETED',
    ledger_tx_id UUID REFERENCES ledger_transactions(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_internal_transfers_user ON internal_transfers(user_id, created_at DESC);
