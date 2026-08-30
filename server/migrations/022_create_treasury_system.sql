-- Phase 10.6: Treasury System
BEGIN;

CREATE TABLE treasury_config (
    id SERIAL PRIMARY KEY,
    network VARCHAR(50) NOT NULL,
    chain_id VARCHAR(50) NOT NULL,
    safe_address VARCHAR(255) NOT NULL,
    owner_address VARCHAR(255) NOT NULL,
    threshold INT NOT NULL DEFAULT 1,
    low_water_usd DECIMAL(30,10) NOT NULL DEFAULT 0,
    high_water_usd DECIMAL(30,10) NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_treasury_network UNIQUE (network)
);

CREATE TABLE treasury_transactions (
    id SERIAL PRIMARY KEY,
    network VARCHAR(50) NOT NULL,
    chain_id VARCHAR(50) NOT NULL,
    asset VARCHAR(20) NOT NULL,
    token_contract VARCHAR(255),
    source_address VARCHAR(255) NOT NULL,
    destination_address VARCHAR(255) NOT NULL,
    amount DECIMAL(65,0) NOT NULL, -- exact base unit
    tx_hash VARCHAR(255) NOT NULL,
    log_index INT NOT NULL DEFAULT 0,
    block_number BIGINT NOT NULL,
    block_hash VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL, -- PENDING, CONFIRMED, FAILED, REORGED, RECONCILIATION_REQUIRED
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    confirmed_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT uq_treasury_tx UNIQUE (network, tx_hash, log_index)
);

CREATE TABLE treasury_reconciliation_events (
    id SERIAL PRIMARY KEY,
    event_id VARCHAR(255) NOT NULL,
    treasury_network VARCHAR(50) NOT NULL,
    expected_state JSONB,
    actual_state JSONB,
    reason TEXT NOT NULL,
    tx_hash VARCHAR(255),
    status VARCHAR(50) NOT NULL, -- OPEN, RESOLVED
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT uq_treasury_reconciliation_event UNIQUE (event_id)
);

COMMIT;
