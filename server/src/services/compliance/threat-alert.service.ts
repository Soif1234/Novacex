import crypto from 'crypto';
import { db, IDatabaseConnection } from '../../config/database';
import { AuditService, auditService } from '../admin/audit.service';
import {
  SecurityThreatAlertEntity,
  CreateThreatAlertDto,
  ResolveThreatAlertDto,
  QueryThreatAlertsDto,
} from '../../models/reconciliation.model';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../config/logger';

export class ThreatAlertService {
  private audit: AuditService;

  constructor(
    private database: IDatabaseConnection = db,
    audit?: AuditService
  ) {
    this.audit = audit || new AuditService(database);
  }

  /**
   * Record a new security / financial threat alert
   */
  public async createAlert(dto: CreateThreatAlertDto): Promise<SecurityThreatAlertEntity> {
    const alertId = crypto.randomUUID();
    const metadataJson = JSON.stringify(dto.metadata || {});

    const res = await this.database.query<any>(
      `INSERT INTO security_threat_alerts (
        id, severity, category, title, description, metadata, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', NOW())
      RETURNING id, severity, category, title, description, metadata, status,
                resolved_by AS "resolvedBy", resolved_at AS "resolvedAt",
                resolution_notes AS "resolutionNotes", created_at AS "createdAt"`,
      [alertId, dto.severity, dto.category, dto.title, dto.description, metadataJson]
    );

    const row = res.rows[0];
    const alert: SecurityThreatAlertEntity = {
      id: row.id,
      severity: row.severity,
      category: row.category,
      title: row.title,
      description: row.description,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata || {},
      status: row.status,
      resolvedBy: row.resolvedBy || null,
      resolvedAt: row.resolvedAt ? new Date(row.resolvedAt) : null,
      resolutionNotes: row.resolutionNotes || null,
      createdAt: new Date(row.createdAt),
    };

    logger.warn('SECURITY THREAT ALERT GENERATED', {
      alertId: alert.id,
      severity: alert.severity,
      category: alert.category,
      title: alert.title,
    });

    return alert;
  }

  /**
   * Resolve an active security alert with admin justification
   */
  public async resolveAlert(
    alertId: string,
    dto: ResolveThreatAlertDto
  ): Promise<SecurityThreatAlertEntity> {
    if (!dto.resolutionNotes || !dto.resolutionNotes.trim()) {
      throw new AppError('Resolution notes are mandatory to resolve or ignore an alert', 400, 'MISSING_RESOLUTION_NOTES');
    }

    const currentRes = await this.database.query<any>(
      `SELECT id, severity, category, title, description, metadata, status,
              resolved_by AS "resolvedBy", resolved_at AS "resolvedAt",
              resolution_notes AS "resolutionNotes", created_at AS "createdAt"
       FROM security_threat_alerts
       WHERE id = $1`,
      [alertId]
    );

    if (currentRes.rows.length === 0) {
      throw new AppError(`Alert with ID ${alertId} not found`, 404, 'ALERT_NOT_FOUND');
    }

    const prev = currentRes.rows[0];

    const updateRes = await this.database.query<any>(
      `UPDATE security_threat_alerts
       SET status = $1, resolved_by = $2, resolved_at = NOW(), resolution_notes = $3
       WHERE id = $4
       RETURNING id, severity, category, title, description, metadata, status,
                 resolved_by AS "resolvedBy", resolved_at AS "resolvedAt",
                 resolution_notes AS "resolutionNotes", created_at AS "createdAt"`,
      [dto.status, dto.adminUserId, dto.resolutionNotes.trim(), alertId]
    );

    const updated = updateRes.rows[0];
    const alert: SecurityThreatAlertEntity = {
      id: updated.id,
      severity: updated.severity,
      category: updated.category,
      title: updated.title,
      description: updated.description,
      metadata: typeof updated.metadata === 'string' ? JSON.parse(updated.metadata) : updated.metadata || {},
      status: updated.status,
      resolvedBy: updated.resolvedBy,
      resolvedAt: new Date(updated.resolvedAt),
      resolutionNotes: updated.resolutionNotes,
      createdAt: new Date(updated.createdAt),
    };

    // Emit immutable audit log
    await this.audit.record({
      adminUserId: dto.adminUserId,
      action: 'SECURITY_ALERT_RESOLVED',
      targetResourceType: 'SECURITY_ALERT',
      targetResourceId: alertId,
      previousState: {
        status: prev.status,
        resolvedBy: prev.resolvedBy,
      },
      newState: {
        status: alert.status,
        resolvedBy: alert.resolvedBy,
        resolutionNotes: alert.resolutionNotes,
      },
      reason: dto.resolutionNotes.trim(),
      ipAddress: dto.ipAddress,
      userAgent: dto.userAgent,
    });

    logger.info('SECURITY THREAT ALERT RESOLVED', {
      alertId,
      adminUserId: dto.adminUserId,
      status: dto.status,
    });

    return alert;
  }

  /**
   * Query alerts with pagination and filters
   */
  public async getAlerts(
    query: QueryThreatAlertsDto = {}
  ): Promise<{ alerts: SecurityThreatAlertEntity[]; total: number; page: number; pageSize: number }> {
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

    if (query.severity) {
      conditions.push(`severity = $${paramIndex++}`);
      params.push(query.severity);
    }

    if (query.category) {
      conditions.push(`category = $${paramIndex++}`);
      params.push(query.category);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await this.database.query<any>(
      `SELECT COUNT(*) AS count FROM security_threat_alerts ${whereClause}`,
      params
    );
    const total = parseInt(countRes.rows[0]?.count || '0', 10);

    const rowsRes = await this.database.query<any>(
      `SELECT id, severity, category, title, description, metadata, status,
              resolved_by AS "resolvedBy", resolved_at AS "resolvedAt",
              resolution_notes AS "resolutionNotes", created_at AS "createdAt"
       FROM security_threat_alerts
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, pageSize, offset]
    );

    const alerts: SecurityThreatAlertEntity[] = rowsRes.rows.map((row: any) => ({
      id: row.id,
      severity: row.severity,
      category: row.category,
      title: row.title,
      description: row.description,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata || {},
      status: row.status,
      resolvedBy: row.resolvedBy || null,
      resolvedAt: row.resolvedAt ? new Date(row.resolvedAt) : null,
      resolutionNotes: row.resolutionNotes || null,
      createdAt: new Date(row.createdAt),
    }));

    return { alerts, total, page, pageSize };
  }
}

export const threatAlertService = new ThreatAlertService();
