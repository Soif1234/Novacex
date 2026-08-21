-- Migration 007: Create K-Lines Market Data

CREATE TABLE IF NOT EXISTS k_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    market market_type NOT NULL,
    symbol VARCHAR(30) NOT NULL,
    interval VARCHAR(5) NOT NULL,
    open_time BIGINT NOT NULL,
    close_time BIGINT NOT NULL,
    open_price NUMERIC(36,18) NOT NULL,
    high_price NUMERIC(36,18) NOT NULL,
    low_price NUMERIC(36,18) NOT NULL,
    close_price NUMERIC(36,18) NOT NULL,
    base_volume NUMERIC(36,18) NOT NULL DEFAULT 0,
    quote_volume NUMERIC(36,18) NOT NULL DEFAULT 0,
    trades_count INTEGER NOT NULL DEFAULT 0,
    is_final BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure strict determinism and single-candle-per-interval identity
CREATE UNIQUE INDEX IF NOT EXISTS idx_klines_identity 
ON k_lines(market, symbol, interval, open_time);

-- Allow fast sweeps for finalization checks
CREATE INDEX IF NOT EXISTS idx_klines_close_time 
ON k_lines(is_final, close_time);
