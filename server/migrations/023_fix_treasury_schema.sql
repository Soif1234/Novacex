-- Phase 10.6C: Treasury schema fix
CREATE TABLE treasury_sync_status (
    network VARCHAR(50) PRIMARY KEY,
    last_block_number BIGINT NOT NULL,
    last_block_hash VARCHAR(66) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE treasury_transactions
ADD COLUMN client_withdrawal_id VARCHAR(255);

CREATE UNIQUE INDEX uq_treasury_client_withdrawal_id ON treasury_transactions (client_withdrawal_id) WHERE client_withdrawal_id IS NOT NULL;

ALTER TABLE treasury_transactions
ALTER COLUMN tx_hash DROP NOT NULL;
