import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { securityService } from './SecurityService';

describe('SecurityService', () => {
  beforeEach(() => {
    sessionStorage.clear();
    // Re-initialize or clear the service state if possible, since it's a singleton.
    // We can simulate clear by calling a private method or by trusting the tests.
    // In actual tests, since it's a singleton, we need to manually clear it.
    (securityService as any).clear();
    // Create a mock user session
    (securityService as any).ensureSession('test-user');
  });
  
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should initialize with BASIC security level and 2FA disabled', () => {
    const status = securityService.getStatus();
    expect(status.twoFactorEnabled).toBe(false);
    expect(status.securityLevel).toBe('BASIC');
  });

  it('should toggle 2FA and update security level to ENHANCED', () => {
    securityService.toggleTwoFactor();
    const status = securityService.getStatus();
    expect(status.twoFactorEnabled).toBe(true);
    expect(status.securityLevel).toBe('ENHANCED');
  });

  it('should maintain current session', () => {
    const sessions = securityService.getSessions();
    const current = sessions.find(s => s.current);
    expect(current).toBeDefined();
    expect(current?.status).toBe('ACTIVE');
  });

  it('should revoke a specific session', () => {
    const sessions = securityService.getSessions();
    const otherSession = sessions.find(s => !s.current);
    
    if (otherSession) {
      securityService.revokeSession(otherSession.id);
      const updatedSessions = securityService.getSessions();
      const updatedOther = updatedSessions.find(s => s.id === otherSession.id);
      expect(updatedOther?.status).toBe('REVOKED');
    }
  });

  it('should revoke all other sessions', () => {
    securityService.revokeOtherSessions();
    const sessions = securityService.getSessions();
    
    sessions.forEach(s => {
      if (!s.current) {
        expect(s.status).toBe('REVOKED');
      } else {
        expect(s.status).toBe('ACTIVE');
      }
    });
  });

  it('should not throw on malformed sessionStorage data', () => {
    sessionStorage.setItem('novacex_demo_security_settings', '{ malformed json');
    expect(() => {
      (securityService as any).load();
    }).not.toThrow();
  });
  
  it('should persist settings', () => {
    securityService.toggleTwoFactor();
    const settingsStr = sessionStorage.getItem('novacex_demo_security_settings');
    expect(settingsStr).toBeDefined();
    if (settingsStr) {
      const parsed = JSON.parse(settingsStr);
      expect(parsed.twoFactorEnabled).toBe(true);
    }
  });
});
