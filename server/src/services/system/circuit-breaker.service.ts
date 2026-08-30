import { db, IDatabaseConnection } from '../../config/database';
import { auditService, AuditService } from '../admin/audit.service';
import {
  CircuitBreakerMode,
  SystemSubsystem,
  SystemCircuitBreakerEntity,
  HaltCircuitBreakerDto,
  ResumeCircuitBreakerDto,
  PublicCircuitBreakerStatus,
} from '../../models/system.model';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../config/logger';

export class CircuitBreakerService {
  private audit: AuditService;
  private cachedState: SystemCircuitBreakerEntity | null = null;
  private cachedAt: number = 0;
  /** Cache TTL in milliseconds — prevents multi-node staleness. */
  private readonly cacheTTLMs = 3000;

  constructor(
    private database: IDatabaseConnection = db,
    audit?: AuditService
  ) {
    this.audit = audit || new AuditService(database);
  }

  /**
   * Reset in-memory cached state (for testing and synchronized reload)
   */
  public resetCache(): void {
    this.cachedState = null;
    this.cachedAt = 0;
  }

  /**
   * Fetch current circuit breaker operational state.
   * Fail-closed: when the DB row is missing or the query fails, the system
   * defaults to HALT_ALL in **production** (trading halts) and to
   * SYSTEM_ACTIVE in dev/test (migration 014 seeds the row).
   * Cache is refreshed every `cacheTTLMs` milliseconds so multi-node
   * halt/resume propagates within a bounded time window.
   */
  public async getState(): Promise<SystemCircuitBreakerEntity> {
    const now = Date.now();
    if (this.cachedState && (now - this.cachedAt) < this.cacheTTLMs) {
      return this.cachedState;
    }

    let row: any;
    try {
      const res = await this.database.query<any>(
        `SELECT id, mode,
                is_spot_trading_enabled AS "isSpotTradingEnabled",
                is_futures_trading_enabled AS "isFuturesTradingEnabled",
                is_withdrawals_enabled AS "isWithdrawalsEnabled",
                is_deposits_enabled AS "isDepositsEnabled",
                halt_reason AS "haltReason",
                halted_by AS "haltedBy",
                updated_at AS "updatedAt"
         FROM system_circuit_breakers
         WHERE id = 'SYSTEM_GLOBAL'`
      );
      row = res.rows[0];
    } catch (err: any) {
      // DB query failure — fail closed
      logger.error('Circuit breaker state query failed, defaulting to fail-closed', { error: err.message });
      const failClosed: SystemCircuitBreakerEntity = {
        id: 'SYSTEM_GLOBAL',
        mode: 'HALT_ALL',
        isSpotTradingEnabled: false,
        isFuturesTradingEnabled: false,
        isWithdrawalsEnabled: false,
        isDepositsEnabled: false,
        haltReason: 'CIRCUIT_BREAKER_STATE_UNAVAILABLE',
        haltedBy: null,
        updatedAt: new Date(),
      };
      this.cachedState = failClosed;
      this.cachedAt = now;
      return failClosed;
    }

    if (!row) {
      // Missing row — fail closed in production, default active in dev/test
      if (process.env.NODE_ENV === 'production') {
        const failClosed: SystemCircuitBreakerEntity = {
          id: 'SYSTEM_GLOBAL',
          mode: 'HALT_ALL',
          isSpotTradingEnabled: false,
          isFuturesTradingEnabled: false,
          isWithdrawalsEnabled: false,
          isDepositsEnabled: false,
          haltReason: 'CIRCUIT_BREAKER_STATE_MISSING',
          haltedBy: null,
          updatedAt: new Date(),
        };
        this.cachedState = failClosed;
        this.cachedAt = now;
        return failClosed;
      }
      // Default fallback for dev/test environments
      const defaultState: SystemCircuitBreakerEntity = {
        id: 'SYSTEM_GLOBAL',
        mode: 'SYSTEM_ACTIVE',
        isSpotTradingEnabled: true,
        isFuturesTradingEnabled: true,
        isWithdrawalsEnabled: true,
        isDepositsEnabled: true,
        haltReason: null,
        haltedBy: null,
        updatedAt: new Date(),
      };
      this.cachedState = defaultState;
      this.cachedAt = now;
      return defaultState;
    }

    const state: SystemCircuitBreakerEntity = {
      id: row.id,
      mode: row.mode,
      isSpotTradingEnabled: Boolean(row.isSpotTradingEnabled),
      isFuturesTradingEnabled: Boolean(row.isFuturesTradingEnabled),
      isWithdrawalsEnabled: Boolean(row.isWithdrawalsEnabled),
      isDepositsEnabled: Boolean(row.isDepositsEnabled),
      haltReason: row.haltReason || null,
      haltedBy: row.haltedBy || null,
      updatedAt: row.updatedAt ? new Date(row.updatedAt) : new Date(),
    };

    this.cachedState = state;
    this.cachedAt = Date.now();
    return state;
  }

  /**
   * Fast pre-flight check for specific subsystem
   */
  public async isSubsystemOperational(
    subsystem: SystemSubsystem
  ): Promise<{ operational: boolean; reason?: string | null; mode: CircuitBreakerMode }> {
    const state = await this.getState();

    let operational = true;
    switch (subsystem) {
      case 'SPOT_TRADING':
        operational = state.isSpotTradingEnabled;
        break;
      case 'FUTURES_TRADING':
        operational = state.isFuturesTradingEnabled;
        break;
      case 'WITHDRAWALS':
        operational = state.isWithdrawalsEnabled;
        break;
      case 'DEPOSITS':
        operational = state.isDepositsEnabled;
        break;
    }

    return {
      operational,
      reason: state.haltReason,
      mode: state.mode,
    };
  }

  /**
   * Trigger emergency halt on system or specific subsystems
   */
  public async halt(dto: HaltCircuitBreakerDto): Promise<SystemCircuitBreakerEntity> {
    if (!dto.reason || !dto.reason.trim()) {
      throw new AppError('A valid operational reason is required to trigger a circuit breaker halt', 400, 'MISSING_REASON');
    }

    const currentState = await this.getState();

    let spot = false;
    let futures = false;
    let withdrawals = false;
    let deposits = false;

    switch (dto.mode) {
      case 'HALT_ALL':
        spot = false;
        futures = false;
        withdrawals = false;
        deposits = false;
        break;
      case 'HALT_TRADING':
        spot = false;
        futures = false;
        withdrawals = dto.isWithdrawalsEnabled !== undefined ? dto.isWithdrawalsEnabled : true;
        deposits = dto.isDepositsEnabled !== undefined ? dto.isDepositsEnabled : true;
        break;
      case 'HALT_WITHDRAWALS':
        spot = dto.isSpotTradingEnabled !== undefined ? dto.isSpotTradingEnabled : true;
        futures = dto.isFuturesTradingEnabled !== undefined ? dto.isFuturesTradingEnabled : true;
        withdrawals = false;
        deposits = dto.isDepositsEnabled !== undefined ? dto.isDepositsEnabled : true;
        break;
      case 'CUSTOM':
        spot = dto.isSpotTradingEnabled !== undefined ? dto.isSpotTradingEnabled : currentState.isSpotTradingEnabled;
        futures = dto.isFuturesTradingEnabled !== undefined ? dto.isFuturesTradingEnabled : currentState.isFuturesTradingEnabled;
        withdrawals = dto.isWithdrawalsEnabled !== undefined ? dto.isWithdrawalsEnabled : currentState.isWithdrawalsEnabled;
        deposits = dto.isDepositsEnabled !== undefined ? dto.isDepositsEnabled : currentState.isDepositsEnabled;
        break;
      default:
        throw new AppError(`Invalid halt mode: ${dto.mode}`, 400, 'INVALID_HALT_MODE');
    }

    const res = await this.database.query<any>(
      `INSERT INTO system_circuit_breakers (
        id, mode, is_spot_trading_enabled, is_futures_trading_enabled,
        is_withdrawals_enabled, is_deposits_enabled, halt_reason, halted_by, updated_at
      ) VALUES ('SYSTEM_GLOBAL', $1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (id) DO UPDATE SET
        mode = EXCLUDED.mode,
        is_spot_trading_enabled = EXCLUDED.is_spot_trading_enabled,
        is_futures_trading_enabled = EXCLUDED.is_futures_trading_enabled,
        is_withdrawals_enabled = EXCLUDED.is_withdrawals_enabled,
        is_deposits_enabled = EXCLUDED.is_deposits_enabled,
        halt_reason = EXCLUDED.halt_reason,
        halted_by = EXCLUDED.halted_by,
        updated_at = NOW()
      RETURNING id, mode,
                is_spot_trading_enabled AS "isSpotTradingEnabled",
                is_futures_trading_enabled AS "isFuturesTradingEnabled",
                is_withdrawals_enabled AS "isWithdrawalsEnabled",
                is_deposits_enabled AS "isDepositsEnabled",
                halt_reason AS "haltReason",
                halted_by AS "haltedBy",
                updated_at AS "updatedAt"`,
      [dto.mode, spot, futures, withdrawals, deposits, dto.reason.trim(), dto.adminUserId]
    );

    const newState: SystemCircuitBreakerEntity = {
      id: res.rows[0].id,
      mode: res.rows[0].mode,
      isSpotTradingEnabled: Boolean(res.rows[0].isSpotTradingEnabled),
      isFuturesTradingEnabled: Boolean(res.rows[0].isFuturesTradingEnabled),
      isWithdrawalsEnabled: Boolean(res.rows[0].isWithdrawalsEnabled),
      isDepositsEnabled: Boolean(res.rows[0].isDepositsEnabled),
      haltReason: res.rows[0].haltReason,
      haltedBy: res.rows[0].haltedBy,
      updatedAt: new Date(res.rows[0].updatedAt),
    };

    this.cachedState = newState;
    this.cachedAt = Date.now();

    // Record immutable audit log
    await this.audit.record({
      adminUserId: dto.adminUserId,
      action: 'SYSTEM_HALT',
      targetResourceType: 'SYSTEM',
      targetResourceId: 'SYSTEM_GLOBAL',
      previousState: {
        mode: currentState.mode,
        spot: currentState.isSpotTradingEnabled,
        futures: currentState.isFuturesTradingEnabled,
        withdrawals: currentState.isWithdrawalsEnabled,
        deposits: currentState.isDepositsEnabled,
      },
      newState: {
        mode: newState.mode,
        spot: newState.isSpotTradingEnabled,
        futures: newState.isFuturesTradingEnabled,
        withdrawals: newState.isWithdrawalsEnabled,
        deposits: newState.isDepositsEnabled,
      },
      reason: dto.reason.trim(),
      ipAddress: dto.ipAddress,
      userAgent: dto.userAgent,
    });

    logger.warn('SYSTEM CIRCUIT BREAKER HALT TRIGGERED', {
      adminUserId: dto.adminUserId,
      mode: dto.mode,
      reason: dto.reason,
    });

    return newState;
  }

  /**
   * Resume operations
   */
  public async resume(dto: ResumeCircuitBreakerDto): Promise<SystemCircuitBreakerEntity> {
    if (!dto.reason || !dto.reason.trim()) {
      throw new AppError('A valid operational reason is required to resume operations', 400, 'MISSING_REASON');
    }

    const currentState = await this.getState();

    let mode: CircuitBreakerMode = 'SYSTEM_ACTIVE';
    let spot = true;
    let futures = true;
    let withdrawals = true;
    let deposits = true;

    if (!dto.resumeAll) {
      spot = dto.isSpotTradingEnabled !== undefined ? dto.isSpotTradingEnabled : currentState.isSpotTradingEnabled;
      futures = dto.isFuturesTradingEnabled !== undefined ? dto.isFuturesTradingEnabled : currentState.isFuturesTradingEnabled;
      withdrawals = dto.isWithdrawalsEnabled !== undefined ? dto.isWithdrawalsEnabled : currentState.isWithdrawalsEnabled;
      deposits = dto.isDepositsEnabled !== undefined ? dto.isDepositsEnabled : currentState.isDepositsEnabled;

      if (spot && futures && withdrawals && deposits) {
        mode = 'SYSTEM_ACTIVE';
      } else {
        mode = 'CUSTOM';
      }
    }

    const res = await this.database.query<any>(
      `INSERT INTO system_circuit_breakers (
        id, mode, is_spot_trading_enabled, is_futures_trading_enabled,
        is_withdrawals_enabled, is_deposits_enabled, halt_reason, halted_by, updated_at
      ) VALUES ('SYSTEM_GLOBAL', $1, $2, $3, $4, $5, NULL, NULL, NOW())
      ON CONFLICT (id) DO UPDATE SET
        mode = EXCLUDED.mode,
        is_spot_trading_enabled = EXCLUDED.is_spot_trading_enabled,
        is_futures_trading_enabled = EXCLUDED.is_futures_trading_enabled,
        is_withdrawals_enabled = EXCLUDED.is_withdrawals_enabled,
        is_deposits_enabled = EXCLUDED.is_deposits_enabled,
        halt_reason = NULL,
        halted_by = NULL,
        updated_at = NOW()
      RETURNING id, mode,
                is_spot_trading_enabled AS "isSpotTradingEnabled",
                is_futures_trading_enabled AS "isFuturesTradingEnabled",
                is_withdrawals_enabled AS "isWithdrawalsEnabled",
                is_deposits_enabled AS "isDepositsEnabled",
                halt_reason AS "haltReason",
                halted_by AS "haltedBy",
                updated_at AS "updatedAt"`,
      [mode, spot, futures, withdrawals, deposits]
    );

    const newState: SystemCircuitBreakerEntity = {
      id: res.rows[0].id,
      mode: res.rows[0].mode,
      isSpotTradingEnabled: Boolean(res.rows[0].isSpotTradingEnabled),
      isFuturesTradingEnabled: Boolean(res.rows[0].isFuturesTradingEnabled),
      isWithdrawalsEnabled: Boolean(res.rows[0].isWithdrawalsEnabled),
      isDepositsEnabled: Boolean(res.rows[0].isDepositsEnabled),
      haltReason: null,
      haltedBy: null,
      updatedAt: new Date(res.rows[0].updatedAt),
    };

    this.cachedState = newState;
    this.cachedAt = Date.now();

    // Record immutable audit log
    await this.audit.record({
      adminUserId: dto.adminUserId,
      action: 'SYSTEM_RESUME',
      targetResourceType: 'SYSTEM',
      targetResourceId: 'SYSTEM_GLOBAL',
      previousState: {
        mode: currentState.mode,
        spot: currentState.isSpotTradingEnabled,
        futures: currentState.isFuturesTradingEnabled,
        withdrawals: currentState.isWithdrawalsEnabled,
        deposits: currentState.isDepositsEnabled,
      },
      newState: {
        mode: newState.mode,
        spot: newState.isSpotTradingEnabled,
        futures: newState.isFuturesTradingEnabled,
        withdrawals: newState.isWithdrawalsEnabled,
        deposits: newState.isDepositsEnabled,
      },
      reason: dto.reason.trim(),
      ipAddress: dto.ipAddress,
      userAgent: dto.userAgent,
    });

    logger.info('SYSTEM CIRCUIT BREAKER RESUMED', {
      adminUserId: dto.adminUserId,
      mode,
      reason: dto.reason,
    });

    return newState;
  }

  /**
   * Get public sanitized status
   */
  public async getPublicStatus(): Promise<PublicCircuitBreakerStatus> {
    const state = await this.getState();
    const isOperational =
      state.isSpotTradingEnabled &&
      state.isFuturesTradingEnabled &&
      state.isWithdrawalsEnabled &&
      state.isDepositsEnabled;

    return {
      isOperational,
      mode: state.mode,
      subsystems: {
        spotTrading: state.isSpotTradingEnabled,
        futuresTrading: state.isFuturesTradingEnabled,
        withdrawals: state.isWithdrawalsEnabled,
        deposits: state.isDepositsEnabled,
      },
      haltReason: state.haltReason,
      updatedAt: state.updatedAt,
    };
  }
}

export const circuitBreakerService = new CircuitBreakerService();
