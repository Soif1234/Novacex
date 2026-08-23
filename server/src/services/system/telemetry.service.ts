import { logger } from '../../config/logger';
import { env } from '../../config/env';
import { db } from '../../config/database';
import { redis } from '../../config/redis';
import { workerSupervisor } from '../../workers/WorkerSupervisor';

export interface HistogramSnapshot {
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p90: number;
  p99: number;
}

export class Histogram {
  private values: number[] = [];
  private sum = 0;
  private count = 0;
  private min = Infinity;
  private max = -Infinity;
  private maxSamples = 1000;

  constructor(maxSamples = 1000) {
    this.maxSamples = maxSamples;
  }

  public observe(val: number): void {
    if (typeof val !== 'number' || isNaN(val) || !isFinite(val)) return;

    this.count++;
    this.sum += val;
    if (val < this.min) this.min = val;
    if (val > this.max) this.max = val;

    if (this.values.length < this.maxSamples) {
      this.values.push(val);
    } else {
      // Reservoir sampling or ring buffer replacement
      const idx = Math.floor(Math.random() * this.count);
      if (idx < this.maxSamples) {
        this.values[idx] = val;
      }
    }
  }

  public getSnapshot(): HistogramSnapshot {
    if (this.count === 0) {
      return { count: 0, sum: 0, min: 0, max: 0, avg: 0, p50: 0, p90: 0, p99: 0 };
    }

    const sorted = [...this.values].sort((a, b) => a - b);
    const getPercentile = (p: number): number => {
      if (sorted.length === 0) return 0;
      const index = Math.floor((p / 100) * (sorted.length - 1));
      return sorted[index];
    };

    return {
      count: this.count,
      sum: this.sum,
      min: this.min === Infinity ? 0 : this.min,
      max: this.max === -Infinity ? 0 : this.max,
      avg: this.count > 0 ? this.sum / this.count : 0,
      p50: getPercentile(50),
      p90: getPercentile(90),
      p99: getPercentile(99),
    };
  }

  public reset(): void {
    this.values = [];
    this.sum = 0;
    this.count = 0;
    this.min = Infinity;
    this.max = -Infinity;
  }
}

export class TelemetryService {
  // Counters: key -> value
  private counters = new Map<string, number>();

  // Gauges: key -> value
  private gauges = new Map<string, number>();

  // Histograms: key -> Histogram
  private histograms = new Map<string, Histogram>();

  private startTime = Date.now();

  /**
   * Safe counter increment with try/catch error boundary
   */
  public incrementCounter(name: string, labels: Record<string, string | number> = {}, amount = 1): void {
    try {
      const key = this.formatMetricKey(name, labels);
      const current = this.counters.get(key) || 0;
      this.counters.set(key, current + amount);
    } catch (err) {
      logger.debug('Telemetry incrementCounter failed silently', { name, error: (err as Error).message });
    }
  }

  /**
   * Safe gauge set with try/catch error boundary
   */
  public setGauge(name: string, value: number, labels: Record<string, string | number> = {}): void {
    try {
      const key = this.formatMetricKey(name, labels);
      this.gauges.set(key, value);
    } catch (err) {
      logger.debug('Telemetry setGauge failed silently', { name, error: (err as Error).message });
    }
  }

  /**
   * Safe histogram observe with try/catch error boundary
   */
  public observeHistogram(name: string, value: number, labels: Record<string, string | number> = {}): void {
    try {
      const key = this.formatMetricKey(name, labels);
      let histogram = this.histograms.get(key);
      if (!histogram) {
        histogram = new Histogram();
        this.histograms.set(key, histogram);
      }
      histogram.observe(value);
    } catch (err) {
      logger.debug('Telemetry observeHistogram failed silently', { name, error: (err as Error).message });
    }
  }

  /**
   * Normalize URLs to prevent label cardinality explosions (e.g. /users/uuid-123 -> /users/:id)
   */
  public normalizeRoute(path: string): string {
    if (!path) return 'unknown';
    // Strip query string
    const cleanPath = path.split('?')[0];

    return cleanPath
      // Replace UUIDs
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
      // Replace numeric IDs
      .replace(/\/\d+(?=\/|$)/g, '/:id')
      // Replace hex addresses (e.g. 0x1234...)
      .replace(/0x[a-fA-F0-9]{10,}/g, ':address')
      // Replace symbols in standard paths if any
      .replace(/(\/orderbook\/)[A-Z0-9_-]+/i, '$1:symbol');
  }

  /**
   * Record HTTP Request Telemetry
   */
  public recordHttpRequest(method: string, rawPath: string, statusCode: number, durationMs: number): void {
    try {
      const route = this.normalizeRoute(rawPath);
      const statusClass = `${Math.floor(statusCode / 100)}xx`;

      this.incrementCounter('http_requests_total', { method: method.toUpperCase(), route, status: statusCode });
      this.incrementCounter('http_requests_by_status_class_total', { status_class: statusClass });

      if (statusCode >= 400) {
        this.incrementCounter('http_request_errors_total', { method: method.toUpperCase(), route, status: statusCode });
      }

      this.observeHistogram('http_request_duration_ms', durationMs, { method: method.toUpperCase(), route });
    } catch (err) {
      logger.debug('Telemetry recordHttpRequest failed silently', { error: (err as Error).message });
    }
  }

  /**
   * Record Database Query Telemetry
   */
  public recordDbQuery(durationMs: number, success = true, isTimeout = false): void {
    try {
      this.incrementCounter('db_queries_total');
      if (!success) {
        this.incrementCounter('db_query_errors_total');
      }
      if (isTimeout) {
        this.incrementCounter('db_query_timeouts_total');
      }
      this.observeHistogram('db_query_duration_ms', durationMs);
    } catch (err) {
      logger.debug('Telemetry recordDbQuery failed silently', { error: (err as Error).message });
    }
  }

  /**
   * Record Redis Operation Telemetry
   */
  public recordRedisOp(op: string, success = true, durationMs?: number): void {
    try {
      this.incrementCounter('redis_operations_total', { op });
      if (!success) {
        this.incrementCounter('redis_errors_total', { op });
      }
      if (durationMs !== undefined) {
        this.observeHistogram('redis_op_duration_ms', durationMs, { op });
      }
    } catch (err) {
      logger.debug('Telemetry recordRedisOp failed silently', { error: (err as Error).message });
    }
  }

  /**
   * Record Exchange Operations Telemetry
   */
  public recordOrderOperation(market: 'SPOT' | 'FUTURES', operation: 'CREATE' | 'CANCEL', status: 'SUCCESS' | 'FAILURE'): void {
    try {
      this.incrementCounter('exchange_orders_operations_total', { market, operation, status });
    } catch (err) {
      logger.debug('Telemetry recordOrderOperation failed silently', { error: (err as Error).message });
    }
  }

  /**
   * Format Metric Key with canonical sorted labels
   */
  private formatMetricKey(name: string, labels: Record<string, string | number> = {}): string {
    const keys = Object.keys(labels).sort();
    if (keys.length === 0) return name;
    const labelStr = keys.map(k => `${k}="${labels[k]}"`).join(',');
    return `${name}{${labelStr}}`;
  }

  /**
   * Generate Full Metrics Snapshot in structured JSON format
   */
  public async getMetricsJSON(): Promise<Record<string, any>> {
    try {
      const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);
      const mem = process.memoryUsage();
      const cpu = process.cpuUsage();

      // Database Status
      const dbStatus = db.getStatus();

      // Redis Status
      const redisStatus = redis.getStatus();

      // Worker Statuses
      const workerStatuses = workerSupervisor.getStatuses();

      // Format Counters
      const countersObj: Record<string, number> = {};
      for (const [k, v] of this.counters.entries()) {
        countersObj[k] = v;
      }

      // Format Gauges
      const gaugesObj: Record<string, number> = {};
      for (const [k, v] of this.gauges.entries()) {
        gaugesObj[k] = v;
      }

      // Format Histograms
      const histogramsObj: Record<string, HistogramSnapshot> = {};
      for (const [k, v] of this.histograms.entries()) {
        histogramsObj[k] = v.getSnapshot();
      }

      return {
        timestamp: new Date().toISOString(),
        system: {
          app: env.APP_NAME,
          version: env.APP_VERSION,
          nodeEnv: env.NODE_ENV,
          uptimeSeconds,
          nodeVersion: process.version,
          memory: {
            heapUsedBytes: mem.heapUsed,
            heapTotalBytes: mem.heapTotal,
            rssBytes: mem.rss,
            externalBytes: mem.external,
          },
          cpu: {
            userMicroseconds: cpu.user,
            systemMicroseconds: cpu.system,
          },
        },
        database: {
          connected: dbStatus.connected,
          poolSize: dbStatus.poolSize,
          activeConnections: dbStatus.activeConnections,
          idleConnections: dbStatus.idleConnections,
          waitingClients: dbStatus.waitingClients ?? 0,
          config: dbStatus.config,
          metrics: {
            queriesTotal: this.counters.get('db_queries_total') || 0,
            queryErrorsTotal: this.counters.get('db_query_errors_total') || 0,
            queryTimeoutsTotal: this.counters.get('db_query_timeouts_total') || 0,
            latency: this.histograms.get('db_query_duration_ms')?.getSnapshot() || { count: 0, avg: 0, p50: 0, p99: 0 },
          },
        },
        redis: {
          connected: redisStatus.connected,
          mode: redisStatus.mode,
          reconnectAttempts: redisStatus.reconnectAttempts,
          host: redisStatus.host,
          port: redisStatus.port,
          metrics: {
            operationsTotal: Array.from(this.counters.entries())
              .filter(([k]) => k.startsWith('redis_operations_total'))
              .reduce((sum, [, v]) => sum + v, 0),
            errorsTotal: Array.from(this.counters.entries())
              .filter(([k]) => k.startsWith('redis_errors_total'))
              .reduce((sum, [, v]) => sum + v, 0),
          },
        },
        workers: workerStatuses,
        http: {
          totalRequests: Array.from(this.counters.entries())
            .filter(([k]) => k.startsWith('http_requests_total'))
            .reduce((sum, [, v]) => sum + v, 0),
          totalErrors: Array.from(this.counters.entries())
            .filter(([k]) => k.startsWith('http_request_errors_total'))
            .reduce((sum, [, v]) => sum + v, 0),
          counters: countersObj,
          histograms: histogramsObj,
        },
        customGauges: gaugesObj,
      };
    } catch (err) {
      logger.error('Failed to generate telemetry metrics JSON', { error: (err as Error).message });
      return {
        timestamp: new Date().toISOString(),
        error: 'Telemetry serialization error',
      };
    }
  }

  /**
   * Export in Prometheus OpenMetrics exposition text format
   */
  public async getPrometheusFormat(): Promise<string> {
    try {
      const lines: string[] = [];
      lines.push('# HELP process_uptime_seconds The process uptime in seconds.');
      lines.push('# TYPE process_uptime_seconds gauge');
      lines.push(`process_uptime_seconds ${Math.floor((Date.now() - this.startTime) / 1000)}`);

      const mem = process.memoryUsage();
      lines.push('# HELP process_memory_heap_used_bytes Process memory heap used in bytes.');
      lines.push('# TYPE process_memory_heap_used_bytes gauge');
      lines.push(`process_memory_heap_used_bytes ${mem.heapUsed}`);

      // Database
      const dbStatus = db.getStatus();
      lines.push('# HELP db_pool_active_connections Number of active database pool connections.');
      lines.push('# TYPE db_pool_active_connections gauge');
      lines.push(`db_pool_active_connections ${dbStatus.activeConnections}`);

      lines.push('# HELP db_pool_idle_connections Number of idle database pool connections.');
      lines.push('# TYPE db_pool_idle_connections gauge');
      lines.push(`db_pool_idle_connections ${dbStatus.idleConnections}`);

      // Redis
      const redisStatus = redis.getStatus();
      lines.push('# HELP redis_connected Whether Redis is actively connected (1) or disconnected (0).');
      lines.push('# TYPE redis_connected gauge');
      lines.push(`redis_connected ${redisStatus.connected ? 1 : 0}`);

      // Custom Counters
      for (const [k, v] of this.counters.entries()) {
        lines.push(`${k} ${v}`);
      }

      // Custom Gauges
      for (const [k, v] of this.gauges.entries()) {
        lines.push(`${k} ${v}`);
      }

      return lines.join('\n') + '\n';
    } catch (err) {
      return `# Error generating Prometheus metrics: ${(err as Error).message}\n`;
    }
  }

  public reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.startTime = Date.now();
  }
}

export const telemetryService = new TelemetryService();
