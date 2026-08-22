-- Migration 012: Create KYC Profiles & AML Compliance Tables

-- 1. Create Enums for KYC Tiers, Statuses, and Document Types
DO $$ BEGIN
    CREATE TYPE kyc_tier AS ENUM ('TIER_0', 'TIER_1', 'TIER_2');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE kyc_status AS ENUM ('UNVERIFIED', 'PENDING_REVIEW', 'VERIFIED', 'REJECTED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE id_document_type AS ENUM ('PASSPORT', 'DRIVERS_LICENSE', 'NATIONAL_ID');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 2. Create User KYC Profiles Table
CREATE TABLE IF NOT EXISTS user_kyc_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tier kyc_tier NOT NULL DEFAULT 'TIER_0',
    status kyc_status NOT NULL DEFAULT 'UNVERIFIED',
    first_name VARCHAR(128),
    last_name VARCHAR(128),
    date_of_birth DATE,
    nationality VARCHAR(3), -- ISO 3166-1 alpha-3 code (e.g. USA, GBR, IND)
    id_document_type id_document_type,
    id_document_number VARCHAR(128),
    id_document_front_url TEXT,
    id_document_back_url TEXT,
    proof_of_address_url TEXT,
    rejection_reason TEXT,
    reviewer_id UUID REFERENCES users(id),
    submitted_at TIMESTAMPTZ,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Create Sanctioned Addresses Table (AML Blacklist)
CREATE TABLE IF NOT EXISTS sanctioned_addresses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    address VARCHAR(255) UNIQUE NOT NULL,
    asset VARCHAR(32) NOT NULL DEFAULT 'ANY',
    reason VARCHAR(255) NOT NULL,
    source VARCHAR(128) NOT NULL DEFAULT 'OFAC',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Create Performance Indexes
CREATE INDEX IF NOT EXISTS idx_user_kyc_profiles_user_id ON user_kyc_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_kyc_profiles_status ON user_kyc_profiles(status);
CREATE INDEX IF NOT EXISTS idx_user_kyc_profiles_tier ON user_kyc_profiles(tier);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sanctioned_addresses_address ON sanctioned_addresses(address);
