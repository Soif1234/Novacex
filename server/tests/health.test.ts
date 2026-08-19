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
      }
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
});
