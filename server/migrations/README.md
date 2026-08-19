# Database Migrations

This directory holds SQL migration scripts for the PostgreSQL double-entry financial schema.

## Migration Pipeline (Phase 4 Step 3)

The migrations will follow timestamped SQL files executed in sequential order:
- `001_create_users_and_auth.sql`
- `002_create_accounts_and_wallets.sql`
- `003_create_double_entry_ledger.sql`
- `004_create_spot_orders_and_trades.sql`
- `005_create_futures_orders_and_positions.sql`

*Schema implementation and execution will take place in Phase 4 Step 3.*
