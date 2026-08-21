-- Migration 006: Add Conditional Orders (Stop-Limit, Take-Profit-Limit)

-- 1. Add UNTRIGGERED to order_status enum
-- In Postgres, ALTER TYPE ADD VALUE cannot run inside a transaction block in older versions, 
-- but we can safely execute it independently.
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'UNTRIGGERED' BEFORE 'NEW';

-- 2. Add stop_price to orders table
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stop_price NUMERIC(36, 18);
