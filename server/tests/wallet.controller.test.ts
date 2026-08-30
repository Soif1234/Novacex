import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDepositAddress } from '../src/controllers/wallet.controller';
import { depositAddressService } from '../src/services/custody/deposit-address.service';
import { Request, Response, NextFunction } from 'express';
import { AppError } from '../src/middleware/errorHandler';

vi.mock('../src/services/custody/deposit-address.service', () => ({
  depositAddressService: {
    getOrCreateDepositAddress: vi.fn(),
  },
}));

describe('wallet.controller.ts - getDepositAddress', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    req = { query: {} };
    res = {
      json: vi.fn(),
      status: vi.fn().mockReturnThis(),
    };
    next = vi.fn();
    vi.clearAllMocks();
  });

  it('A. unauthenticated request rejected (B)', async () => {
    await getDepositAddress(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    const error = vi.mocked(next).mock.calls[0][0] as AppError;
    expect(error.statusCode).toBe(401);
  });

  it('B. user cannot specify another user ID (C)', async () => {
    req.user = { id: 'user-123', email: 'test@novacex.io', role: 'USER', isActive: true, kycLevel: 'TIER_1', '2faEnabled': false } as any;
    req.query = { asset: 'USDT', network: 'ETHEREUM', userId: 'hacker-user' };

    vi.mocked(depositAddressService.getOrCreateDepositAddress).mockResolvedValueOnce({
      userId: 'user-123',
      asset: 'USDT',
      network: 'ETHEREUM',
      blockchainAddress: '0xAddress',
      status: 'ACTIVE',
    } as any);

    await getDepositAddress(req as Request, res as Response, next);

    expect(depositAddressService.getOrCreateDepositAddress).toHaveBeenCalledWith({
      userId: 'user-123', // Still uses auth token user ID!
      asset: 'USDT',
      network: 'ETHEREUM',
    });
  });

  it('C. supported asset/network returns address (D)', async () => {
    req.user = { id: 'user-123', email: 'test@novacex.io', role: 'USER', isActive: true, kycLevel: 'TIER_1', '2faEnabled': false } as any;
    req.query = { asset: 'USDT', network: 'ETHEREUM' };

    vi.mocked(depositAddressService.getOrCreateDepositAddress).mockResolvedValueOnce({
      asset: 'USDT',
      network: 'ETHEREUM',
      blockchainAddress: '0xSupportedAddress',
      status: 'ACTIVE',
    } as any);

    await getDepositAddress(req as Request, res as Response, next);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        asset: 'USDT',
        network: 'ETHEREUM',
        address: '0xSupportedAddress',
        tag: undefined,
        status: 'ACTIVE',
      },
    });
  });

  it('D. unsupported asset/network rejected (E/F)', async () => {
    req.user = { id: 'user-123', email: 'test@novacex.io', role: 'USER', isActive: true, kycLevel: 'TIER_1', '2faEnabled': false } as any;
    req.query = { asset: 'INVALID', network: 'ETHEREUM' };

    vi.mocked(depositAddressService.getOrCreateDepositAddress).mockRejectedValueOnce(
      new AppError('Unsupported asset', 400, 'UNSUPPORTED_ASSET')
    );

    await getDepositAddress(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
  });

  it('E. repeated request returns same address (G)', async () => {
    req.user = { id: 'user-123', email: 'test@novacex.io', role: 'USER', isActive: true, kycLevel: 'TIER_1', '2faEnabled': false } as any;
    req.query = { asset: 'USDT', network: 'ETHEREUM' };

    const mockResponse = {
      asset: 'USDT',
      network: 'ETHEREUM',
      blockchainAddress: '0xSameAddress',
      status: 'ACTIVE',
    };

    vi.mocked(depositAddressService.getOrCreateDepositAddress).mockResolvedValue(mockResponse as any);

    await getDepositAddress(req as Request, res as Response, next);
    await getDepositAddress(req as Request, res as Response, next);

    expect(vi.mocked(res.json).mock.calls[0][0].data.address).toBe('0xSameAddress');
    expect(vi.mocked(res.json).mock.calls[1][0].data.address).toBe('0xSameAddress');
  });
});
