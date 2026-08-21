# MALLICK EXCHANGE / NovaCEX - RESUME STATE

## 1. Project Identity
**Project:** MALLICK EXCHANGE / NovaCEX

## 2. Current Date/Time
**Timestamp:** 2026-08-21T03:34:00+05:30

## 3. Current Phase
**Current Phase:** Phase 6.2 — Market Data / OHLCV K-Line Infrastructure

## 4. Completed Phases
- Phase 1 — UI Foundation
- Phase 2 — Core Exchange Features
- Phase 3 — Client Authority & Mathematical Hardening
- Phase 4 — Authoritative Backend & PostgreSQL
- Phase 5 — Production Liquidity Infrastructure
- Phase 6.1 — Advanced Order Types / Conditional Execution
- Phase 6.2 — Market Data / OHLCV K-Line Infrastructure

## 5. Current Phase Status
**Status:** COMPLETE. 
Phase 6.2 implemented the authoritative event-driven OHLCV / K-line aggregation engine with PostgreSQL persistence (migration 007), concurrent multi-trade race condition locks, duplication tracking, and precise temporal isolation for 1m, 5m, 1h, 1d boundaries.

## 6. Next Phase
**Next Authorized Phase:** Phase 6.3 — Adaptive Funding Engine

## 7. Complete Phase 1 Summary
Phase 1 established the UI foundation, responsive interface layouts, component design systems, charting interfaces, order books, and primary frontend infrastructure to support the exchange web application.

## 8. Complete Phase 2 Summary
Phase 2 implemented the core exchange functionality including the foundational Spot matching engine simulations, WebSocket real-time market data flows in the frontend, order creation, user balance tracking, and the integration of basic authentication and authorization.

## 9. Complete Phase 3 Summary
Phase 3 hardened the client authority layer and the mathematics driving the exchange. Focused closely on decimal precision standards using libraries like exact-math/big.js, eliminating floating-point errors, validating balance constraints prior to matching, protecting order books from bad math, and ensuring that no order is executed without proper collateral authorization.

## 10. Complete Phase 4 Summary
Phase 4 built the authoritative backend on PostgreSQL. Implemented the strict double-entry ledger accounting, true Futures/Spot engine state isolation, persistent orders/trades with SQL transactions, event-driven internal architectures (Event Bus for decoupled services), and robust Websocket server clusters tracking user subscriptions securely. 

## 11. Complete Phase 5 Summary
Phase 5 introduced the Production Liquidity Infrastructure. Implemented the Hyperliquid hybrid execution adapter layer, Smart Order Router (SOR) for dynamic inventory management, reconciliation worker routines, external execution state machines, exposure stores, and fail-open redis safety limits. *Note: Hyperliquid remains strictly SIMULATION ONLY.*

## 12. Phase 6.1 Summary
Phase 6.1 introduced Advanced Order Types / Conditional Execution. Added database schema `006_add_conditional_orders.sql`. Supported SL/TP conditionals and trigger logic evaluated continuously against real-time LTP changes in the event bus, seamlessly submitting to the Spot/Futures matching engines when conditions are met.

## 13. Phase 6.2 Summary
Phase 6.2 introduced Market Data / OHLCV K-Line Infrastructure. Added database schema `007_create_k_lines_market_data.sql`. Generates perfectly aligned historical and real-time K-lines (1m, 5m, 1h, 1d) entirely from authoritative trades, utilizing map-based locks for thread-safety and delayed timestamp normalization to secure correct CLOSE prices when processing out-of-order market events. 

## 14. Phase 6.3 Planned Work
**Scope (DO NOT IMPLEMENT YET):** Adaptive Funding Engine
Must investigate existing Phase 4 funding implementations first. Planned areas include Mark Price calculations, Index Price feeds, Premium Index derivations, funding rate interval calculations, dynamic caps/floors, automated continuous funding settlement mechanics, long/short balance transfers without locking the ledger, process restart recovery for funding timestamps, and PostgreSQL persistence.

## 15. Phase 6.4 Planned Work
**Scope:** Liquidation Engine Maturity
Focuses on Insurance Fund mechanics, handling Partial Liquidations, Auto-Deleveraging (ADL) strategies, and establishing related operational risk maturity infrastructure.

## 16. Phase 6.5 Planned Work
**Scope:** Admin & Operational Controls
Focuses on Exchange Circuit Breakers, systemic operational kill-switches, API-based Global Controls, dynamically scaling Fee tiers, and admin portal backing mechanisms.

## 17. Current Architecture
A fully decoupled, event-driven Node.js backend using PostgreSQL for authoritative states, exact-math libraries for financial precision, and an internal Event Bus tracking asynchronous operations to bridge the Websocket gateways, Matchers, and Liquidity services cleanly. 

## 18. Spot Architecture
Authoritative matching engine executing Limit, Market, and Conditional orders directly against an in-memory limit order book (LOB). Changes emit events that persist into `spot_orders` and `spot_trades` in PostgreSQL, triggering exact balance adjustments in the double-entry ledger.

## 19. Futures Architecture
Similar strict limits with margin enforcement and unrealized PnL (UPnL) updates. Cross-margin support and isolated liquidations are supported. Modifying the formulas driving Futures accounting and margin requires explicit manual user review.

## 20. PostgreSQL Architecture
Production-ready state layer acting as the singular source of truth for the ledger, historical trades, orders, conditional triggers, user authentication, and K-Lines. Uses strict foreign-keys and atomic transactions to prevent phantom balances.

## 21. WebSocket Architecture
Pub-sub multiplexed WebSocket gateways that push private execution reports to authenticated clients (filtered by multi-tab sessions securely) and broadcast high-frequency public real-time market data (orderbooks, tickers, trades).

## 22. Liquidity Architecture
Hybrid simulated execution model relying on local inventory thresholds routing overflow and hedge orders to external LP networks via an intelligent SOR (Smart Order Router) adapter hierarchy.

## 23. Hyperliquid Architecture
An adapter configured as the primary simulated LP. **Hyperliquid Mode is SIMULATION_ONLY.** No mainnet credentials or actual capital flows are present. Built defensively to easily swap to Mainnet in the future via configurations without refactoring internal structures.

## 24. Persistence Semantics
True production persistence lies within the PostgreSQL layer. *Critical Note:* `InMemoryExposureStore` used in the Liquidity layer is `EPHEMERAL_SINGLE_NODE` and does NOT survive process restarts. The `IExposureStore` abstraction exists to support durable scaling later.

## 25. Security Architecture
Standard security protocols (Bcrypt, JWT) with a strict fail-open Redis rate limiting module for authentication and public endpoints. Ledger integrity relies entirely on atomic transactions, avoiding overlapping asynchronous data mutations. 

## 26. Database Migrations
Migrations present and verified in `server/migrations/`:
- `001_create_users_and_auth.sql`
- `002_create_accounts_and_wallets.sql`
- `003_create_double_entry_ledger.sql`
- `004_create_spot_orders_and_trades.sql`
- `005_create_futures_orders_and_positions.sql`
- `006_add_conditional_orders.sql`
- `007_create_k_lines_market_data.sql`

## 27. Test Status
Project regression tests: 603 / 603 PASS.
Phase 6.2 K-Line isolation tests: 7 / 7 PASS.

## 28. TypeScript Status
Type-checking compilation (`npx tsc --noEmit`): PASS (0 Errors).

## 29. Build Status
Production build compilation (`npm run build`): PASS.

## 30. Git Status
**Branch:** main
**Current Commit:** `d2123dd docs: consolidate Phase 1-5 project status and deployment`
**Working Tree Status:** Dirty (Uncommitted changes exist)
**Uncommitted Modified Files:**
- `server/src/config/database.ts`
- `server/src/models/order.model.ts`
- `server/src/server.ts`
- `server/src/services/futures/futures.service.ts`
- `server/src/services/spot/spot.service.ts`

**Untracked Files:**
- `docs/PHASE_6_CURRENT_STATE_AUDIT.md`
- `docs/PHASE_6_ROADMAP.md`
- `fix_log.cjs`
- `fix_mapping.cjs`
- `futures.trigger.ts`
- `server/migrations/006_add_conditional_orders.sql`
- `server/migrations/007_create_k_lines_market_data.sql`
- `server/src/services/market/conditional.service.ts`
- `server/src/services/market/kline.service.ts`
- `server/tests/kline.test.ts`
- `spot.trigger.ts`

## 31. Known Limitations
- Hyperliquid API requests remain heavily simulated. Real LP volume does not execute against live mainnet orderbooks.
- The `InMemoryExposureStore` lacks production reliability and distributed cross-node support.
- Circuit breakers and dynamic operational controls are missing (slated for Phase 6.5).

## 32. Known Unresolved Issues
No unresolved blocking issues remain in Phase 6.2. 

## 33. Rules that must not be violated
- **FINANCIAL LOGIC:** Do NOT modify Spot matching mathematics, Futures PnL, margin calculations, liquidation formulas, funding formulas, wallet accounting, or double-entry ledger formulas without explicit manual authorization. Phase 4 mathematical implementations are frozen.
- **LP REALITY:** Hyperliquid MUST remain in `SIMULATION_ONLY`. No real capital may be exposed.
- **DATA INTEGRITY:** Historical datasets must be purely derived from authoritative LTP/trade realities; no second source of truth.

## EXACT RESUME POINT

Phase 6.2 is complete. 
Phase 6.3 has NOT started. 
The next authorized implementation is Phase 6.3 — Adaptive Funding Engine.

Before Phase 6.3 begins, you **must** comprehensively inspect the existing Phase 4 funding implementations (and related ledger updates) in the repository to establish the baseline baseline mechanism. Do not overwrite or alter Phase 4 accounting logic blindly.
