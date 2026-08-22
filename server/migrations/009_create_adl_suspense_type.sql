-- Migration 009: Create ADL Suspense Account Type

ALTER TYPE account_type ADD VALUE IF NOT EXISTS 'SYSTEM_ADL_SUSPENSE';

DO $$ BEGIN
    CREATE TYPE adl_event_status AS ENUM ('PENDING', 'PROCESSING', 'PARTIALLY_SETTLED', 'SETTLED', 'FAILED', 'UNRESOLVED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
