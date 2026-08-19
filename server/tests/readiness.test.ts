import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HealthController } from '../src/controllers/health.controller';
import { db } from '../src/config/database';
import { redis } from '../src/config/redis';
import { Request, Response } from 'express';

describe('Readiness Controller (server/src/controllers/health.controller.ts)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Returns HTTP 200 ready when all services are healthy', async () => {
    vi.spyOn(db, 'healthCheck').mockResolvedValue({ healthy: true, latencyMs: 2 });
    vi.spyOn(redis, 'healthCheck').mockResolvedValue({ healthy: true, latencyMs: 1 });

    const req = {} as Request;
    let responseStatus = 0;
    let responseJson: any = null;

    const res = {
      status: (code: number) => {
        responseStatus = code;
        return res;
      },
      json: (data: any) => {
        responseJson = data;
        return res;
      }
    } as unknown as Response;

    await HealthController.getReadiness(req, res);

    expect(responseStatus).toBe(200);
    expect(responseJson.success).toBe(true);
    expect(responseJson.data.status).toBe('ready');
    expect(responseJson.data.checks.database.status).toBe('pass');
    expect(responseJson.data.checks.redis.status).toBe('pass');
  });

  it('2. Returns HTTP 503 unready when database is unhealthy', async () => {
    vi.spyOn(db, 'healthCheck').mockResolvedValue({ healthy: false, latencyMs: 5, error: 'Connection refused' });
    vi.spyOn(redis, 'healthCheck').mockResolvedValue({ healthy: true, latencyMs: 1 });

    const req = {} as Request;
    let responseStatus = 0;
    let responseJson: any = null;

    const res = {
      status: (code: number) => {
        responseStatus = code;
        return res;
      },
      json: (data: any) => {
        responseJson = data;
        return res;
      }
    } as unknown as Response;

    await HealthController.getReadiness(req, res);

    expect(responseStatus).toBe(503);
    expect(responseJson.success).toBe(false);
    expect(responseJson.data.status).toBe('unready');
    expect(responseJson.data.checks.database.status).toBe('fail');
    expect(responseJson.data.checks.database.error).toBe('Connection refused');
    expect(responseJson.data.checks.redis.status).toBe('pass');
  });

  it('3. Returns HTTP 503 unready when Redis is unhealthy', async () => {
    vi.spyOn(db, 'healthCheck').mockResolvedValue({ healthy: true, latencyMs: 2 });
    vi.spyOn(redis, 'healthCheck').mockResolvedValue({ healthy: false, latencyMs: 10, error: 'Redis host unreachable' });

    const req = {} as Request;
    let responseStatus = 0;
    let responseJson: any = null;

    const res = {
      status: (code: number) => {
        responseStatus = code;
        return res;
      },
      json: (data: any) => {
        responseJson = data;
        return res;
      }
    } as unknown as Response;

    await HealthController.getReadiness(req, res);

    expect(responseStatus).toBe(503);
    expect(responseJson.success).toBe(false);
    expect(responseJson.data.status).toBe('unready');
    expect(responseJson.data.checks.database.status).toBe('pass');
    expect(responseJson.data.checks.redis.status).toBe('fail');
  });
});
