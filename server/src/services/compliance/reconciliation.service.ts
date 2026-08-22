import crypto from 'crypto';
import { db, IDatabaseConnection } from '../../config/database';
import { AuditService, auditService } from '../admin/audit.service';
import { ThreatAlertService, threatAlertService } from './threat-alert.service';
import { CircuitBreakerService, circuitBreakerService } from '../system/circuit-breaker.service';
import {
  ReconciliationReportEntity,
  ReconciliationDiscrepancyDetail,
  QueryReconciliationReportsDto,
} from '../../models/reconciliation.model';
import { decimalAdd, decimalSubtract, decimalCompare, decimalIsZero } from '../ledger/decimal';
import { logger } from '../../config/logger';

export class ReconciliationService {
  private audit: AuditService;
  private threatAlerts: ThreatAlertService;
  private circuitBreaker: CircuitBreakerService;

  constructor(
    private database: IDatabaseConnection = db,
    audit?: AuditService,
    threats?: ThreatAlertService,
    cb?: CircuitBreakerService
  ) {
    this.audit = audit || new AuditService(database);
    this.threatAlerts = threats || new ThreatAlertService(database, this.audit);
    this.circuitBreaker = cb || new CircuitBreakerService(database, this.audit);
  }

  /**
   * Run full exchange-wide or account-scoped financial reconciliation sweep
   */
  public async runReconciliation(
    triggeredBy: string = 'SYSTEM_WORKER',
    adminUserId?: string,
    targetAccountId?: string
  ): Promise<ReconciliationReportEntity> {
    const reportId = crypto.randomUUID();
    const discrepancies: ReconciliationDiscrepancyDetail[] = [];
    let accountsChecked = 0;

    logger.info('Starting balance reconciliation sweep', { reportId, triggeredBy, targetAccountId });

    // ── Check 1: Account Wallet Balances vs Ledger Net Credits/Debits ──────────────
    const walletsRes = targetAccountId
      ? await this.database.query<any>(
          `SELECT account_id AS "accountId", asset,
                  available_balance AS "availableBalance",
                  locked_balance AS "lockedBalance"
           FROM wallet_balances
           WHERE account_id = $1`,
          [targetAccountId]
        )
      : await this.database.query<any>(
          `SELECT account_id AS "accountId", asset,
                  available_balance AS "availableBalance",
                  locked_balance AS "lockedBalance"
           FROM wallet_balances`
        );

    accountsChecked = walletsRes.rows.length;

    // Fetch aggregated ledger credits & debits
    const ledgerCreditsRes = targetAccountId
      ? await this.database.query<any>(
          `SELECT account_id AS "accountId", asset, COALESCE(SUM(amount), 0) AS "totalCredits"
           FROM ledger_entries
           WHERE direction = 'CREDIT' AND account_id = $1
           GROUP BY account_id, asset`,
          [targetAccountId]
        )
      : await this.database.query<any>(
          `SELECT account_id AS "accountId", asset, COALESCE(SUM(amount), 0) AS "totalCredits"
           FROM ledger_entries
           WHERE direction = 'CREDIT'
           GROUP BY account_id, asset`
        );

    const ledgerDebitsRes = targetAccountId
      ? await this.database.query<any>(
          `SELECT account_id AS "accountId", asset, COALESCE(SUM(amount), 0) AS "totalDebits"
           FROM ledger_entries
           WHERE direction = 'DEBIT' AND account_id = $1
           GROUP BY account_id, asset`,
          [targetAccountId]
        )
      : await this.database.query<any>(
          `SELECT account_id AS "accountId", asset, COALESCE(SUM(amount), 0) AS "totalDebits"
           FROM ledger_entries
           WHERE direction = 'DEBIT'
           GROUP BY account_id, asset`
        );

    const creditMap = new Map<string, string>();
    for (const r of ledgerCreditsRes.rows) {
      creditMap.set(`${r.accountId}:${r.asset}`, String(r.totalCredits));
    }

    const debitMap = new Map<string, string>();
    for (const r of ledgerDebitsRes.rows) {
      debitMap.set(`${r.accountId}:${r.asset}`, String(r.totalDebits));
    }

    for (const w of walletsRes.rows) {
      const key = `${w.accountId}:${w.asset}`;
      const available = String(w.availableBalance ?? '0');
      const locked = String(w.lockedBalance ?? '0');
      const walletTotal = decimalAdd(available, locked);

      const credits = creditMap.get(key) || '0';
      const debits = debitMap.get(key) || '0';
      const ledgerComputed = decimalSubtract(credits, debits);

      const diff = decimalSubtract(walletTotal, ledgerComputed);

      // A. Balance consistency check
      if (!decimalIsZero(diff)) {
        discrepancies.push({
          type: 'BALANCE_MISMATCH',
          accountId: w.accountId,
          asset: w.asset,
          walletAvailable: available,
          walletLocked: locked,
          walletTotal,
          ledgerComputed,
          discrepancy: diff,
          reason: `Wallet total (${walletTotal}) diverges from ledger net (${ledgerComputed}) by ${diff}`,
        });
      }

      // B. Negative balance check (excluding internal master suspense account)
      if (
        w.accountId !== '22222222-2222-2222-2222-222222222222' &&
        (decimalCompare(available, '0') < 0 || decimalCompare(locked, '0') < 0 || decimalCompare(walletTotal, '0') < 0)
      ) {
        discrepancies.push({
          type: 'NEGATIVE_BALANCE',
          accountId: w.accountId,
          asset: w.asset,
          walletAvailable: available,
          walletLocked: locked,
          walletTotal,
          reason: `Unauthorized negative balance detected on account ${w.accountId} (${w.asset}): Available=${available}, Locked=${locked}`,
        });
      }
    }

    // ── Check 2: Double-Entry Zero-Sum Invariant Validation ───────────────────────
    const zeroSumRes = targetAccountId
      ? await this.database.query<any>(
          `SELECT lt.id AS "transactionId", lt.transaction_type AS "transactionType", le.asset,
                  SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount ELSE -le.amount END) AS "netDelta"
           FROM ledger_entries le
           JOIN ledger_transactions lt ON lt.id = le.transaction_id
           WHERE lt.transaction_type IN (
             'INTERNAL_TRANSFER',
             'SPOT_TRADE_SETTLE',
             'SPOT_ORDER_LOCK',
             'SPOT_ORDER_UNLOCK',
             'FUTURES_MARGIN_LOCK',
             'FUTURES_MARGIN_RELEASE',
             'FUTURES_PNL_REALIZED',
             'FUTURES_FUNDING_PAYMENT',
             'FUTURES_LIQUIDATION',
             'TRADING_FEE'
           ) AND lt.account_id = $1
           GROUP BY lt.id, lt.transaction_type, le.asset
           HAVING SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount ELSE -le.amount END) != 0`,
          [targetAccountId]
        )
      : await this.database.query<any>(
          `SELECT lt.id AS "transactionId", lt.transaction_type AS "transactionType", le.asset,
                  SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount ELSE -le.amount END) AS "netDelta"
           FROM ledger_entries le
           JOIN ledger_transactions lt ON lt.id = le.transaction_id
           WHERE lt.transaction_type IN (
             'INTERNAL_TRANSFER',
             'SPOT_TRADE_SETTLE',
             'SPOT_ORDER_LOCK',
             'SPOT_ORDER_UNLOCK',
             'FUTURES_MARGIN_LOCK',
             'FUTURES_MARGIN_RELEASE',
             'FUTURES_PNL_REALIZED',
             'FUTURES_FUNDING_PAYMENT',
             'FUTURES_LIQUIDATION',
             'TRADING_FEE'
           )
           GROUP BY lt.id, lt.transaction_type, le.asset
           HAVING SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount ELSE -le.amount END) != 0`
        );

    for (const zs of zeroSumRes.rows) {
      discrepancies.push({
        type: 'DOUBLE_ENTRY_VIOLATION',
        transactionId: zs.transactionId,
        asset: zs.asset,
        discrepancy: String(zs.netDelta),
        reason: `Double-entry zero-sum invariant violated for transaction ${zs.transactionId} (${zs.asset}): net delta = ${zs.netDelta}`,
      });
    }

    const status = discrepancies.length === 0 ? 'PASSED' : 'DISCREPANCY_DETECTED';

    // ── Persist Report ───────────────────────────────────────────────────────────
    const detailsJson = JSON.stringify(discrepancies);
    const insertRes = await this.database.query<any>(
      `INSERT INTO reconciliation_reports (
        id, status, accounts_checked, discrepancies_count, details, triggered_by, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING id, status,
                accounts_checked AS "accountsChecked",
                discrepancies_count AS "discrepanciesCount",
                details, triggered_by AS "triggeredBy", created_at AS "createdAt"`,
      [reportId, status, accountsChecked, discrepancies.length, detailsJson, triggeredBy]
    );

    const report: ReconciliationReportEntity = {
      id: insertRes.rows[0].id,
      status: insertRes.rows[0].status,
      accountsChecked: insertRes.rows[0].accountsChecked,
      discrepanciesCount: insertRes.rows[0].discrepanciesCount,
      details: discrepancies,
      triggeredBy: insertRes.rows[0].triggeredBy,
      createdAt: new Date(insertRes.rows[0].createdAt),
    };

    // ── Discrepancy Alerting & Emergency Circuit Breaker Protection ───────────────
    if (discrepancies.length > 0) {
      const hasCriticalMismatch = discrepancies.some(
        d => d.type === 'BALANCE_MISMATCH' || d.type === 'DOUBLE_ENTRY_VIOLATION'
      );

      const severity = hasCriticalMismatch ? 'CRITICAL' : 'HIGH';

      // 1. Create Threat Alert
      await this.threatAlerts.createAlert({
        severity,
        category: 'RECONCILIATION_MISMATCH',
        title: `Reconciliation Failure: ${discrepancies.length} discrepancy(s) detected`,
        description: `Automated balance reconciliation sweep (${reportId}) identified ${discrepancies.length} financial discrepancy(s).`,
        metadata: {
          reportId,
          triggeredBy,
          discrepanciesCount: discrepancies.length,
          discrepancies: discrepancies.slice(0, 10), // attach first 10 for immediate triage
        },
      });

      // 2. Automated Circuit Breaker Activation if CRITICAL
      if (hasCriticalMismatch) {
        try {
          const haltActor = adminUserId || '00000000-0000-0000-0000-000000000000';
          await this.circuitBreaker.halt({
            adminUserId: haltActor,
            mode: 'HALT_WITHDRAWALS',
            reason: `Automated safety trigger: Critical financial reconciliation discrepancy detected in report ${reportId}`,
          });
          logger.warn('Circuit breaker HALT_WITHDRAWALS automatically triggered by reconciliation engine', {
            reportId,
          });
        } catch (err: any) {
          logger.error('Failed to trigger automatic circuit breaker on reconciliation discrepancy', {
            error: err.message,
          });
        }
      }
    }

    // Record immutable audit log
    await this.audit.record({
      adminUserId: adminUserId || '00000000-0000-0000-0000-000000000000',
      action: 'RECONCILIATION_RUN',
      targetResourceType: 'RECONCILIATION_REPORT',
      targetResourceId: reportId,
      newState: {
        status,
        accountsChecked,
        discrepanciesCount: discrepancies.length,
        triggeredBy,
      },
      reason: `Automated financial reconciliation completed with status: ${status}`,
    });

    return report;
  }

  /**
   * Query historical reconciliation reports
   */
  public async getReports(
    query: QueryReconciliationReportsDto = {}
  ): Promise<{ reports: ReconciliationReportEntity[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, query.page || 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize || 20));
    const offset = (page - 1) * pageSize;

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (query.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(query.status);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await this.database.query<any>(
      `SELECT COUNT(*) AS count FROM reconciliation_reports ${whereClause}`,
      params
    );
    const total = parseInt(countRes.rows[0]?.count || '0', 10);

    const rowsRes = await this.database.query<any>(
      `SELECT id, status,
              accounts_checked AS "accountsChecked",
              discrepancies_count AS "discrepanciesCount",
              details, triggered_by AS "triggeredBy", created_at AS "createdAt"
       FROM reconciliation_reports
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, pageSize, offset]
    );

    const reports: ReconciliationReportEntity[] = rowsRes.rows.map((row: any) => ({
      id: row.id,
      status: row.status,
      accountsChecked: row.accountsChecked,
      discrepanciesCount: row.discrepanciesCount,
      details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details || [],
      triggeredBy: row.triggeredBy,
      createdAt: new Date(row.createdAt),
    }));

    return { reports, total, page, pageSize };
  }
}

export const reconciliationService = new ReconciliationService();
