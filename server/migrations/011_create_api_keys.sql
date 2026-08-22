-- Migration 011: Create API Keys & Permissions Table

-- 1. Create Enum Types for Key Statuses
DO $$ BEGIN
    CREATE TYPE api_key_status AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 2. Create API Keys Table
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_id VARCHAR(64) UNIQUE NOT NULL,
    secret_hash VARCHAR(64) NOT NULL,
    encrypted_secret TEXT NOT NULL,
    secret_preview VARCHAR(16) NOT NULL,
    label VARCHAR(128) NOT NULL,
    permissions TEXT[] NOT NULL DEFAULT '{"READ"}',
    ip_whitelist TEXT[] NOT NULL DEFAULT '{}',
    status api_key_status NOT NULL DEFAULT 'ACTIVE',
    last_used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Create High-Performance Indexes
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key_id ON api_keys(key_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(key_id) WHERE status = 'ACTIVE';
