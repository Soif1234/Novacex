# PHASE 6 ROADMAP — ADVANCED EXCHANGE OPERATIONS

## Objective
To mature the internal mechanisms of Mallick Exchange by introducing conditional executions, historical OHLCV market data aggregation, adaptive funding mechanics, advanced liquidation protections, and operational admin controls.

All Phase 6 operations strictly build upon the frozen Phase 4 authoritative math and Phase 5 simulated liquidity structures. **No real capital or mainnet credentials will be used.**

---

## Sub-Phases

### 6.1 Advanced Order Types (Conditional Execution)
* **Goal:** Activate `STOP_LIMIT` and `TAKE_PROFIT_LIMIT` capabilities within the exchange.
* **Scope:** 
  * Implement an active trigger-watch queue for unactivated conditional orders.
  * Emit triggered orders directly to the matching engine / external adapter.
  * Guarantee idempotent triggering logic.

### 6.2 Market Data Infrastructure (OHLCV K-Lines)
* **Goal:** Provide accurate historical candlestick data for the frontend chart integration.
* **Scope:** 
  * Develop a background worker that consumes internal trade events (both Spot and Futures) to generate standard OHLCV K-lines (1m, 5m, 1h, 1d).
  * Persist K-lines to PostgreSQL.
  * Expose an efficient HTTP endpoint for chart initialization.

### 6.3 Adaptive Funding Engine
* **Goal:** Replace hardcoded `0.01%` funding rates with algorithmic index-based derivations.
* **Scope:**
  * Calculate Premium Index based on current Mark Price vs. mock Index Price.
  * Calculate adaptive funding rates.
  * Track and store funding history in PostgreSQL to enable robust rate historical charts.

### 6.4 Liquidation Engine Maturity
* **Goal:** Protect the exchange from extreme volatility insolvency.
* **Scope:**
  * **Insurance Fund:** Activate the stubbed `insuranceFundDelta` logic. Route excess margin to a dedicated insurance account rather than vaporizing it.
  * **Partial Liquidations:** Step-wise margin reduction rather than 100% position closures.
  * **ADL (Auto-Deleveraging):** (Optional/Stretch) Safely deleverage profitable counter-parties if the Insurance Fund depletes.

### 6.5 Admin & Operational Controls
* **Goal:** Enable basic exchange integrity operations without direct DB mutation.
* **Scope:**
  * **Circuit Breakers:** Endpoint to globally halt matching or deposits/withdrawals during simulated severe volatility.
  * **Configuration Management:** Dynamically adjust trading pair fee tiers and Maker/Taker rates without a server restart.
  * **Authorization:** Strict role-based JWT validation for the `admin` scope.

---

## Tracking & Execution Rules

* **Dependencies:** None. All Phase 6 sub-phases rely purely on Phase 4/5 being fully functional.
* **Database Safety:** Sub-phases 6.2 (K-lines) and 6.3 (Funding History) will explicitly require schema migrations. Any migration will be formally requested and authorized before application to prevent regressions.
* **Financial Safety:** The ledger's double-entry integrity must be mathematically upheld during Insurance Fund and Partial Liquidation tests. Phase 4 matching algorithms will strictly not be modified, only wrapped.
* **Testing:** 100% integration testing required per sub-phase. Full `vitest` regression sweeps before completing any sub-phase.

---

## Current Status
* **6.1 Advanced Order Types**: `[PENDING]` (Next Task)
* **6.2 Market Data Infrastructure**: `[PENDING]`
* **6.3 Adaptive Funding Engine**: `[PENDING]`
* **6.4 Liquidation Engine Maturity**: `[PENDING]`
* **6.5 Admin & Operational Controls**: `[PENDING]`
