import { describe, it, expect, vi } from 'vitest';
import { HealthController } from '../src/controllers/health.controller';
import { Request, Response } from 'express';

describe('Health Controller (server/src/controllers/health.controller.ts)', () => {
  it('1. Returns HTTP 200 with service status, version, and uptime', () => {
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
      },
    } as unknown as Response;

    HealthController.getHealth(req, res);

    expect(responseStatus).toBe(200);
    expect(responseJson.success).toBe(true);
    expect(responseJson.data.status).toBe('pass');
    expect(responseJson.data.service).toBe('mallick-exchange-backend');
    expect(responseJson.data.version).toBe('1.0.0');
    expect(typeof responseJson.data.uptime).toBe('number');
    expect(responseJson.data.timestamp).toBeDefined();
  });

  it('2. Liveness Probe: returns HTTP 200 alive without querying database or Redis', () => {
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
      },
    } as unknown as Response;

    HealthController.getLiveness(req, res);

    expect(responseStatus).toBe(200);
    expect(responseJson.success).toBe(true);
    expect(responseJson.data.status).toBe('alive');
    expect(responseJson.data.service).toBe('mallick-exchange-backend');
    expect(responseJson.data.version).toBe('1.0.0');
    expect(typeof responseJson.data.uptime).toBe('number');
  });

  it('3. Detailed Health: returns comprehensive subsystem diagnostics without sensitive info leakage', async () => {
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
      },
    } as unknown as Response;

    await HealthController.getDetailedHealth(req, res);

    expect(responseStatus).toBe(200);
    expect(responseJson.success).toBe(true);
    expect(responseJson.data.service).toBe('mallick-exchange-backend');
    expect(responseJson.data.database.connected).toBeDefined();
    expect(responseJson.data.redis.connected).toBeDefined();
    expect(responseJson.data.workers).toBeDefined();
    expect(responseJson.data.circuitBreaker).toBeDefined();

    // Verify zero sensitive data leakage
    const raw = JSON.stringify(responseJson);
    expect(raw).not.toContain('password');
    expect(raw).not.toContain('secret');
    expect(raw).not.toContain('privateKey');
    expect(raw).not.toContain('mallick_pass');
  });
});
