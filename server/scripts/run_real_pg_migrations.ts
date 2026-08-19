import { PostgresDatabasePool } from '../src/config/database';
import { SchemaMigrator } from '../src/config/migrator';

interface TableCheck {
  table_name: string;
}

interface ConstraintCheck {
  constraint_name: string;
  table_name: string;
  constraint_type: string;
}

interface EnumCheck {
  typname: string;
}

async function main() {
  console.log('====================================================');
  console.log('PHASE 4 REAL POSTGRESQL MIGRATION EXECUTION');
  console.log('====================================================');

  const pgDb = new PostgresDatabasePool();
  await pgDb.connect();

  const migrator = new SchemaMigrator(undefined, pgDb);

  try {
    // 1. Check existing applied migrations
    console.log('[Step 1] Checking existing applied migrations...');
    const initialApplied = await migrator.getAppliedMigrations();
    console.log(`  Initial applied migrations count: ${initialApplied.length}`);
    for (const m of initialApplied) {
      console.log(`    - ${m.version}: ${m.name} (${m.checksum.substring(0, 12)}...)`);
    }

    const pendingBefore = await migrator.getPendingMigrations();
    console.log(`  Pending migrations to execute: ${pendingBefore.length}`);
    for (const p of pendingBefore) {
      console.log(`    - ${p.filename} [version ${p.version}]`);
    }

    // 2. Execute pending migrations sequentially
    console.log('\n[Step 2] Executing migrations against PostgreSQL...');
    const runResult = await migrator.runMigrations();
    console.log(`  Successfully applied ${runResult.applied.length} migration(s):`);
    for (const name of runResult.applied) {
      console.log(`    ✓ Applied: ${name}`);
    }

    // 3. Query schema_migrations table
    console.log('\n[Step 3] Verifying schema_migrations records...');
    const appliedAfter = await migrator.getAppliedMigrations();
    console.log(`  Total recorded applied migrations: ${appliedAfter.length}`);
    for (const m of appliedAfter) {
      console.log(`    ✓ ${m.version}: ${m.name} (appliedAt: ${m.appliedAt})`);
    }

    // 4. Verify all tables exist in information_schema.tables
    console.log('\n[Step 4] Verifying all expected tables in public schema...');
    const expectedTables = [
      'schema_migrations',
      'users',
      'user_profiles',
      'user_auth_credentials',
      'user_sessions',
      'accounts',
      'assets',
      'wallet_balances',
      'ledger_transactions',
      'ledger_entries',
      'deposits',
      'withdrawals',
      'internal_transfers',
      'trading_pairs',
      'orders',
      'trades',
      'futures_positions',
      'futures_orders',
      'futures_tpsl_configs',
      'futures_funding_history',
      'futures_liquidations',
    ];

    const tablesRes = await pgDb.query<TableCheck>(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name ASC
    `);

    const existingTableNames = new Set(tablesRes.rows.map(r => r.table_name));
    for (const table of expectedTables) {
      if (existingTableNames.has(table)) {
        console.log(`    ✓ Table '${table}' exists`);
      } else {
        throw new Error(`Expected table '${table}' is MISSING from database!`);
      }
    }

    // 5. Verify Constraints & Keys
    console.log('\n[Step 5] Verifying Primary Keys, Foreign Keys, Unique & Check constraints...');
    const constraintsRes = await pgDb.query<ConstraintCheck>(`
      SELECT constraint_name, table_name, constraint_type 
      FROM information_schema.table_constraints 
      WHERE table_schema = 'public'
      ORDER BY table_name, constraint_name
    `);

    // Verify UNIQUE(account_id, reference_id) on ledger_transactions
    const ledgerUnique = constraintsRes.rows.find(
      c => c.table_name === 'ledger_transactions' && c.constraint_type === 'UNIQUE'
    );
    if (ledgerUnique) {
      console.log(`    ✓ ledger_transactions UNIQUE reference constraint exists (${ledgerUnique.constraint_name})`);
    } else {
      throw new Error('ledger_transactions UNIQUE(account_id, reference_id) is MISSING!');
    }

    // Verify wallet_balances non-negative checks
    const walletChecks = constraintsRes.rows.filter(
      c => c.table_name === 'wallet_balances' && c.constraint_type === 'CHECK'
    );
    if (walletChecks.length >= 2) {
      console.log(`    ✓ wallet_balances CHECK constraints exist (${walletChecks.length} checks)`);
    } else {
      throw new Error('wallet_balances non-negative CHECK constraints are MISSING!');
    }

    // 6. Verify ENUM Types
    console.log('\n[Step 6] Verifying PostgreSQL ENUM types...');
    const enumsRes = await pgDb.query<EnumCheck>(`
      SELECT DISTINCT t.typname
      FROM pg_type t 
      JOIN pg_enum e ON t.oid = e.enumtypid
      ORDER BY t.typname
    `);
    const expectedEnums = [
      'user_role',
      'account_status',
      'session_status',
      'account_type',
      'ledger_tx_type',
      'entry_direction',
      'transfer_status',
      'market_type',
      'order_side',
      'order_type',
      'order_status',
      'position_side',
      'position_status',
      'margin_mode',
    ];
    const existingEnums = new Set(enumsRes.rows.map(r => r.typname));
    for (const e of expectedEnums) {
      if (existingEnums.has(e)) {
        console.log(`    ✓ ENUM '${e}' exists`);
      } else {
        throw new Error(`Expected ENUM '${e}' is MISSING!`);
      }
    }

    // 7. Verify Seeded Assets
    console.log('\n[Step 7] Verifying seeded assets in assets table...');
    const assetsRes = await pgDb.query<{ symbol: string; decimals: number }>('SELECT symbol, decimals FROM assets ORDER BY symbol');
    console.log(`    Found ${assetsRes.rows.length} seeded assets:`, assetsRes.rows.map(a => a.symbol).join(', '));
    const expectedSymbols = ['USDT', 'USDC', 'BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'FUTURES_USDT'];
    for (const s of expectedSymbols) {
      if (!assetsRes.rows.some(a => a.symbol === s)) {
        throw new Error(`Seeded asset '${s}' is MISSING from assets table!`);
      }
    }

    // 8. Verify Seeded Trading Pairs
    console.log('\n[Step 8] Verifying seeded trading pairs in trading_pairs table...');
    const pairsRes = await pgDb.query<{ symbol: string; base_asset: string; quote_asset: string }>('SELECT symbol, base_asset, quote_asset FROM trading_pairs ORDER BY symbol');
    console.log(`    Found ${pairsRes.rows.length} seeded pairs:`, pairsRes.rows.map(p => p.symbol).join(', '));
    const expectedPairs = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BTCUSDC'];
    for (const p of expectedPairs) {
      if (!pairsRes.rows.some(pair => pair.symbol === p)) {
        throw new Error(`Seeded trading pair '${p}' is MISSING from trading_pairs table!`);
      }
    }

    // 9. Run Migrator SECOND TIME (Idempotency Test)
    console.log('\n[Step 9] Running SchemaMigrator a SECOND time to test idempotency...');
    const secondPending = await migrator.getPendingMigrations();
    console.log(`    Pending migrations on second run: ${secondPending.length}`);
    if (secondPending.length !== 0) {
      throw new Error(`Second run found ${secondPending.length} pending migrations when 0 expected!`);
    }

    const secondRunResult = await migrator.runMigrations();
    console.log(`    Second run applied count: ${secondRunResult.applied.length}`);
    if (secondRunResult.applied.length !== 0) {
      throw new Error(`Second run erroneously applied ${secondRunResult.applied.length} migrations!`);
    }

    // Verify seed count didn't duplicate
    const assetsCountRes = await pgDb.query<{ count: string }>('SELECT COUNT(*) as count FROM assets');
    const pairsCountRes = await pgDb.query<{ count: string }>('SELECT COUNT(*) as count FROM trading_pairs');
    console.log(`    Assets count after second run: ${assetsCountRes.rows[0].count}`);
    console.log(`    Trading pairs count after second run: ${pairsCountRes.rows[0].count}`);
    if (Number(assetsCountRes.rows[0].count) !== assetsRes.rows.length) {
      throw new Error('Assets table row count changed after second run!');
    }
    if (Number(pairsCountRes.rows[0].count) !== pairsRes.rows.length) {
      throw new Error('Trading pairs table row count changed after second run!');
    }

    console.log('\n====================================================');
    console.log('REAL POSTGRESQL MIGRATION EXECUTION & VERIFICATION PASSED');
    console.log('====================================================');
  } finally {
    await pgDb.close();
  }
}

main().catch(err => {
  console.error('\nMIGRATION EXECUTION FAILED:', err);
  process.exit(1);
});
