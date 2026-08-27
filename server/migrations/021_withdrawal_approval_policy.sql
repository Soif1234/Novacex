-- Migration 021: Withdrawal Approval Policy

ALTER TABLE withdrawals
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_reason TEXT;
