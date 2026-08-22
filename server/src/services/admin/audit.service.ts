import { db, IDatabaseConnection } from '../../config/database';
import {
  AdminAuditLogEntity,
  RecordAuditLogDto,
  QueryAuditLogsDto,
} from '../../models/admin.model';
import { logger } from '../../config/logger';

export class AuditService {
  constructor(private database: IDatabaseConnection = db) {}

  /**
   * Append an immutable admin audit log entry
   */
  public async record(dto: RecordAuditLogDto): Promise<AdminAuditLogEntity> {
    const prevJson = dto.previousState ? JSON.stringify(dto.previousState) : null;
    const newJson = dto.newState ? JSON.stringify(dto.newState) : null;
    const targetType = dto.targetResourceType || 'USER';

    const res = await this.database.query<any>(
      `INSERT INTO admin_audit_logs (
        admin_user_id, action, target_user_id, target_resource_type, target_resource_id,
        previous_state, new_state, reason, ip_address, user_agent, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      RETURNING id, admin_user_id AS "adminUserId", action, target_user_id AS "targetUserId",
                target_resource_type AS "targetResourceType", target_resource_id AS "targetResourceId",
                previous_state AS "previousState", new_state AS "newState", reason,
                ip_address AS "ipAddress", user_agent AS "userAgent", created_at AS "createdAt"`,
      [
        dto.adminUserId,
        dto.action,
        dto.targetUserId || null,
        targetType,
        dto.targetResourceId || null,
        prevJson,
        newJson,
        dto.reason || null,
        dto.ipAddress || null,
        dto.userAgent || null,
      ]
    );

    const log = res.rows[0];

    logger.info('Admin audit event logged', {
      auditId: log.id,
      adminUserId: dto.adminUserId,
      action: dto.action,
      targetUserId: dto.targetUserId,
      targetResourceType: targetType,
      reason: dto.reason,
    });

    return log;
  }

  /**
   * Query immutable admin audit log trails
   */
  public async getLogs(query: QueryAuditLogsDto): Promise<{ logs: AdminAuditLogEntity[]; total: number }> {
    const page = Math.max(1, query.page || 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize || 20));
    const offset = (page - 1) * pageSize;

    const conditions: string[] = [];
    const params: any[] = [];

    if (query.adminUserId) {
      params.push(query.adminUserId);
      conditions.push(`admin_user_id = $${params.length}`);
    }

    if (query.targetUserId) {
      params.push(query.targetUserId);
      conditions.push(`target_user_id = $${params.length}`);
    }

    if (query.action) {
      params.push(query.action);
      conditions.push(`action = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await this.database.query<any>(
      `SELECT COUNT(*) AS total FROM admin_audit_logs ${whereClause}`,
      params
    );
    const total = parseInt(countRes.rows[0]?.total || '0', 10);

    const limitParamIndex = params.length + 1;
    const offsetParamIndex = params.length + 2;
    params.push(pageSize, offset);

    const logsRes = await this.database.query<any>(
      `SELECT id, admin_user_id AS "adminUserId", action, target_user_id AS "targetUserId",
              target_resource_type AS "targetResourceType", target_resource_id AS "targetResourceId",
              previous_state AS "previousState", new_state AS "newState", reason,
              ip_address AS "ipAddress", user_agent AS "userAgent", created_at AS "createdAt"
       FROM admin_audit_logs
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}`,
      params
    );

    return {
      logs: logsRes.rows,
      total,
    };
  }
}

export const auditService = new AuditService();
