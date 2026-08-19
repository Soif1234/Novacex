# Mallick Exchange (NovaCEX) — Backend Server

Authoritative backend service for Mallick Exchange, handling double-entry accounting, order matching, position management, and realtime WebSocket feeds.

---

## 1. Quickstart & Local Development

### Prerequisites
- Node.js 20+
- Docker & Docker Compose (optional, for live PostgreSQL & Redis)

### Running with Docker (PostgreSQL + Redis)
To spin up local PostgreSQL and Redis instances:
```bash
docker compose up -d
```

### Running the Backend Service
```bash
# Copy example environment
cp .env.example .env

# Run in development mode (hot reloading via tsx)
npm run dev

# Build production TypeScript bundle
npm run build

# Start compiled production bundle
npm start
```

---

## 2. API Health & Readiness Endpoints

- **System Health**: `GET http://localhost:4000/api/v1/health`
  Returns service status, uptime, version, and timestamp.
  
- **Infrastructure Readiness**: `GET http://localhost:4000/api/v1/ready`
  Performs live ping checks against PostgreSQL and Redis pools. Returns HTTP 200 when ready or HTTP 503 if any service is disconnected.

---

## 3. Architecture Overview

- **`src/config/`**: Environment parsing, structured JSON logger, PostgreSQL pool abstraction, Redis connection client.
- **`src/middleware/`**: Request ID propagation (`X-Request-ID`), security headers, CORS handler, central error management.
- **`src/controllers/`**: HTTP route controllers.
- **`src/services/`**: Domain services (Auth, Double-entry Ledger, Spot Matching, Futures Risk/Margin, Wallet, Market Data).
- **`src/websocket/`**: Public and authenticated private WebSocket stream handlers.
