import { describe, it, expect, beforeEach } from 'vitest';
import { telemetryService, Histogram } from '../src/services/system/telemetry.service';
import { AdminController } from '../src/controllers/admin.controller';
import { Request, Response } from 'express';

describe('Phase 8.4.1: Operational Metrics & System Telemetry Tests', () => {
  beforeEach(() => {
    telemetryService.reset();
  });

  it('1. Histogram computes statistics and percentiles correctly', () => {
    const hist = new Histogram(500);
    for (let i = 1; i <= 100; i++) {
      hist.observe(i);
    }

    const snapshot = hist.getSnapshot();
    expect(snapshot.count).toBe(100);
    expect(snapshot.sum).toBe(5050);
    expect(snapshot.min).toBe(1);
    expect(snapshot.max).toBe(100);
    expect(snapshot.avg).toBe(50.5);
    expect(snapshot.p50).toBe(50);
    expect(snapshot.p90).toBe(90);
    expect(snapshot.p99).toBe(99);
  });

  it('2. Counters and Gauges record values with canonical label formatting', async () => {
    telemetryService.incrementCounter('test_counter', { route: '/api/v1/spot/orders', method: 'POST' });
    telemetryService.incrementCounter('test_counter', { method: 'POST', route: '/api/v1/spot/orders' }, 2);
    telemetryService.setGauge('test_gauge', 42, { pool: 'master' });

    const metrics = await telemetryService.getMetricsJSON();
    expect(metrics.http.counters['test_counter{method="POST",route="/api/v1/spot/orders"}']).toBe(3);
    expect(metrics.customGauges['test_gauge{pool="master"}']).toBe(42);
  });

  it('3. Route normalization strips dynamic identifiers to prevent cardinality explosions', () => {
    expect(telemetryService.normalizeRoute('/api/v1/users/e9a4bb3d-9b14-40d4-877a-a95aa4e1d51a/profile')).toBe('/api/v1/users/:id/profile');
    expect(telemetryService.normalizeRoute('/api/v1/spot/orders/123456')).toBe('/api/v1/spot/orders/:id');
    expect(telemetryService.normalizeRoute('/api/v1/futures/positions/0x71C845136CE3E533ac360288863f69')).toBe('/api/v1/futures/positions/:address');
    expect(telemetryService.normalizeRoute('/api/v1/market/orderbook/BTCUSDT?depth=20')).toBe('/api/v1/market/orderbook/:symbol');
  });

  it('4. HTTP telemetry recording captures status codes, latencies, and status classes', async () => {
    telemetryService.recordHttpRequest('GET', '/api/v1/spot/orderbook/BTCUSDT', 200, 15);
    telemetryService.recordHttpRequest('POST', '/api/v1/spot/orders', 201, 35);
    telemetryService.recordHttpRequest('GET', '/api/v1/invalid', 404, 5);
    telemetryService.recordHttpRequest('POST', '/api/v1/error', 500, 120);

    const metrics = await telemetryService.getMetricsJSON();
    expect(metrics.http.totalRequests).toBe(4);
    expect(metrics.http.totalErrors).toBe(2);
    expect(metrics.http.counters['http_requests_by_status_class_total{status_class="2xx"}']).toBe(2);
    expect(metrics.http.counters['http_requests_by_status_class_total{status_class="4xx"}']).toBe(1);
    expect(metrics.http.counters['http_requests_by_status_class_total{status_class="5xx"}']).toBe(1);
  });

  it('5. Database query telemetry records queries, errors, and timeouts', async () => {
    telemetryService.recordDbQuery(12, true, false);
    telemetryService.recordDbQuery(150, false, false);
    telemetryService.recordDbQuery(5000, false, true);

    const metrics = await telemetryService.getMetricsJSON();
    expect(metrics.database.metrics.queriesTotal).toBe(3);
    expect(metrics.database.metrics.queryErrorsTotal).toBe(2);
    expect(metrics.database.metrics.queryTimeoutsTotal).toBe(1);
  });

  it('6. Redis operations telemetry records operations, errors, and latencies', async () => {
    telemetryService.recordRedisOp('get', true, 2);
    telemetryService.recordRedisOp('set', true, 3);
    telemetryService.recordRedisOp('del', false, 10);

    const metrics = await telemetryService.getMetricsJSON();
    expect(metrics.redis.metrics.operationsTotal).toBe(3);
    expect(metrics.redis.metrics.errorsTotal).toBe(1);
  });

  it('7. Exchange domain operations telemetry records order operations without sensitive data', async () => {
    telemetryService.recordOrderOperation('SPOT', 'CREATE', 'SUCCESS');
    telemetryService.recordOrderOperation('FUTURES', 'CREATE', 'SUCCESS');
    telemetryService.recordOrderOperation('SPOT', 'CANCEL', 'FAILURE');

    const metrics = await telemetryService.getMetricsJSON();
    expect(metrics.http.counters['exchange_orders_operations_total{market="SPOT",operation="CREATE",status="SUCCESS"}']).toBe(1);
    expect(metrics.http.counters['exchange_orders_operations_total{market="FUTURES",operation="CREATE",status="SUCCESS"}']).toBe(1);
    expect(metrics.http.counters['exchange_orders_operations_total{market="SPOT",operation="CANCEL",status="FAILURE"}']).toBe(1);
  });

  it('8. Failure isolation: telemetry errors never throw or disrupt application execution', () => {
    expect(() => {
      telemetryService.recordHttpRequest(null as any, undefined as any, NaN, Infinity);
      telemetryService.incrementCounter('broken', { [Symbol('bad') as any]: 'val' });
      telemetryService.observeHistogram('bad_hist', NaN);
      telemetryService.setGauge('bad_gauge', NaN);
    }).not.toThrow();
  });

  it('9. Sensitive data protection: JSON and Prometheus exports contain no secrets or PII', async () => {
    telemetryService.recordHttpRequest('POST', '/api/v1/auth/login', 200, 45);
    telemetryService.recordOrderOperation('SPOT', 'CREATE', 'SUCCESS');

    const json = await telemetryService.getMetricsJSON();
    const prom = await telemetryService.getPrometheusFormat();

    const rawExport = JSON.stringify(json) + prom;
    expect(rawExport).not.toContain('password');
    expect(rawExport).not.toContain('secret');
    expect(rawExport).not.toContain('privateKey');
    expect(rawExport).not.toContain('authorization');
    expect(rawExport).not.toContain('token');
  });

  it('10. Prometheus exposition format outputs valid text metric series', async () => {
    telemetryService.incrementCounter('app_events_total', { type: 'deposit' }, 5);
    telemetryService.setGauge('app_active_ws_connections', 12);

    const text = await telemetryService.getPrometheusFormat();
    expect(text).toContain('# HELP process_uptime_seconds');
    expect(text).toContain('# TYPE process_uptime_seconds gauge');
    expect(text).toContain('db_pool_active_connections');
    expect(text).toContain('redis_connected');
    expect(text).toContain('app_events_total{type="deposit"} 5');
    expect(text).toContain('app_active_ws_connections 12');
  });

  it('11. AdminController.getMetrics and getPrometheusMetrics return serialized payloads correctly', async () => {
    let jsonResult: any;
    let jsonStatusCode = 0;
    const mockJsonRes = {
      status: (code: number) => {
        jsonStatusCode = code;
        return {
          json: (data: any) => {
            jsonResult = data;
          },
        };
      },
    } as unknown as Response;

    await AdminController.getMetrics({} as Request, mockJsonRes, () => {});
    expect(jsonStatusCode).toBe(200);
    expect(jsonResult.success).toBe(true);
    expect(jsonResult.data.system.app).toBeDefined();
    expect(jsonResult.data.database.connected).toBeDefined();
    expect(jsonResult.data.redis.connected).toBeDefined();

    let promText = '';
    let promStatusCode = 0;
    let contentType = '';
    const mockPromRes = {
      setHeader: (header: string, val: string) => {
        if (header.toLowerCase() === 'content-type') contentType = val;
      },
      status: (code: number) => {
        promStatusCode = code;
        return {
          send: (text: string) => {
            promText = text;
          },
        };
      },
    } as unknown as Response;

    await AdminController.getPrometheusMetrics({} as Request, mockPromRes, () => {});
    expect(promStatusCode).toBe(200);
    expect(contentType).toContain('text/plain');
    expect(promText).toContain('process_uptime_seconds');
  });
});
