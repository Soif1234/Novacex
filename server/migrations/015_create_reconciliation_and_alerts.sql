-- Migration 015: Create Reconciliation Reports and Threat Alerts Tables

-- 1. Create Enums
DO $$ BEGIN
    CREATE TYPE threat_alert_severity AS ENUM ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE threat_alert_status AS ENUM ('ACTIVE', 'RESOLVED', 'IGNORED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 2. Create Reconciliation Reports Table
CREATE TABLE IF NOT EXISTS reconciliation_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status VARCHAR(32) NOT NULL DEFAULT 'PASSED',
    accounts_checked INTEGER NOT NULL DEFAULT 0,
    discrepancies_count INTEGER NOT NULL DEFAULT 0,
    details JSONB NOT NULL DEFAULT '[]',
    triggered_by VARCHAR(64) NOT NULL DEFAULT 'SYSTEM_WORKER',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_reports_created_at ON reconciliation_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reconciliation_reports_status ON reconciliation_reports(status);

-- 3. Create Security Threat Alerts Table
CREATE TABLE IF NOT EXISTS security_threat_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    severity threat_alert_severity NOT NULL DEFAULT 'MEDIUM',
    category VARCHAR(64) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    status threat_alert_status NOT NULL DEFAULT 'ACTIVE',
    resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,
    resolution_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_threat_alerts_status ON security_threat_alerts(status);
CREATE INDEX IF NOT EXISTS idx_threat_alerts_severity ON security_threat_alerts(severity);
CREATE INDEX IF NOT EXISTS idx_threat_alerts_created_at ON security_threat_alerts(created_at DESC);
