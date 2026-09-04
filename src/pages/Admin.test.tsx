import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { expect, test, describe, beforeEach, vi } from 'vitest';
import { Admin } from './Admin';
import { apiClient } from '../services/api/client';

const mockAdminUser = {
  id: 'usr-admin-1',
  email: 'admin@novacex.io',
  role: 'ADMIN',
  twoFactorEnabled: true,
};

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: mockAdminUser,
    isAuthenticated: true,
  }),
}));

vi.mock('../services/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
  },
  ApiClientError: class ApiClientError extends Error {
    statusCode: number;
    errorCode: string;
    constructor(message: string, statusCode: number, errorCode = 'UNKNOWN') {
      super(message);
      this.name = 'ApiClientError';
      this.statusCode = statusCode;
      this.errorCode = errorCode;
    }
  },
}));

describe('Phase 15B.4: Admin Operations UI (Withdrawals & Treasury)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();

    // Default mock responses
    (apiClient.get as any).mockImplementation((url: string) => {
      if (url === '/admin/metrics') {
        return Promise.resolve({ http: { totalRequests: 10, status2xx: 10 } });
      }
      if (url === '/circuit-breaker/status') {
        return Promise.resolve({ isHalted: false, subsystems: {} });
      }
      if (url === '/admin/withdrawals/pending') {
        return Promise.resolve({
          data: [
            {
              id: 'w-ready-1',
              userId: 'u-1',
              asset: 'ETH',
              network: 'ETHEREUM',
              amount: '0.5',
              fee: '0.001',
              destinationAddress: '0x1111111111111111111111111111111111111111',
              cryptoStatus: 'READY_FOR_MANUAL_EXECUTION',
              createdAt: '2026-09-03T20:00:00Z',
            },
            {
              id: 'w-pending-2',
              userId: 'u-2',
              asset: 'USDT',
              network: 'ETHEREUM',
              amount: '1000',
              fee: '5',
              destinationAddress: '0x2222222222222222222222222222222222222222',
              cryptoStatus: 'PENDING_REVIEW',
              createdAt: '2026-09-03T20:05:00Z',
            },
            {
              id: 'w-unknown-3',
              userId: 'u-3',
              asset: 'ETH',
              network: 'ETHEREUM',
              amount: '1.2',
              fee: '0.001',
              destinationAddress: '0x3333333333333333333333333333333333333333',
              cryptoStatus: 'UNKNOWN',
              createdAt: '2026-09-03T20:10:00Z',
            },
          ],
        });
      }
      return Promise.resolve([]);
    });

    (apiClient.post as any).mockResolvedValue({ success: true, message: 'Operation successful' });
  });

  test('A. READY_FOR_MANUAL_EXECUTION shows Confirm Tx button', async () => {
    render(<Admin onNavigate={vi.fn()} />);

    // Switch to Withdrawals tab
    const withdrawalsTabBtn = screen.getByRole('button', { name: /Withdrawal Approvals & Manual Tx/i });
    fireEvent.click(withdrawalsTabBtn);

    await waitFor(() => {
      expect(screen.getByText('0.5 ETH')).toBeDefined();
    });

    // READY_FOR_MANUAL_EXECUTION card must show "Confirm On-Chain Tx"
    const confirmTxBtn = screen.getByRole('button', { name: /Confirm On-Chain Tx/i });
    expect(confirmTxBtn).toBeDefined();
  });

  test('B. Non-ready withdrawal does not show Confirm Tx button', async () => {
    (apiClient.get as any).mockImplementation((url: string) => {
      if (url === '/admin/withdrawals/pending') {
        return Promise.resolve({
          data: [
            {
              id: 'w-pending-only',
              userId: 'u-2',
              asset: 'USDT',
              network: 'ETHEREUM',
              amount: '1000',
              destinationAddress: '0x2222222222222222222222222222222222222222',
              cryptoStatus: 'PENDING_REVIEW',
            },
          ],
        });
      }
      return Promise.resolve({});
    });

    render(<Admin onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Withdrawal Approvals & Manual Tx/i }));

    await waitFor(() => {
      expect(screen.getByText('1000 USDT')).toBeDefined();
    });

    // PENDING_REVIEW should have Approve and Reject, but NOT Confirm On-Chain Tx
    expect(screen.getByRole('button', { name: /Approve/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /Reject/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /Confirm On-Chain Tx/i })).toBeNull();
  });

  test('C. Valid txHash calls exact backend endpoint POST /api/v1/admin/withdrawals/:id/confirm-tx', async () => {
    render(<Admin onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Withdrawal Approvals & Manual Tx/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Confirm On-Chain Tx/i })).toBeDefined();
    });

    // Open modal
    fireEvent.click(screen.getByRole('button', { name: /Confirm On-Chain Tx/i }));

    // Input valid 66-character txHash
    const validHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const txInput = screen.getByPlaceholderText('0x (64 hex characters)');
    fireEvent.change(txInput, { target: { value: validHash } });

    // Check operator acknowledgment checkbox
    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);

    // Click submit in modal
    const submitBtn = screen.getAllByRole('button', { name: /Confirm On-Chain Tx/i })[1];
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith('/admin/withdrawals/w-ready-1/confirm-tx', {
        txHash: validHash,
      });
    });
  });

  test('D. Invalid txHash is rejected before request is sent', async () => {
    render(<Admin onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Withdrawal Approvals & Manual Tx/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Confirm On-Chain Tx/i })).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: /Confirm On-Chain Tx/i }));

    // Enter malformed txHash (too short / no 0x)
    const txInput = screen.getByPlaceholderText('0x (64 hex characters)');
    fireEvent.change(txInput, { target: { value: '0xinvalid' } });

    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);

    const submitBtn = screen.getAllByRole('button', { name: /Confirm On-Chain Tx/i })[1];
    expect((submitBtn as HTMLButtonElement).disabled).toBe(true);

    // apiClient.post should NOT be called
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  test('E. Successful confirmation refreshes withdrawal state', async () => {
    render(<Admin onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Withdrawal Approvals & Manual Tx/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Confirm On-Chain Tx/i })).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: /Confirm On-Chain Tx/i }));

    const validHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    fireEvent.change(screen.getByPlaceholderText('0x (64 hex characters)'), { target: { value: validHash } });
    fireEvent.click(screen.getByRole('checkbox'));

    const submitBtn = screen.getAllByRole('button', { name: /Confirm On-Chain Tx/i })[1];
    fireEvent.click(submitBtn);

    await waitFor(() => {
      // get should have been called twice (initial load + refresh after confirmation)
      expect((apiClient.get as any).mock.calls.filter((c: any) => c[0] === '/admin/withdrawals/pending').length).toBe(2);
      expect(screen.getByText(/confirmed on-chain/i)).toBeDefined();
    });
  });

  test('F. Backend 4xx error displayed safely without stack traces', async () => {
    (apiClient.post as any).mockRejectedValueOnce({
      statusCode: 400,
      message: 'Withdrawal is not awaiting manual execution (crypto_status=COMPLETED)',
    });

    render(<Admin onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Withdrawal Approvals & Manual Tx/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Confirm On-Chain Tx/i })).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: /Confirm On-Chain Tx/i }));

    const validHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    fireEvent.change(screen.getByPlaceholderText('0x (64 hex characters)'), { target: { value: validHash } });
    fireEvent.click(screen.getByRole('checkbox'));

    const submitBtn = screen.getAllByRole('button', { name: /Confirm On-Chain Tx/i })[1];
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText(/Withdrawal is not awaiting manual execution/i)).toBeDefined();
    });
  });

  test('G. Duplicate clicks prevented while request is in-flight', async () => {
    let resolvePost: any;
    (apiClient.post as any).mockImplementationOnce(() => new Promise((resolve) => { resolvePost = resolve; }));

    render(<Admin onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Withdrawal Approvals & Manual Tx/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Confirm On-Chain Tx/i })).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: /Confirm On-Chain Tx/i }));

    const validHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    fireEvent.change(screen.getByPlaceholderText('0x (64 hex characters)'), { target: { value: validHash } });
    fireEvent.click(screen.getByRole('checkbox'));

    const submitBtn = screen.getAllByRole('button', { name: /Confirm On-Chain Tx/i })[1];
    fireEvent.click(submitBtn);

    // In-flight state: button text should change and be disabled
    expect(screen.getByText('Confirming...')).toBeDefined();
    expect((submitBtn as HTMLButtonElement).disabled).toBe(true);

    // Second click should not call post again
    fireEvent.click(submitBtn);
    expect((apiClient.post as any).mock.calls.length).toBe(1);

    // Clean up promise
    resolvePost({ success: true });
  });

  test('H. Treasury tab loads and displays operational architecture', async () => {
    render(<Admin onNavigate={vi.fn()} />);
    const treasuryTabBtn = screen.getByRole('button', { name: /Treasury & Safe Consolidation/i });
    fireEvent.click(treasuryTabBtn);

    expect(screen.getByText('Treasury Safe Consolidation Pipeline')).toBeDefined();
    expect(screen.getByText('1. Initiate Consolidation to Safe')).toBeDefined();
    expect(screen.getByText('2. Confirm On-Chain Treasury Transfer')).toBeDefined();
  });

  test('I. Treasury consolidate calls exact API POST /api/v1/admin/treasury/consolidate', async () => {
    render(<Admin onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Treasury & Safe Consolidation/i }));

    // Fill form
    const amountInput = screen.getByPlaceholderText('e.g. 0.5');
    fireEvent.change(amountInput, { target: { value: '0.2' } });

    const sigInput = screen.getByPlaceholderText('0x (Safe Owner EIP-712 Signature)');
    const fakeSig = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1b';
    fireEvent.change(sigInput, { target: { value: fakeSig } });

    const consolidateBtn = screen.getByRole('button', { name: /Request Consolidation/i });
    fireEvent.click(consolidateBtn);

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith('/admin/treasury/consolidate', expect.objectContaining({
        network: 'ETHEREUM',
        asset: 'ETH',
        amount: '0.2',
        signature: fakeSig,
        nonce: 0,
        expiry: expect.any(Number),
        intentId: expect.any(String),
      }));
    });
  });

  test('J. Treasury confirmation calls exact API POST /api/v1/admin/treasury/confirm', async () => {
    (apiClient.post as any).mockResolvedValueOnce({
      message: 'Treasury consolidation requested',
      request: {
        id: 'intent-custom-123',
        intentId: 'intent-custom-123',
        safeAddress: '0x0c90608af5A365139FCa9FA31E326b6394E8FA9B',
        network: 'ETHEREUM',
        asset: 'ETH',
        amount: '0.5',
        status: 'READY_FOR_MANUAL_EXECUTION',
      },
    });

    render(<Admin onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Treasury & Safe Consolidation/i }));

    // Consolidate first
    fireEvent.change(screen.getByPlaceholderText('e.g. 0.5'), { target: { value: '0.5' } });
    fireEvent.change(screen.getByPlaceholderText('0x (Safe Owner EIP-712 Signature)'), { target: { value: '0x1234' } });
    fireEvent.click(screen.getByRole('button', { name: /Request Consolidation/i }));

    await waitFor(() => {
      expect(screen.getByText('intent-custom-123')).toBeDefined();
    });

    // Now confirm on-chain
    const txHashInput = screen.getByPlaceholderText('0x (Broadcast Tx Hash)');
    const validHash = '0x9999999999999999999999999999999999999999999999999999999999999999';
    fireEvent.change(txHashInput, { target: { value: validHash } });

    const checkbox = screen.getByLabelText(/I verify that the manual transfer to the designated Safe/i);
    fireEvent.click(checkbox);

    const confirmBtn = screen.getByRole('button', { name: /Confirm Treasury Transfer/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith('/admin/treasury/confirm', {
        intentId: 'intent-custom-123',
        txHash: validHash,
      });
    });
  });

  test('K. Treasury confirmation refreshes state with success message', async () => {
    (apiClient.post as any).mockImplementation((url: string) => {
      if (url === '/admin/treasury/consolidate') {
        return Promise.resolve({
          message: 'Treasury consolidation requested',
          request: {
            id: 'intent-xyz',
            intentId: 'intent-xyz',
            status: 'READY_FOR_MANUAL_EXECUTION',
            safeAddress: '0xSafeAddress',
          },
        });
      }
      if (url === '/admin/treasury/confirm') {
        return Promise.resolve({
          success: true,
          message: 'Treasury transfer confirmed on-chain and verified.',
        });
      }
      return Promise.resolve({});
    });

    render(<Admin onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Treasury & Safe Consolidation/i }));

    // Consolidate
    fireEvent.change(screen.getByPlaceholderText('e.g. 0.5'), { target: { value: '0.1' } });
    fireEvent.change(screen.getByPlaceholderText('0x (Safe Owner EIP-712 Signature)'), { target: { value: '0x1234' } });
    fireEvent.click(screen.getByRole('button', { name: /Request Consolidation/i }));

    await waitFor(() => {
      expect(screen.getByText('intent-xyz')).toBeDefined();
    });

    // Confirm
    const txHashInput = screen.getByPlaceholderText('0x (Broadcast Tx Hash)');
    fireEvent.change(txHashInput, {
      target: { value: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    fireEvent.click(screen.getByLabelText(/I verify that the manual transfer to the designated Safe/i));
    fireEvent.click(screen.getByRole('button', { name: /Confirm Treasury Transfer/i }));

    await waitFor(() => {
      expect(screen.getByText(/Treasury transfer confirmed on-chain and verified/i)).toBeDefined();
      expect(screen.getByText('CONFIRMED')).toBeDefined();
    });
  });

  test('L. Unauthorized / 403 response handled safely', async () => {
    (apiClient.post as any).mockRejectedValueOnce({
      statusCode: 403,
      message: 'Admin 2FA verification required',
    });

    render(<Admin onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Treasury & Safe Consolidation/i }));

    fireEvent.change(screen.getByPlaceholderText('e.g. 0.5'), { target: { value: '0.1' } });
    fireEvent.change(screen.getByPlaceholderText('0x (Safe Owner EIP-712 Signature)'), { target: { value: '0x1234' } });
    fireEvent.click(screen.getByRole('button', { name: /Request Consolidation/i }));

    await waitFor(() => {
      expect(screen.getByText(/Admin 2FA verification required/i)).toBeDefined();
    });
  });

  test('M. Zero private keys or secrets stored in browser storage', async () => {
    render(<Admin onNavigate={vi.fn()} />);

    // Check localStorage and sessionStorage
    expect(localStorage.getItem('private_key')).toBeNull();
    expect(localStorage.getItem('seed_phrase')).toBeNull();
    expect(sessionStorage.getItem('private_key')).toBeNull();
    expect(sessionStorage.getItem('secret')).toBeNull();
  });
});
