# MALLICK EXCHANGE / NovaCEX - RESUME STATE

## 1. Project Identity
**Project:** MALLICK EXCHANGE / NovaCEX

## 2. Current Date/Time
**Timestamp:** 2026-08-23T00:30:00+05:30

## 3. Current Phase
**Current Phase:** Phase 6 — Advanced Execution, Market Data & Risk Infrastructure (6.1, 6.2, 6.3, 6.4A, 6.4B)

## 4. Completed Phases
- Phase 1 — UI Foundation: **COMPLETE**
- Phase 2 — Core Exchange Features: **COMPLETE**
- Phase 3 — Client Authority & Mathematical Hardening: **COMPLETE**
- Phase 4 — Authoritative Backend & PostgreSQL: **COMPLETE (FROZEN)**
- Phase 5 — Production Liquidity Infrastructure: **COMPLETE (PRESERVED)**
- Phase 6.1 — Advanced Order Types / Conditional Execution: **COMPLETE**
- Phase 6.2 — Market Data / OHLCV K-Line Infrastructure: **COMPLETE**
- Phase 6.3 — Adaptive Funding Engine: **COMPLETE**
- Phase 6.4A — Insurance Fund, Atomic Liquidation & Partial Liquidation: **COMPLETE**
- Phase 6.4B — Auto-Deleveraging (ADL): **COMPLETE**
- Phase 6 Overall: **COMPLETE**

## 5. Current Phase Status
**Status:** COMPLETE.
All sub-phases of Phase 6 are implemented, verified on real PostgreSQL, typechecked, and covered by 100% passing tests.

## 6. Next Phase
**Next Phase:** Phase 7 — NOT STARTED.

## 7. Complete Phase 1 Summary
Phase 1 established the UI foundation, responsive interface layouts, component design systems, charting interfaces, order books, and primary frontend infrastructure to support the exchange web application.

## 8. Complete Phase 2 Summary
Phase 2 implemented the core exchange functionality including the foundational Spot matching engine simulations, WebSocket real-time market data flows in the frontend, order creation, user balance tracking, and the integration of basic authentication and authorization.

## 9. Complete Phase 3 Summary
Phase 3 hardened the client authority layer and the mathematics driving the exchange. Focused closely on decimal precision standards using exact arithmetic libraries, eliminating floating-point errors, validating balance constraints prior to matching, protecting order books from bad math, and ensuring that no order is executed without proper collateral authorization.

## 10. Complete Phase 4 Summary (FROZEN)
Phase 4 built the authoritative backend on PostgreSQL. Implemented strict double-entry ledger accounting, true Futures/Spot engine state isolation, persistent orders/trades with SQL transactions, event-driven internal architectures (Event Bus for decoupled services), and robust WebSocket server clusters tracking user subscriptions securely. Phase 4 financial mathematics (PnL formulas, margin models, liquidation price formulas, ledger conservation) is FROZEN.

## 11. Complete Phase 5 Summary (PRESERVED)
Phase 5 introduced the Production Liquidity Infrastructure. Implemented the Hyperliquid hybrid execution adapter layer, Smart Order Router (SOR) for dynamic inventory management, reconciliation worker routines, external execution state machines, exposure stores, and fail-open redis safety limits. *Note: Hyperliquid remains strictly SIMULATION ONLY.*

## 12. Phase 6.1 Summary
Phase 6.1 introduced Advanced Order Types / Conditional Execution. Added database migration `006_add_conditional_orders.sql`. Supported `STOP_LIMIT` and `TAKE_PROFIT_LIMIT` triggers evaluated continuously against real-time LTP changes on the event bus with startup recovery from database and atomic execution transition.

## 13. Phase 6.2 Summary
Phase 6.2 introduced Market Data / OHLCV K-Line Infrastructure. Added database migration `007_create_k_lines_market_data.sql`. Generates historical and real-time K-lines (`1m`, `5m`, `15m`, `1h`, `4h`, `1d`) entirely from authoritative trades, utilizing map-based locks for thread-safety and out-of-order rejection to guarantee continuous candle integrity.

## 14. Phase 6.3 Summary
Phase 6.3 introduced the Adaptive Funding Engine. Added `FundingWorker` for 8-hour / dynamic funding cycles with dynamic funding rate computed from the Premium Index ($P = (\text{Mark} - \text{Index}) / \text{Index}$) clamped between $[-0.75\%, +0.75\%]$ and bilateral zero-sum settlement between Longs and Shorts.

## 15. Phase 6.4A Summary
Phase 6.4A introduced the Insurance Fund, Atomic Liquidation, and Partial Liquidation. Added database migration `008_create_insurance_fund_and_adl.sql`. Implemented iterative 50% partial liquidation steps, liquidation penalty collection into the Insurance Fund (`11111111-1111-1111-1111-111111111111`), and full liquidation fallback.

## 16. Phase 6.4B Summary
Phase 6.4B rebuilt Auto-Deleveraging (ADL) using the clean Bybit-style perpetual futures model. Triggered only upon Insurance Fund exhaustion, queries profitable opposite positions, ranks by leveraged ROE ($\text{Unrealized PnL} / \text{Initial Margin}$) descending, and closes exact fractional counterparty positions at Bankruptcy Price with atomic double-entry ledger settlement and systemic suspense deficit tracking.

## 17. Current Architecture
A fully decoupled, event-driven Node.js backend using PostgreSQL for authoritative states, exact-math libraries for financial precision, and an internal Event Bus tracking asynchronous operations to bridge the WebSocket gateways, Matchers, and Liquidity services cleanly. 

## 18. Spot Architecture
Authoritative matching engine executing Limit, Market, and Conditional orders directly against an in-memory limit order book (LOB). Changes emit events that persist into `spot_orders` and `spot_trades` in PostgreSQL, triggering exact balance adjustments in the double-entry ledger.

## 19. Futures Architecture
Strict margin enforcement and unrealized PnL updates. Cross-margin and isolated margin support, liquidation escalation, adaptive funding, and ADL. Modifying core Phase 4 financial mathematics is strictly prohibited.

## 20. PostgreSQL Architecture
Production-ready state layer acting as the singular source of truth for the ledger, historical trades, orders, conditional triggers, user authentication, K-Lines, liquidations, insurance fund, and ADL events. Uses strict foreign keys and atomic transactions.

## 21. WebSocket Architecture
Pub-sub multiplexed WebSocket gateways that push private execution reports to authenticated clients and broadcast high-frequency public real-time market data (orderbooks, tickers, trades, candles).

## 22. Liquidity Architecture
Hybrid simulated execution model relying on local inventory thresholds routing overflow and hedge orders to external LP networks via an intelligent SOR (Smart Order Router) adapter hierarchy.

## 23. Hyperliquid Architecture
An adapter configured as the primary simulated LP. **Hyperliquid Mode is SIMULATION_ONLY.** No mainnet credentials or actual capital flows are present.

## 24. Persistence Semantics
True production persistence lies within the PostgreSQL layer. `InMemoryExposureStore` in the Liquidity layer is ephemeral single-node.

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
- `008_create_insurance_fund_and_adl.sql`
- `009_create_adl_suspense_type.sql`
- `010_modify_constraints_and_insert.sql`

## 27. Test Status
- Full vitest suite: **43 / 43 test files passed, 636 / 636 tests passed (100%)**
- PostgreSQL integration test suite: **5 / 5 test files passed, 63 / 63 tests passed (100%)**
- TypeScript compilation: **PASS (0 errors)**
- Backend & Frontend builds: **PASS (0 errors)**
