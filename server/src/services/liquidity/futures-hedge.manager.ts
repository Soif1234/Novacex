import { Pool, PoolClient } from 'pg';
import { IFuturesHedgeManager, HedgeIntent, HedgeReason, HedgeIntentStatus } from '../../domain/liquidity/hedge-manager.interface';
import { IExposureGuard, ExposureDecision } from '../../domain/liquidity/exposure-guard.interface';
import { HyperliquidAdapter } from './hyperliquid/hyperliquid.adapter';
import { decimalAdd, decimalSubtract, decimalCompare } from '../ledger/decimal';
import { HyperliquidOrderWire } from './hyperliquid/hyperliquid.types';
import { logger } from '../../config/logger';

export class FuturesHedgeManager implements IFuturesHedgeManager {
  private readonly adapter: HyperliquidAdapter;
  private readonly exposureGuard: IExposureGuard;
  private readonly db: Pool;
  private isRecoveryComplete: boolean = false;

  constructor(adapter: HyperliquidAdapter, exposureGuard: IExposureGuard, db: Pool) {
    this.adapter = adapter;
    this.exposureGuard = exposureGuard;
    this.db = db;
  }

  /**
   * RESTART RECOVERY SEQUENCE
   */
  public async initializeAndRecover(): Promise<void> {
    logger.info('Starting Hedge Engine Recovery Sequence');
    this.isRecoveryComplete = false;

    // We do not want to hold a DB transaction during external API calls.
    // So we fetch what we need, release the client, then recover.
    let intentsToRecover: any[] = [];

    const client = await this.db.connect();
    try {
      // 1. Load all non-terminal intents
      const res = await client.query("SELECT * FROM hedge_intents WHERE status IN ('UNKNOWN_PENDING_RECONCILIATION', 'CREATED', 'SUBMITTING', 'OPEN', 'PARTIALLY_FILLED')");
      intentsToRecover = res.rows;
    } finally {
      client.release();
    }

    // 2. Perform external recovery out of band from transactions
    for (const intent of intentsToRecover) {
      logger.info(`Recovering hedge intent ${intent.hedge_intent_id} with status ${intent.status}`);
      try {
        const state = await this.adapter.recoverUnknownOrder(intent.hedge_intent_id, intent.external_order_id || '');
        if (state.status === 'REJECTED') {
          await this.updateIntentStatus(intent.hedge_intent_id, 'REJECTED');
        } else if (state.status === 'FILLED' || state.status === 'PARTIALLY_FILLED' || state.status === 'OPEN') {
          await this.updateIntentStatus(intent.hedge_intent_id, state.status, state.venueOrderId, state.remainingQuantity);

          if (state.status === 'FILLED' || state.status === 'PARTIALLY_FILLED') {
             const executedQty = decimalSubtract(intent.requested_quantity, state.remainingQuantity);
             // We use 'recovery' as the fill ID for now because we don't have individual fill IDs from recoverUnknownOrder
             // In a robust implementation, we'd query userFills
             await this.processExternalFill(intent.market, intent.side, executedQty, `recovery_${intent.hedge_intent_id}`);
          }
        }
      } catch (e: any) {
        logger.error(`Recovery failed for intent ${intent.hedge_intent_id}: ${e.message}`);
        await this.updateIntentStatus(intent.hedge_intent_id, 'RECONCILIATION_REQUIRED');
      }
    }

    // 3. Mark recovery complete so new hedges can be placed
    this.isRecoveryComplete = true;
    logger.info('Hedge Engine Recovery Sequence Complete');
  }

  /**
   * Process customer fills idempotently and adjust persistent house exposure.
   */
  public async processCustomerFill(market: string, side: 'BUY' | 'SELL', qty: string, price: string, tradeId?: string): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // 1. Idempotency Check
      if (tradeId) {
        const idempCheck = await client.query('SELECT event_id FROM house_exposure_events WHERE event_id = $1', [tradeId]);
        if (idempCheck.rowCount! > 0) {
          // Already processed
          await client.query('ROLLBACK');
          return;
        }
        await client.query(
          'INSERT INTO house_exposure_events (event_id, market, side, quantity) VALUES ($1, $2, $3, $4)',
          [tradeId, market, side, qty]
        );
      }

      // 2. Update Persistent House Exposure (Row Lock)
      // We use ON CONFLICT to create it if it doesn't exist
      await client.query(
        "INSERT INTO house_exposure (market, signed_exposure, version) VALUES ($1, '0', 1) ON CONFLICT (market) DO NOTHING",
        [market]
      );

      const exposureRes = await client.query('SELECT signed_exposure, version FROM house_exposure WHERE market = $1 FOR UPDATE', [market]);
      const current = exposureRes.rows[0].signed_exposure;
      const version = exposureRes.rows[0].version;

      const newExposure = side === 'BUY'
        ? decimalSubtract(current, qty)
        : decimalAdd(current, qty);

      await client.query(
        'UPDATE house_exposure SET signed_exposure = $1, version = $2, updated_at = NOW() WHERE market = $3',
        [newExposure, BigInt(version) + 1n, market]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    // Evaluate Netting asynchronously
    await this.evaluateNettingWindow();
  }

  public async evaluateNettingWindow(): Promise<void> {
    if (!this.isRecoveryComplete) {
       logger.warn('Skipping netting window evaluation: recovery in progress');
       return;
    }

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      // Find all markets with non-zero exposure with FOR UPDATE locking
      const expRes = await client.query("SELECT market, signed_exposure FROM house_exposure WHERE signed_exposure != '0' FOR UPDATE");

      for (const row of expRes.rows) {
        const market = row.market;
        const exposure = row.signed_exposure;

        // Fetch all pending hedge intents for this market
        const pendingRes = await client.query(
          "SELECT side, remaining_quantity FROM hedge_intents WHERE market = $1 AND status IN ('CREATED', 'SUBMITTING', 'UNKNOWN_PENDING_RECONCILIATION', 'OPEN', 'PARTIALLY_FILLED', 'RECONCILIATION_REQUIRED')",
          [market]
        );

        let pendingNet = '0';
        for (const p of pendingRes.rows) {
           // A BUY hedge intent increases our net position
           if (p.side === 'BUY') {
               pendingNet = decimalAdd(pendingNet, p.remaining_quantity);
           } else {
               pendingNet = decimalSubtract(pendingNet, p.remaining_quantity);
           }
        }

        // Effective exposure = Current House Exposure + Pending Hedges
        const effectiveExposure = decimalAdd(exposure, pendingNet);
        if (decimalCompare(effectiveExposure, '0') === 0) continue;

        const side = decimalCompare(effectiveExposure, '0') > 0 ? 'SELL' : 'BUY';
        const qty = effectiveExposure.startsWith('-') ? effectiveExposure.substring(1) : effectiveExposure;

        await this.createHedgeIntent(market, side, qty, 'INTERNAL_NET_EXPOSURE', '0');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async createHedgeIntent(
    market: string,
    side: 'BUY' | 'SELL',
    quantity: string,
    reason: HedgeReason,
    targetExposure: string
  ): Promise<HedgeIntent> {
    if (!this.isRecoveryComplete) {
       throw new Error('RECOVERY_IN_PROGRESS: Cannot create new hedge intents until external state is reconciled.');
    }

    const intentId = `hedge_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const cloid = `0x${Buffer.from(`nova_${Date.now()}`).toString('hex').padEnd(32, '0').slice(0,32)}`;

    const intent: HedgeIntent = {
      hedgeIntentId: intentId,
      market,
      side,
      requestedQuantity: quantity,
      remainingQuantity: quantity,
      targetExposure,
      reason,
      createdAt: new Date(),
      status: 'CREATED',
      cloid
    };

    const client = await this.db.connect();
    try {
      await client.query(
        "INSERT INTO hedge_intents (hedge_intent_id, market, side, requested_quantity, remaining_quantity, target_exposure, reason, status, cloid) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [intent.hedgeIntentId, intent.market, intent.side, intent.requestedQuantity, intent.remainingQuantity, intent.targetExposure, intent.reason, intent.status, intent.cloid]
      );
    } finally {
      client.release();
    }

    await this.executeHedgeIntent(intent);
    return intent;
  }

  public async executeHedgeIntent(intent: HedgeIntent): Promise<void> {
    if (!this.isRecoveryComplete) {
       logger.warn('Skipping executeHedgeIntent: recovery in progress');
       return;
    }

    const client = await this.db.connect();
    let houseExposure = '0';
    try {
      const expRes = await client.query('SELECT signed_exposure FROM house_exposure WHERE market = $1', [intent.market]);
      if (expRes.rowCount! > 0) houseExposure = expRes.rows[0].signed_exposure;
    } finally {
      client.release();
    }

    const limits = {
      maxHouseExposure: '100',
      maxHedgeSize: '10',
      maxExternalPosition: '100',
      maxOutstandingHedgeOrders: '5'
    };

    const decision = this.exposureGuard.evaluateHedge({
      currentHouseExposure: houseExposure,
      pendingHedgeQuantity: intent.remainingQuantity,
      externalPosition: '0',
      pendingExternalOrdersQuantity: '0',
      market: intent.market,
      marketDataFreshness: 'HEALTHY',
      proposedHedgeSide: intent.side,
      hyperliquidReduceOnly: false,
      hyperliquidHedgeHalt: false
    }, limits);

    if (decision.result === 'REJECT' || decision.result === 'HALT') {
      await this.updateIntentStatus(intent.hedgeIntentId, 'REJECTED');
      return;
    }

    let qtyToHedge = intent.remainingQuantity;
    if (decision.result === 'REDUCE_SIZE' && decision.allowedQuantity) {
      qtyToHedge = decision.allowedQuantity;
    }

    await this.updateIntentStatus(intent.hedgeIntentId, 'SUBMITTING');

    try {
      const result = await this.adapter.placeHedgeOrder({
        hedgeIntentId: intent.hedgeIntentId,
        symbol: intent.market,
        side: intent.side,
        quantity: qtyToHedge,
        timeInForce: 'IOC'
      });

      // Insert External Order
      await this.persistExternalOrder(intent.hedgeIntentId, intent.cloid, result.venueOrderId || '', intent.market, intent.side, qtyToHedge, result.status);

      if (result.status === 'OPEN' || result.status === 'PARTIALLY_FILLED') {
        await this.updateIntentStatus(intent.hedgeIntentId, result.status, result.venueOrderId, result.remainingQuantity);
      } else if (result.status === 'FILLED') {
        await this.updateIntentStatus(intent.hedgeIntentId, 'FILLED', result.venueOrderId, '0');
        // Reduce internal exposure
        await this.processExternalFill(intent.market, intent.side, qtyToHedge, result.venueOrderId || 'virtual');
      } else if (result.status === 'REJECTED') {
        await this.updateIntentStatus(intent.hedgeIntentId, 'REJECTED', result.venueOrderId);
      }
      } catch (error: any) {
        // Any network error, 5xx, timeout, or unexpected error could mean the order reached the venue
        // and was executed, but we lost the response. We must conservatively mark it as UNKNOWN.
        const msg = error.message?.toLowerCase() || '';
        if (error.code === 'NETWORK_TIMEOUT' || msg.includes('timeout') || msg.includes('502') || msg.includes('504') || msg.includes('500') || msg.includes('503') || error.code === 'ECONNRESET') {
          await this.updateIntentStatus(intent.hedgeIntentId, 'UNKNOWN_PENDING_RECONCILIATION');
        } else {
          // Only known client errors (400, 401) or explicit rejections can safely be FAILED
            await this.updateIntentStatus(intent.hedgeIntentId, 'FAILED');
        }
      }
  }

  private async updateIntentStatus(id: string, status: HedgeIntentStatus, venueOrderId?: string, remaining?: string): Promise<void> {
    const client = await this.db.connect();
    try {
      if (venueOrderId && remaining) {
        await client.query('UPDATE hedge_intents SET status = $1, external_order_id = $2, remaining_quantity = $3, updated_at = NOW() WHERE hedge_intent_id = $4', [status, venueOrderId, remaining, id]);
      } else if (venueOrderId) {
        await client.query('UPDATE hedge_intents SET status = $1, external_order_id = $2, updated_at = NOW() WHERE hedge_intent_id = $3', [status, venueOrderId, id]);
      } else {
        await client.query('UPDATE hedge_intents SET status = $1, updated_at = NOW() WHERE hedge_intent_id = $2', [status, id]);
      }
    } finally {
      client.release();
    }
  }

  private async persistExternalOrder(intentId: string, cloid: string, venueOid: string, market: string, side: string, reqQty: string, status: string): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query(
        "INSERT INTO external_orders (cloid, venue_order_id, hedge_intent_id, venue, status, market, side, requested_quantity, remaining_quantity) VALUES ($1, $2, $3, 'HYPERLIQUID', $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING",
        [cloid, venueOid, intentId, status, market, side, reqQty, reqQty]
      );
    } finally {
      client.release();
    }
  }

  public async processExternalFill(market: string, side: string, qty: string, fillId: string): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // Idempotency using ON CONFLICT
      const fillInsertRes = await client.query(`
        INSERT INTO external_fills (venue, fill_id, external_order_id, market, side, quantity, price, fee, timestamp, source)
        VALUES ('HYPERLIQUID', $1, 'unknown', $2, $3, $4, '0', '0', NOW(), 'SYNC')
        ON CONFLICT (venue, fill_id) DO NOTHING
      `, [fillId, market, side, qty]);

      // EXACTLY-ONCE GUARANTEE: If the row was not inserted, it means it already existed.
      // We must exit and NOT apply the exposure delta again.
      if (fillInsertRes.rowCount === 0) {
        logger.info(`Idempotent fill received: venue=HYPERLIQUID fill_id=${fillId}. Ignoring duplicate delta.`);
        await client.query('ROLLBACK');
        return;
      }

      const exposureRes = await client.query('SELECT signed_exposure, version FROM house_exposure WHERE market = $1 FOR UPDATE', [market]);
      if (exposureRes.rowCount! > 0) {
        const current = exposureRes.rows[0].signed_exposure;
        const version = exposureRes.rows[0].version;
        // We reduce the exposure oppressively. Buy hedge means exposure went up.
        const newExposure = side === 'BUY'
          ? decimalAdd(current, qty)
          : decimalSubtract(current, qty);

        await client.query(
          'UPDATE house_exposure SET signed_exposure = $1, version = $2, updated_at = NOW() WHERE market = $3',
          [newExposure, BigInt(version) + 1n, market]
        );
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  public async recoverUnknownOrders(): Promise<void> {
    // Left as legacy entrypoint if needed by external callers, but actual logic runs in initializeAndRecover
    const client = await this.db.connect();
    try {
      const res = await client.query("SELECT * FROM hedge_intents WHERE status = 'UNKNOWN_PENDING_RECONCILIATION'");
      for (const intent of res.rows) {
        const age = Date.now() - new Date(intent.created_at).getTime();
        const gracePeriodMs = 15000;

        try {
          const state = await this.adapter.recoverUnknownOrder(intent.hedge_intent_id, intent.external_order_id || '');
          if (state.status === 'REJECTED' && age > gracePeriodMs) {
            await this.updateIntentStatus(intent.hedge_intent_id, 'REJECTED');
          } else if (state.status === 'FILLED' || state.status === 'PARTIALLY_FILLED' || state.status === 'OPEN') {
            await this.updateIntentStatus(intent.hedge_intent_id, state.status, state.venueOrderId, state.remainingQuantity);
          }
        } catch (e) {
          if (age > gracePeriodMs) {
            await this.updateIntentStatus(intent.hedge_intent_id, 'RECONCILIATION_REQUIRED');
          }
        }
      }
    } finally {
      client.release();
    }
  }
}
