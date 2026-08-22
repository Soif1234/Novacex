# MALLICK EXCHANGE — PHASE 6.4B ADL POLICY

**Status:** POLICY DEFINITION ONLY
**Implementation:** NOT STARTED
**Database Migration:** NOT STARTED
**Git Commit:** NONE
**Git Push:** NONE

## APPROVED POLICY #1 — LEDGER INTERLEAVING
**Option C: SYSTEM_ADL_SUSPENSE** is formally **APPROVED**.

- **SYSTEM_VAULT** will track permanent Insurance Fund (IF) capital. It retains the strict non-negative invariant (`available_balance >= 0`).
- **SYSTEM_ADL_SUSPENSE** is a new, dedicated account designed exclusively to represent unresolved systemic debt. It is permitted to carry a negative balance.
- **Safety Invariants**:
  1. No ordinary user wallet may become negative.
  2. No money may be created/destroyed.
  3. All systemic debt is explicitly recorded in Suspense.
  4. Core liquidation and ADL remain strictly separated, asynchronous domains.
  5. Phase 4 PnL and Margin math remain locked and untouched.

---

## UNRESOLVED POLICIES

### A. Exact ADL trigger rule
- **Proposed Rule**: When a liquidation's total deficit exceeds the `SYSTEM_VAULT` available balance, the `SYSTEM_VAULT` is drained to precisely `0`. The exact remaining difference is recorded as a `DEBIT` to `SYSTEM_ADL_SUSPENSE`, inherently triggering the asynchronous ADL worker.
- **Financial Consequence**: Ensures the IF is fully utilized before ADL is invoked, shielding users from unnecessary ADL as long as insurance capital exists.
- **Ambiguity**: Should the system preserve a minimum IF buffer instead of draining it to 0? Does triggering ADL require a minimum suspense debt threshold to prevent micro-ADLs?
- **Status**: REQUIRES AUTHORIZATION

### B. ADL ranking formula
- **Proposed Rule**: Counterparties are ranked by Return on Equity (ROE) multiplied by Leverage: `(Unrealized PnL / Initial Margin) * Leverage`. 
- **Financial Consequence**: Prioritizes highly leveraged, highly profitable traders, aligning ADL with market-risk outperformance. 
- **Ambiguity**: Is the multiplier strictly necessary, or should ranking rely purely on PnL? 
- **Status**: REQUIRES AUTHORIZATION

### C. Maximum counterparty reduction rule
- **Proposed Rule**: A counterparty is reduced *only* by the exact fractional quantity required to cover the current Suspense deficit, leaving the remainder of their position OPEN.
- **Financial Consequence**: Minimizes disruption to profitable traders by extracting only the mathematically required system debt.
- **Ambiguity**: What is the policy if the calculated fraction results in an economically unviable "dust" position? (e.g., leaving a user with $0.50 of BTC). Should there be a minimum reduction threshold?
- **Status**: REQUIRES AUTHORIZATION

### D. ADL execution price
- **Proposed Rule**: Counterparties are closed at the exact **Bankruptcy Price** of the originally liquidated user (not the current Mark Price).
- **Financial Consequence**: Mathematically guarantees zero-sum accounting. Every dollar of unrealized profit subtracted from the counterparty matches exactly one dollar of deficit in the Suspense account. No money is printed or destroyed.
- **Ambiguity**: How is the original bankruptcy price passed to the ADL worker? Does the `SYSTEM_ADL_SUSPENSE` debt need to be strictly grouped by individual bankruptcies, or is it pooled?
- **Status**: REQUIRES AUTHORIZATION

### E. Counterparty eligibility rules
- **Proposed Rule**: To be eligible for ADL, a position must be: `status = 'OPEN'`, mathematically opposite in `side` to the bankrupt position, trading the exact same `symbol`, and currently possessing a net-positive Unrealized PnL.
- **Financial Consequence**: Ensures only profitable counterparties on the correct side of the order book are reduced.
- **Ambiguity**: Are specific margin modes (e.g., CROSS margin) excluded from ADL? Must the position exceed a minimum size or profitability threshold to be eligible?
- **Status**: REQUIRES AUTHORIZATION

### F. Required database schema changes
- **Proposed Rule**: 
  1. Add `SYSTEM_ADL_SUSPENSE` to `account_type` ENUM.
  2. Add `counterparty_position_id UUID REFERENCES futures_positions(id)` to `futures_adl_events`.
  3. Modify `wallet_balances` constraints to permit negative balances *only* for `SYSTEM_ADL_SUSPENSE`.
- **Financial Consequence**: Enforces strict relational integrity for hedge-mode compatibility and provides the database-level support required for Option C.
- **Ambiguity**: Are there additional tracking columns required for ADL state management?
- **Status**: REQUIRES AUTHORIZATION

### G. ADL event lifecycle/state machine
- **Proposed Rule**: An ADL event transitions from `QUEUED` -> `PROCESSING` -> `SETTLED` (or `FAILED`). The event is created atomically during the bankrupt user's liquidation.
- **Financial Consequence**: Provides precise auditability of system debt, allowing real-time monitoring of unresolved deficits.
- **Ambiguity**: If an event remains in `FAILED` due to a lack of eligible counterparties, does it remain permanently in Suspense? How is terminal insolvency handled?
- **Status**: REQUIRES AUTHORIZATION

### H. ADL restart/idempotency strategy
- **Proposed Rule**: Worker idempotent reference string: `FUTURES-ADL-${eventId}-${counterpartyPositionId}-${new Date(counterpartyPos.updatedAt).getTime()}`.
- **Financial Consequence**: Secures the ADL ledger against duplicate processing. A worker crash mid-ADL will trigger a Postgres rollback, reverting the counterparty's `updatedAt` and safely enabling exact retry execution.
- **Ambiguity**: None identified; this precisely maps to the proven Phase 6.4A architecture.
- **Status**: REQUIRES AUTHORIZATION

---

**PHASE 6.4B IMPLEMENTATION GATE:**
BLOCKED until all financial-policy decisions are explicitly authorized.
