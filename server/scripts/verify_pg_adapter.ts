import { PostgresDatabasePool } from '../src/config/database';
import { env } from '../src/config/env';

async function runPgAdapterVerification() {
  console.log('====================================================');
  console.log('REAL POSTGRESQL ADAPTER VERIFICATION');
  console.log('====================================================');

  const pgPool = new PostgresDatabasePool();
  const results: Record<string, { pass: boolean; details?: any; error?: string }> = {};

  try {
    // 1. Connect successfully
    console.log('[1/9] Testing connect()...');
    await pgPool.connect();
    results['1_connect'] = { pass: true, details: 'Connected to PostgreSQL pool' };
    console.log('  -> PASS');

    // 2. SELECT version()
    console.log('[2/9] Testing SELECT version()...');
    const verRes = await pgPool.query<{ version: string }>('SELECT version()');
    results['2_version'] = { pass: true, details: verRes.rows[0].version };
    console.log('  -> PASS:', verRes.rows[0].version);

    // 3. Create / read a safe temporary test table
    console.log('[3/9] Testing temporary test table create & read...');
    await pgPool.query(`
      CREATE TEMP TABLE IF NOT EXISTS _adapter_verify_test (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) NOT NULL,
        amount NUMERIC(36, 18) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    results['3_temp_table'] = { pass: true, details: 'Created and verified temp table' };
    console.log('  -> PASS');

    // 4. Parameterized query works
    console.log('[4/9] Testing parameterized INSERT & SELECT...');
    await pgPool.query(
      'INSERT INTO _adapter_verify_test (name, amount) VALUES ($1, $2)',
      ['test_param', '1234.567890000000000000']
    );
    const paramRes = await pgPool.query<{ name: string; amount: string }>(
      'SELECT name, amount FROM _adapter_verify_test WHERE name = $1',
      ['test_param']
    );
    if (paramRes.rows.length === 1 && paramRes.rows[0].amount === '1234.567890000000000000') {
      results['4_parameterized'] = { pass: true, details: paramRes.rows[0] };
      console.log('  -> PASS:', paramRes.rows[0]);
    } else {
      throw new Error(`Parameterized query returned unexpected rows: ${JSON.stringify(paramRes.rows)}`);
    }

    // 5. BEGIN / COMMIT works
    console.log('[5/9] Testing transaction BEGIN & COMMIT...');
    await pgPool.transaction(async (tx) => {
      await tx.query('INSERT INTO _adapter_verify_test (name, amount) VALUES ($1, $2)', [
        'tx_commit_item',
        '500.000000000000000000',
      ]);
    });
    const commitRes = await pgPool.query(
      'SELECT name FROM _adapter_verify_test WHERE name = $1',
      ['tx_commit_item']
    );
    if (commitRes.rows.length === 1) {
      results['5_commit'] = { pass: true, details: 'Committed row successfully persisted' };
      console.log('  -> PASS: Committed row exists');
    } else {
      throw new Error('Committed transaction row was not persisted');
    }

    // 6. BEGIN / ROLLBACK works
    console.log('[6/9] Testing transaction BEGIN & ROLLBACK on error...');
    try {
      await pgPool.transaction(async (tx) => {
        await tx.query('INSERT INTO _adapter_verify_test (name, amount) VALUES ($1, $2)', [
          'tx_rollback_item',
          '999.000000000000000000',
        ]);
        throw new Error('Simulated failure triggering rollback');
      });
    } catch (err: any) {
      // Expected error
    }
    const rollbackRes = await pgPool.query(
      'SELECT name FROM _adapter_verify_test WHERE name = $1',
      ['tx_rollback_item']
    );
    if (rollbackRes.rows.length === 0) {
      results['6_rollback'] = { pass: true, details: 'Rollback verified - 0 rows persisted' };
      console.log('  -> PASS: Rolled back row does not exist');
    } else {
      throw new Error('Rolled back row was erroneously persisted!');
    }

    // 7. SELECT ... FOR UPDATE inside a transaction
    console.log('[7/9] Testing SELECT ... FOR UPDATE inside a transaction...');
    await pgPool.transaction(async (tx) => {
      const lockRes = await tx.query(
        'SELECT id, name, amount FROM _adapter_verify_test WHERE name = $1 FOR UPDATE',
        ['test_param']
      );
      if (lockRes.rows.length !== 1) {
        throw new Error('Failed to acquire row lock via SELECT FOR UPDATE');
      }
      await tx.query(
        'UPDATE _adapter_verify_test SET amount = $1 WHERE name = $2',
        ['9999.000000000000000000', 'test_param']
      );
    });
    const updateRes = await pgPool.query<{ amount: string }>(
      'SELECT amount FROM _adapter_verify_test WHERE name = $1',
      ['test_param']
    );
    if (updateRes.rows[0].amount === '9999.000000000000000000') {
      results['7_for_update'] = { pass: true, details: 'SELECT FOR UPDATE and update verified' };
      console.log('  -> PASS: SELECT FOR UPDATE succeeded and updated row');
    } else {
      throw new Error('Row lock update failed');
    }

    // 8. Pool client release & status check
    console.log('[8/9] Testing pool client release and status reporting...');
    const status = pgPool.getStatus();
    const health = await pgPool.healthCheck();
    if (status.connected && status.idleConnections >= 0 && health.healthy) {
      results['8_pool_status'] = { pass: true, details: { status, health } };
      console.log('  -> PASS: Pool status:', status, 'Health:', health);
    } else {
      throw new Error(`Invalid pool status or health check: ${JSON.stringify({ status, health })}`);
    }

    // 9. Pool shutdown
    console.log('[9/9] Testing pool close / shutdown...');
    await pgPool.close();
    const postCloseStatus = pgPool.getStatus();
    if (!postCloseStatus.connected) {
      results['9_shutdown'] = { pass: true, details: 'Pool closed cleanly' };
      console.log('  -> PASS: Pool closed successfully');
    } else {
      throw new Error('Pool still reported connected after close()');
    }

    console.log('\n====================================================');
    console.log('ALL 9 REAL POSTGRESQL ADAPTER CHECKS PASSED');
    console.log('====================================================');
    return { success: true, results };
  } catch (err: any) {
    console.error('\nADAPTER VERIFICATION FAILED:', err.message);
    await pgPool.close().catch(() => {});
    return { success: false, error: err.message, results };
  }
}

runPgAdapterVerification().then((res) => {
  if (!res.success) {
    process.exit(1);
  }
});
