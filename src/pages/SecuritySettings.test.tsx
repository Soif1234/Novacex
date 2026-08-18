import "@testing-library/jest-dom";
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SecuritySettings } from './SecuritySettings';
import { securityService } from '../services/user/SecurityService';

vi.mock('../services/user/SecurityService', () => {
  let callbacks: any[] = [];
  return {
    securityService: {
      getStatus: vi.fn(() => ({
        twoFactorEnabled: false,
        sessionCount: 1,
        lastLoginAt: Date.now(),
        securityLevel: 'BASIC'
      })),
      getSessions: vi.fn(() => [
        {
          id: 'sess-1',
          deviceName: 'Desktop Browser',
          platform: 'Windows',
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          current: true,
          status: 'ACTIVE'
        },
        {
          id: 'sess-2',
          deviceName: 'Mobile Browser',
          platform: 'Android',
          createdAt: Date.now() - 1000,
          lastActiveAt: Date.now() - 1000,
          current: false,
          status: 'ACTIVE'
        }
      ]),
      subscribe: vi.fn((cb) => {
        callbacks.push(cb);
        return () => { callbacks = callbacks.filter(c => c !== cb); };
      }),
      toggleTwoFactor: vi.fn(() => {
        callbacks.forEach(cb => cb());
      }),
      revokeSession: vi.fn(() => {
        callbacks.forEach(cb => cb());
      }),
      revokeOtherSessions: vi.fn(() => {
        callbacks.forEach(cb => cb());
      })
    }
  };
});

describe('SecuritySettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without white screen or crashing', () => {
    render(<SecuritySettings onBack={() => {}} />);
    expect(screen.getByText('Security Settings')).toBeInTheDocument();
  });

  it('displays basic security status and disabled 2FA', () => {
    render(<SecuritySettings onBack={() => {}} />);
    expect(screen.getByText('Level: BASIC')).toBeInTheDocument();
    expect(screen.getByText('Enable')).toBeInTheDocument(); // Toggle button
  });

  it('shows demo warning', () => {
    render(<SecuritySettings onBack={() => {}} />);
    expect(screen.getByText(/Demo security settings/i)).toBeInTheDocument();
  });

  it('allows toggling 2FA', () => {
    render(<SecuritySettings onBack={() => {}} />);
    const toggleBtn = screen.getByText('Enable');
    fireEvent.click(toggleBtn);
    expect(securityService.toggleTwoFactor).toHaveBeenCalled();
  });

  it('displays multiple sessions and current session', () => {
    render(<SecuritySettings onBack={() => {}} />);
    expect(screen.getByText('Desktop Browser')).toBeInTheDocument();
    expect(screen.getByText('Current session')).toBeInTheDocument();
    expect(screen.getByText('Mobile Browser')).toBeInTheDocument();
  });

  it('allows revoking specific session', () => {
    render(<SecuritySettings onBack={() => {}} />);
    const revokeBtns = screen.getAllByText('Revoke');
    expect(revokeBtns.length).toBeGreaterThan(0);
    fireEvent.click(revokeBtns[0]);
    expect(securityService.revokeSession).toHaveBeenCalledWith('sess-2');
  });

  it('allows logging out other sessions', () => {
    render(<SecuritySettings onBack={() => {}} />);
    const logOutOtherBtn = screen.getByText('Log Out Other Sessions');
    fireEvent.click(logOutOtherBtn);
    expect(securityService.revokeOtherSessions).toHaveBeenCalled();
  });

  it('indicates password change is unavailable for demo', () => {
    render(<SecuritySettings onBack={() => {}} />);
    expect(screen.getByText(/Demo account — password management is unavailable/i)).toBeInTheDocument();
  });
});
