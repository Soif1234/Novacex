import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateReferenceId, internalTransferService } from './InternalTransferService';
import { apiClient } from '../api/client';
import { userService } from '../user/UserService';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('PHASE 15D-5 / HIGH-03: Internal Transfer Reference ID Remediation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Scenario A: Reference generated successfully
  // --------------------------------------------------------------------------
  it('Scenario A: generates a valid reference identifier', () => {
    const ref = generateReferenceId();
    expect(ref).toBeDefined();
    expect(typeof ref).toBe('string');
    expect(ref.length).toBe(36);
  });

  // --------------------------------------------------------------------------
  // Scenario B: Reference is NOT generated using Math.random()
  // --------------------------------------------------------------------------
  it('Scenario B: does not invoke Math.random() during reference generation', () => {
    const mathRandomSpy = vi.spyOn(Math, 'random');

    const ref = generateReferenceId();

    expect(mathRandomSpy).not.toHaveBeenCalled();
    expect(ref).toMatch(UUID_V4_REGEX);
  });

  // --------------------------------------------------------------------------
  // Scenario C: 1,000 generated references are unique
  // --------------------------------------------------------------------------
  it('Scenario C: 1,000 consecutively generated references are strictly unique', () => {
    const count = 1000;
    const refs = new Set<string>();

    for (let i = 0; i < count; i++) {
      refs.add(generateReferenceId());
    }

    expect(refs.size).toBe(count);
  });

  // --------------------------------------------------------------------------
  // Scenario D: 10,000 generated references are unique
  // --------------------------------------------------------------------------
  it('Scenario D: 10,000 consecutively generated references are strictly unique', () => {
    const count = 10000;
    const refs = new Set<string>();

    for (let i = 0; i < count; i++) {
      refs.add(generateReferenceId());
    }

    expect(refs.size).toBe(count);
  });

  // --------------------------------------------------------------------------
  // Scenario E: Reference format remains compatible with backend persistence
  // --------------------------------------------------------------------------
  it('Scenario E: reference format is standard RFC 4122 UUID v4 (<= 128 characters)', () => {
    for (let i = 0; i < 50; i++) {
      const ref = generateReferenceId();
      expect(ref).toMatch(UUID_V4_REGEX);
      expect(ref.length).toBeLessThanOrEqual(128);
    }
  });

  // --------------------------------------------------------------------------
  // Scenario F: Two simultaneous transfers receive different references
  // --------------------------------------------------------------------------
  it('Scenario F: simultaneous transfers receive distinct collision-resistant reference IDs', async () => {
    const mathRandomSpy = vi.spyOn(Math, 'random');
    const capturedPayloads: any[] = [];

    vi.spyOn(apiClient, 'post').mockImplementation(async (url: string, body: any) => {
      if (url === '/wallet/transfer') {
        capturedPayloads.push(body);
        return { success: true, transactionId: `tx-${capturedPayloads.length}`, referenceId: body.referenceId };
      }
      return {};
    });

    vi.spyOn(userService, 'getSpotAccountId').mockReturnValue('spot-acc-123');
    vi.spyOn(userService, 'getFuturesAccountId').mockReturnValue('futures-acc-123');

    // Trigger two transfers concurrently
    const [res1, res2] = await Promise.all([
      internalTransferService.createTransfer('USDT', '100', 'SPOT', 'FUTURES', 'user-1'),
      internalTransferService.createTransfer('USDT', '200', 'SPOT', 'FUTURES', 'user-1'),
    ]);

    expect(mathRandomSpy).not.toHaveBeenCalled();
    expect(capturedPayloads.length).toBe(2);
    expect(capturedPayloads[0].referenceId).toBeDefined();
    expect(capturedPayloads[1].referenceId).toBeDefined();
    expect(capturedPayloads[0].referenceId).not.toBe(capturedPayloads[1].referenceId);
    expect(capturedPayloads[0].referenceId).toMatch(UUID_V4_REGEX);
    expect(capturedPayloads[1].referenceId).toMatch(UUID_V4_REGEX);
  });

  // --------------------------------------------------------------------------
  // Scenario G: Fallback via crypto.getRandomValues produces valid RFC 4122 v4
  // --------------------------------------------------------------------------
  it('Scenario G: fallback to crypto.getRandomValues adheres to RFC 4122 v4 specification', () => {
    const originalRandomUUID = crypto.randomUUID;
    try {
      // Simulate environment where crypto.randomUUID is not present
      (crypto as any).randomUUID = undefined;

      const ref = generateReferenceId();
      expect(ref).toMatch(UUID_V4_REGEX);
      expect(ref.length).toBe(36);
    } finally {
      (crypto as any).randomUUID = originalRandomUUID;
    }
  });

  // --------------------------------------------------------------------------
  // Scenario H: Custom reference ID allows explicit idempotency key submission
  // --------------------------------------------------------------------------
  it('Scenario H: supports caller-provided idempotency key for intentional replay', async () => {
    let capturedRef = '';
    vi.spyOn(apiClient, 'post').mockImplementation(async (url: string, body: any) => {
      if (url === '/wallet/transfer') {
        capturedRef = body.referenceId;
        return { success: true };
      }
      return {};
    });

    vi.spyOn(userService, 'getSpotAccountId').mockReturnValue('spot-acc-1');
    vi.spyOn(userService, 'getFuturesAccountId').mockReturnValue('futures-acc-1');

    await internalTransferService.createTransfer('USDT', '50', 'SPOT', 'FUTURES', 'user-1', 'custom-idempotent-key-999');

    expect(capturedRef).toBe('custom-idempotent-key-999');
  });

  // --------------------------------------------------------------------------
  // Scenario I: Input validations remain intact
  // --------------------------------------------------------------------------
  it('Scenario I: preserves business validation rules for internal transfer', async () => {
    await expect(
      internalTransferService.createTransfer('USDT', '100', 'SPOT', 'SPOT', 'user-1')
    ).rejects.toThrow('Cannot transfer to the same wallet');

    await expect(
      internalTransferService.createTransfer('USDT', '0', 'SPOT', 'FUTURES', 'user-1')
    ).rejects.toThrow('Transfer amount must be greater than zero');

    await expect(
      internalTransferService.createTransfer('USDT', '-50', 'SPOT', 'FUTURES', 'user-1')
    ).rejects.toThrow('Transfer amount must be greater than zero');
  });
});
