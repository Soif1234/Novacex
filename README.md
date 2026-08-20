# Mallick Exchange

A high-performance, authoritative cryptocurrency exchange platform offering both Spot and Futures trading. Built with a unified hybrid liquidity model, an authoritative financial backend, and strict exposure controls.

## Overview

Mallick Exchange operates on a strict simulation-first development model, currently completing **Phase 1 through Phase 5** of its master roadmap. The platform seamlessly aggregates local liquidity with external provider simulations (Hyperliquid), providing a full end-to-end exchange experience with zero real-money exposure during development.

> **⚠️ CURRENT LIMITATIONS:** Real-money readiness has NOT been completed. The platform is strictly running in a simulated, non-production financial environment. Do not provide real private keys, and do not connect real Hyperliquid mainnet credentials.

## Architecture

The project leverages a modern monorepo-style structure encompassing both a React frontend and a Node.js backend:

- **Frontend:** React, Vite, Zustand (for strict client state), TailwindCSS, TradingView lightweight charts.
- **Backend:** Node.js, Express, PostgreSQL, Redis (auth rate limiting).
- **External Integration (Simulated):** Hyperliquid external provider with hybrid Smart Order Routing (SOR).

### Spot Architecture
- Complete in-memory and PostgreSQL-backed matching engine.
- Price-Time Priority matching.
- Double-entry ledger for atomic wallet balance updates.

### Futures Architecture
- Complete derivatives lifecycle (margin locking, leverage slider integration, mark price calculation).
- Accurate Unrealized/Realized PnL and continuous funding rate exchange.
- Automated liquidation engine for undercollateralized positions.

### Hyperliquid Integration & Production Infrastructure (Phase 5)
Hyperliquid serves as the planned external liquidity provider for BOTH Spot and Futures. Current development strictly utilizes simulation:
- **Hybrid SOR:** Routes orders dynamically to local orderbooks or the simulated Hyperliquid adapter.
- **Exposure/Inventory Protection:** Ephemeral, memory-backed exposure stores preventing overallocation.
- **Reconciliation Engine:** Authoritative snapshots vs external states ensuring zero blind retries on unknown states.
- **Simulation-First:** No real capital, no mainnet network requests, no exposed API keys.

## Phase 1–5 Completion Status

1. **Phase 1 — UI Foundation:** Complete. Grid layouts, dark theme, responsive navigation.
2. **Phase 2 — Core Exchange Features:** Complete. Spot/Futures UI, markets, unified wallets, charting, alerts.
3. **Phase 3 — Client Authority & Hardening:** Complete. Zustand stores, mathematical protections (Big.js), idempotent guards.
4. **Phase 4 — Authoritative Backend & PostgreSQL:** Complete. Layered Node services, PostgreSQL schemas, exact match/pnl/margin formulas, ledger double-entry, WebSocket streams. (Phase 4 financial logic is strictly frozen).
5. **Phase 5 — Production Infrastructure:** Complete. Liquidity domain models, hybrid routers, retry/backoff wrappers, wsbridges, exposure controls, and complete test suites (970+ passing tests).

*(Phase 6: Advanced Exchange Operations is the next scheduled phase).*

## Local Development Instructions

### Prerequisites
- Node.js (v18+)
- PostgreSQL (for Phase 4 backend integration)
- Redis (optional, for rate-limiting simulation)

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/Soif1234/Novacex.git
   cd Novacex
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure Environment Variables:
   Copy the example environment files and configure them (leave external API credentials blank for simulation):
   ```bash
   cp .env.example .env
   cp server/.env.example server/.env
   ```

### Running the Application

To run the full stack locally:
```bash
npm run dev
```

### Test Commands

The project is backed by extensive unit, integration, and End-to-End tests via Vitest:

- **Run all frontend/backend tests (Regression Suite):**
  ```bash
  npx vitest run
  ```
- **Run isolated Phase 5 Liquidity tests:**
  ```bash
  npx vitest run server/tests/liquidity
  ```
- **Run TypeScript compilation checks:**
  ```bash
  npx tsc --noEmit && npx tsc -p server/tsconfig.json --noEmit
  ```

### Build Command

To build the production assets:
```bash
npm run build
```

## Deployment Instructions

Deployment configuration (e.g., Vercel, Fly.io) is currently pending setup. The application is built to be deployed as a standard Node.js/Vite full-stack application. Ensure any future deployments adhere to the Simulation-Safe rules: **Do not enable mainnet credentials.**

## Security Warnings

- **Real-Money Features Disabled:** No real deposits, withdrawals, or external exchange interactions should be forced.
- **Secrets:** Do not commit `.env` or any production credentials. The `.gitignore` explicitly prevents tracking of sensitive keys.

---
*Roadmap Phase 10 aims for full public launch. We are currently preparing for Phase 6.*