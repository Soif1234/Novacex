-- Migration 032: Unique (account_id, client_order_id) on orders (Phase 0F-B)
--
-- P1-1 / Criterion 4: clientOrderId must be DB-idempotent.
--
-- The in-memory database has always enforced UNIQUE(account_id, client_order_id)
-- via an internal map. Real PostgreSQL had NO such constraint, so two concurrent
-- placeOrder calls with the same clientOrderId could both insert rows and then
-- diverge from the in-memory idempotency semantics (and from the app-level
-- idempotent-replay path in FuturesService.placeOrder).
--
-- This migration closes that gap by adding a partial UNIQUE index over
-- (account_id, client_order_id) where client_order_id IS NOT NULL (clientOrderId
-- is optional). Duplicate concurrent inserts then fail with a unique violation
-- (23505), which placeOrder surfaces as a ReferenceConflictError / idempotent
-- replay, matching exactly-once semantics.

CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_account_client_order_id
  ON orders (account_id, client_order_id)
  WHERE client_order_id IS NOT NULL;
