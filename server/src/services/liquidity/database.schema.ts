/**
 * Database Schema Definitions for Phase 10.5 Step 10.5-4
 * Durable Fill Idempotency & Reconciliation Tracking.
 */

export const LiquiditySchema = `
  -- Track the intent to hedge internally
  CREATE TABLE IF NOT EXISTS hedge_intents (
    hedge_intent_id VARCHAR(128) PRIMARY KEY,
    market VARCHAR(32) NOT NULL,
    side VARCHAR(16) NOT NULL,
    requested_quantity NUMERIC(36,18) NOT NULL,
    remaining_quantity NUMERIC(36,18) NOT NULL,
    target_exposure NUMERIC(36,18) NOT NULL,
    reason VARCHAR(64) NOT NULL,
    status VARCHAR(64) NOT NULL,
    cloid VARCHAR(66) NOT NULL UNIQUE,
    external_order_id VARCHAR(128),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  );

  -- Track actual venue orders generated from intents
  CREATE TABLE IF NOT EXISTS external_orders (
    cloid VARCHAR(66) PRIMARY KEY,
    venue_order_id VARCHAR(128) NOT NULL,
    hedge_intent_id VARCHAR(128) REFERENCES hedge_intents(hedge_intent_id),
    venue VARCHAR(64) NOT NULL,
    status VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  );

  -- Track durable executions (P2-3 Idempotency)
  CREATE TABLE IF NOT EXISTS external_fills (
    id SERIAL PRIMARY KEY,
    venue VARCHAR(64) NOT NULL,
    fill_id VARCHAR(128) NOT NULL,
    cloid VARCHAR(66) REFERENCES external_orders(cloid),
    external_order_id VARCHAR(128) NOT NULL,
    market VARCHAR(32) NOT NULL,
    side VARCHAR(16) NOT NULL,
    quantity NUMERIC(36,18) NOT NULL,
    price NUMERIC(36,18) NOT NULL,
    fee NUMERIC(36,18) NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    UNIQUE(venue, fill_id) -- P2-3: Idempotent restart safety
  );

  -- Track reconciliation state for house positions
  CREATE TABLE IF NOT EXISTS venue_positions (
    venue VARCHAR(64) NOT NULL,
    market VARCHAR(32) NOT NULL,
    actual_position NUMERIC(36,18) NOT NULL,
    target_position NUMERIC(36,18) NOT NULL,
    last_reconciled_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (venue, market)
  );
`;
