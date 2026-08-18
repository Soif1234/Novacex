import { SecurityStatus, LoginSession } from './types';
import { userService } from './UserService';

class SecurityService {
  private persistKeySettings = 'novacex_demo_security_settings';
  private persistKeySessions = 'novacex_demo_security_sessions';
  
  private status: SecurityStatus = {
    twoFactorEnabled: false,
    sessionCount: 1,
    lastLoginAt: Date.now(),
    securityLevel: 'BASIC'
  };
  
  private sessions: LoginSession[] = [];
  private subscribers: Set<() => void> = new Set();
  
  constructor() {
    this.load();
    // Listen to user logout to clear sessions
    userService.subscribe((user) => {
      if (!user) {
        this.clear();
      } else {
        this.ensureSession(user.id);
      }
    });
    
    const user = userService.getCurrentUser();
    if (user) {
      this.ensureSession(user.id);
    }
  }

  private load() {
    try {
      if (typeof window !== 'undefined') {
        const settingsData = sessionStorage.getItem(this.persistKeySettings);
        if (settingsData) {
          const parsed = JSON.parse(settingsData);
          this.status = { ...this.status, ...parsed };
        }
        
        const sessionsData = sessionStorage.getItem(this.persistKeySessions);
        if (sessionsData) {
          const parsedSessions = JSON.parse(sessionsData);
          if (Array.isArray(parsedSessions)) this.sessions = parsedSessions.filter(item => item && typeof item === "object");
        }
      }
    } catch (e) {
      console.warn("Failed to load security settings", e);
    }
  }

  private save() {
    try {
      if (typeof window !== 'undefined') {
        sessionStorage.setItem(this.persistKeySettings, JSON.stringify(this.status));
        sessionStorage.setItem(this.persistKeySessions, JSON.stringify(this.sessions));
      }
    } catch (e) {
      console.warn("Failed to save security settings", e);
    }
  }

  private ensureSession(userId: string) {
    let current = this.sessions.find(s => s.current && s.status === 'ACTIVE');
    
    if (!current) {
      const isMobile = typeof navigator !== 'undefined' ? /Mobile|Android|iP(ad|hone)/.test(navigator.userAgent) : false;
      const platform = typeof navigator !== 'undefined' ? (navigator.platform || 'Unknown') : 'Unknown';
      
      current = {
        id: `sess-${Date.now()}-${Math.random().toString(36).substring(2,9)}`,
        deviceName: isMobile ? 'Mobile Browser' : 'Desktop Browser',
        platform: platform,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        current: true,
        status: 'ACTIVE'
      };
      
      if (this.sessions.length === 0) {
        this.sessions.push({
           id: `sess-old-${Date.now()}`,
           deviceName: 'Old Phone Browser',
           platform: 'Android',
           createdAt: Date.now() - 86400000 * 2,
           lastActiveAt: Date.now() - 86400000,
           current: false,
           status: 'ACTIVE'
        });
      }
      
      this.sessions.push(current);
    } else {
      current.lastActiveAt = Date.now();
    }
    
    this.updateStatus();
    this.save();
    this.notify();
  }

  private updateStatus() {
    const activeSessions = this.sessions.filter(s => s.status === 'ACTIVE');
    this.status.sessionCount = activeSessions.length;
    this.status.securityLevel = this.status.twoFactorEnabled ? 'ENHANCED' : 'BASIC';
  }

  private clear() {
    this.status = {
      twoFactorEnabled: false,
      sessionCount: 0,
      lastLoginAt: null,
      securityLevel: 'BASIC'
    };
    this.sessions = [];
    try {
      if (typeof window !== 'undefined') {
        sessionStorage.removeItem(this.persistKeySettings);
        sessionStorage.removeItem(this.persistKeySessions);
      }
    } catch (e) {}
    this.notify();
  }

  public subscribe(cb: () => void) {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  private notify() {
    this.subscribers.forEach(cb => cb());
  }

  public getStatus(): SecurityStatus {
    return { ...this.status };
  }

  public getSessions(): LoginSession[] {
    return [...this.sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  public toggleTwoFactor() {
    this.status.twoFactorEnabled = !this.status.twoFactorEnabled;
    this.updateStatus();
    this.save();
    this.notify();
  }

  public revokeSession(sessionId: string) {
    const session = this.sessions.find(s => s.id === sessionId);
    if (session && !session.current) {
      session.status = 'REVOKED';
      this.updateStatus();
      this.save();
      this.notify();
    }
  }

  public revokeOtherSessions() {
    this.sessions.forEach(s => {
      if (!s.current) {
        s.status = 'REVOKED';
      }
    });
    this.updateStatus();
    this.save();
    this.notify();
  }
}

export const securityService = new SecurityService();
