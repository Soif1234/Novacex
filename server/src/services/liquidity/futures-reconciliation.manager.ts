import { Pool } from 'pg';
import { HyperliquidAdapter } from './hyperliquid/hyperliquid.adapter';
import { decimalCompare, decimalSubtract } from '../ledger/decimal';
import { logger } from '../../config/logger';

export interface ReconciliationResult {
  status: 'HEALTHY' | 'DRIFT_DETECTED' | 'RECONCILING' | 'HALTED';
  market: string;
  expected: string;
  actual: string;
  delta: string;
}

export class FuturesReconciliationManager {
  private readonly db: Pool;
  private readonly adapter: HyperliquidAdapter;
  private isReconciling: boolean = false;

  constructor(db: Pool, adapter: HyperliquidAdapter) {
    this.db = db;
    this.adapter = adapter;
  }

  /**
   * Rebuilds expected external position entirely from durable PostgreSQL state.
   */
  public async getExpectedPositions(): Promise<Map<string, string>> {
    const client = await this.db.connect();
    try {
      const res = await client.query(`
        SELECT market,
               COALESCE(SUM(CASE WHEN side = 'BUY' THEN quantity ELSE -quantity END), 0) as expected_position
        FROM external_fills
        WHERE venue = 'HYPERLIQUID'
        GROUP BY market
      `);

      const expected = new Map<string, string>();
      for (const row of res.rows) {
        expected.set(row.market, row.expected_position.toString());
      }
      return expected;
    } finally {
      client.release();
    }
  }

  /**
   * Fetches the actual external position directly from Hyperliquid.
   */
  public async getActualPositions(): Promise<Map<string, string>> {
    const state = await this.adapter.getClearinghouseState();
    const actual = new Map<string, string>();

    for (const assetPos of state.assetPositions) {
      const pos = assetPos.position;
      // Note: In real life, Hyperliquid returns the coin symbol e.g., "BTC"
      // We assume market maps to coin directly or is converted inside the adapter.
      // szi is signed size.
      if (decimalCompare(pos.szi, '0') !== 0) {
        actual.set(pos.coin, pos.szi);
      }
    }
    return actual;
  }

  /**
   * Reconciles the expected local position with the actual venue position.
   */
  public async reconcilePositions(): Promise<ReconciliationResult[]> {
    if (this.isReconciling) {
       logger.warn('Reconciliation already in progress. Skipping.');
       return [];
    }
    this.isReconciling = true;

    try {
      const expectedPositions = await this.getExpectedPositions();
      const actualPositions = await this.getActualPositions();

      // Get union of all markets
      const allMarkets = new Set([...expectedPositions.keys(), ...actualPositions.keys()]);
      const results: ReconciliationResult[] = [];

      const client = await this.db.connect();
      try {
        await client.query('BEGIN');

        for (const market of allMarkets) {
          const expected = expectedPositions.get(market) || '0';
          const actual = actualPositions.get(market) || '0';
          const delta = decimalSubtract(actual, expected);

          let status: 'HEALTHY' | 'DRIFT_DETECTED' = 'HEALTHY';

          if (decimalCompare(delta, '0') !== 0) {
            status = 'DRIFT_DETECTED';
            logger.error(`DRIFT_DETECTED for ${market}: Expected ${expected}, Actual ${actual}, Delta ${delta}`);

            // Insert reconciliation event idempotently if unresolved
            const checkRes = await client.query(`
              SELECT id FROM hedge_reconciliation_events
              WHERE market = $1 AND event_type = 'POSITION_DRIFT' AND details->>'status' = 'UNRESOLVED'
            `, [market]);

            if (checkRes.rowCount === 0) {
              await client.query(`
                INSERT INTO hedge_reconciliation_events (venue, market, event_type, details)
                VALUES ('HYPERLIQUID', $1, 'POSITION_DRIFT', $2)
              `, [market, JSON.stringify({ expected, actual, delta, status: 'UNRESOLVED' })]);
            }
          }

          // Update venue_positions durable state
          await client.query(`
            INSERT INTO venue_positions (venue, market, account, actual_position, target_position, last_reconciled_at)
            VALUES ('HYPERLIQUID', $1, 'default', $2, $3, NOW())
            ON CONFLICT (venue, market, account) DO UPDATE
            SET actual_position = EXCLUDED.actual_position,
                target_position = EXCLUDED.target_position,
                last_reconciled_at = NOW()
          `, [market, actual, expected]);

          results.push({ status, market, expected, actual, delta });
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      return results;
    } finally {
      this.isReconciling = false;
    }
  }

  /**
   * Detects open orders on the venue that do not match our local expected open orders.
   */
  public async reconcileOpenOrders(): Promise<void> {
    const client = await this.db.connect();
    let expectedOrders: any[] = [];
    try {
      const res = await client.query(`
        SELECT cloid, venue_order_id, market, side, remaining_quantity
        FROM external_orders
        WHERE status IN ('OPEN', 'PARTIALLY_FILLED') AND venue = 'HYPERLIQUID'
      `);
      expectedOrders = res.rows;
    } finally {
      client.release();
    }

    const actualOpenOrders = await this.adapter.getOpenOrders(); // Exposed for auditing

    // Cross-check: Expected missing from Actual
    for (const expected of expectedOrders) {
      const found = actualOpenOrders.find((o: any) => o.cloid === expected.cloid || (o.oid && o.oid.toString() === expected.venue_order_id));
      if (!found) {
        // Missing external order, raise reconciliation event
        logger.error(`DRIFT_DETECTED (Missing Order): Order ${expected.cloid} missing from venue.`);
        const client2 = await this.db.connect();
        try {
          await client2.query(`
            INSERT INTO hedge_reconciliation_events (venue, market, event_type, details)
            VALUES ('HYPERLIQUID', $1, 'ORDER_MISSING_EXTERNALLY', $2)
          `, [expected.market, JSON.stringify({ expectedCloid: expected.cloid, status: 'UNRESOLVED' })]);
        } finally {
          client2.release();
        }
      }
    }

    // Cross-check: Actual uncorrelated with Expected
    for (const actual of actualOpenOrders) {
      const found = expectedOrders.find(e => e.cloid === actual.cloid || (actual.oid && e.venue_order_id === actual.oid.toString()));
      if (!found) {
        // Uncorrelated external order, raise reconciliation event
        logger.error(`EXTERNAL_ACTIVITY_UNCORRELATED: Order ${actual.cloid} found on venue but unknown locally.`);
        const client2 = await this.db.connect();
        try {
          await client2.query(`
            INSERT INTO hedge_reconciliation_events (venue, market, event_type, details)
            VALUES ('HYPERLIQUID', $1, 'EXTERNAL_ACTIVITY_UNCORRELATED', $2)
          `, [actual.coin, JSON.stringify({ actualCloid: actual.cloid, actualOid: actual.oid, status: 'UNRESOLVED' })]);
        } finally {
          client2.release();
        }
      }
    }
  }
}
