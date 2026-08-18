import { describe, it, expect, beforeEach } from 'vitest';
import { UserService } from './UserService';

describe('UserService', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('1. Returns null on empty initialization', () => {
    const service = new UserService(true);
    const user = service.getCurrentUser();
    expect(user).toBeNull();
  });

  it('2. Profile update throws if unauthenticated', () => {
    const service = new UserService(true);
    expect(() => service.updateProfile({ displayName: 'New Name', username: 'newuser' })).toThrow(/unauthenticated/i);
  });

  it('3. Login creates stable ID and allows profile update', () => {
    const service = new UserService(true);
    service.login('test@example.com');
    const user = service.getCurrentUser();
    expect(user).toBeDefined();
    expect(user?.email).toBe('test@example.com');
    
    // Stable ID test
    const b64 = btoa('test@example.com').replace(/=/g, '');
    expect(user?.id).toBe('demo-' + b64);
    
    service.updateProfile({ displayName: 'New Name', username: 'newuser' });
    expect(service.getCurrentUser()?.displayName).toBe('New Name');
  });

  it('4. Invalid display name', () => {
    const service = new UserService(true);
    service.login('test@example.com');
    expect(() => service.updateProfile({ displayName: '   ' })).toThrow(/empty/);
  });

  it('5. Invalid username', () => {
    const service = new UserService(true);
    service.login('test@example.com');
    expect(() => service.updateProfile({ username: 'ab' })).toThrow(/characters/);
  });

  it('6. Persistence', () => {
    const service1 = new UserService(true);
    service1.login('test@example.com');
    service1.updateProfile({ displayName: 'Persisted Name' });
    
    // Simulate reload
    const service2 = new UserService(true);
    expect(service2.getCurrentUser()?.displayName).toBe('Persisted Name');
  });

  it('7. Logout/session behavior', () => {
    const service = new UserService(true);
    service.login('test@example.com');
    service.logout();
    
    // Logout creates unauthenticated state
    expect(service.getCurrentUser()).toBeNull();
  });

  it('8. Malformed user data', () => {
    sessionStorage.setItem('novacex_demo_user', '{ invalid json');
    const service = new UserService(true);
    
    // Should fallback to null
    expect(service.getCurrentUser()).toBeNull();
  });

  it('9. User ID persistence across legacy shapes', () => {
    sessionStorage.setItem('demo_user', JSON.stringify({ id: 'old-id', name: 'Legacy' }));
    const service = new UserService(true);
    
    const user = service.getCurrentUser();
    expect(user?.id).toBe('old-id');
    expect(user?.displayName).toBe('Legacy');
  });
});
