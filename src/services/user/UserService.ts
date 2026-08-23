import { User, UserAccountInfo } from './types';
import { apiClient } from '../api/client';
import { wsClient } from '../websocket/wsClient';
import { AuthSessionResponse } from '../api/types';

export class UserService {
  private persistKey = 'novacex_demo_user';
  private currentUser: User | null = null;
  private subscribers: Set<(user: User | null) => void> = new Set();

  constructor(private persist: boolean = true) {
    if (this.persist) {
      this.load();
    }

    // Auto-logout if backend responds with 401
    apiClient.onUnauthorized(() => {
      this.logout();
    });

    // Cross-tab synchronization
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key === this.persistKey) {
          this.load();
          this.notify();
        }
      });
    }
  }

  private load() {
    try {
      if (typeof window !== 'undefined') {
        const data = sessionStorage.getItem(this.persistKey);
        
        // Also check if old 'demo_user' exists from prior states
        const oldData = sessionStorage.getItem('demo_user');
        
        if (data) {
          const parsed = JSON.parse(data);
          const email = parsed.email || 'demo@mallickexchange.com';
          const role = parsed.role === 'ADMIN' ? 'ADMIN' : 'USER';
          this.currentUser = {
            id: parsed.id || 'demo-user-1',
            username: parsed.username || parsed.name || 'DemoTrader',
            displayName: parsed.displayName || parsed.name || 'Demo Trader',
            email: email,
            avatar: parsed.avatar || '',
            role: role,
            accountStatus: parsed.accountStatus || 'ACTIVE',
            createdAt: parsed.createdAt || Date.now(),
            lastActiveAt: Date.now(),
            accounts: parsed.accounts,
            spotAccountId: parsed.spotAccountId,
            futuresAccountId: parsed.futuresAccountId,
            fundingAccountId: parsed.fundingAccountId,
          };
        } else if (oldData) {
          const parsed = JSON.parse(oldData);
          const email = parsed.email || 'demo@mallickexchange.com';
          const role = parsed.role === 'ADMIN' ? 'ADMIN' : 'USER';
          this.currentUser = {
            id: parsed.id || 'demo-user-1',
            username: parsed.name || 'DemoTrader',
            displayName: parsed.name || 'Demo Trader',
            email: email,
            avatar: '',
            role: role,
            accountStatus: 'ACTIVE',
            createdAt: Date.now(),
            lastActiveAt: Date.now()
          };
        }
      }
    } catch (e) {
      console.warn("Failed to load user profile", e);
      this.currentUser = null;
    }
  }

  private save() {
    if (!this.persist) return;
    try {
      if (this.currentUser) {
        sessionStorage.setItem(this.persistKey, JSON.stringify(this.currentUser));
      } else {
        sessionStorage.removeItem(this.persistKey);
      }
    } catch (e) {
      console.warn("Failed to save user profile", e);
    }
  }

  public subscribe(callback: (user: User | null) => void) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private notify() {
    this.subscribers.forEach(cb => cb(this.currentUser));
  }

  public getCurrentUser(): User | null {
    return this.currentUser;
  }
  
  public isAdmin(): boolean {
    return this.currentUser?.role === 'ADMIN';
  }

  public getAccountStatus(): string {
    return this.currentUser?.accountStatus || 'UNAUTHENTICATED';
  }

  public getAccounts(): UserAccountInfo[] {
    return this.currentUser?.accounts || [];
  }

  public getSpotAccountId(): string {
    return this.currentUser?.spotAccountId || this.currentUser?.accounts?.find(a => a.type === 'SPOT')?.id || this.currentUser?.id || 'demo-user-1';
  }

  public getFuturesAccountId(): string {
    return this.currentUser?.futuresAccountId || this.currentUser?.accounts?.find(a => a.type === 'FUTURES')?.id || this.currentUser?.id || 'demo-user-1';
  }

  public getFundingAccountId(): string {
    return this.currentUser?.fundingAccountId || this.currentUser?.accounts?.find(a => a.type === 'FUNDING')?.id || this.currentUser?.id || 'demo-user-1';
  }

  public updateProfile(updates: Partial<Pick<User, 'displayName' | 'username' | 'avatar'>>): void {
    if (!this.currentUser) {
      throw new Error("Cannot update profile when unauthenticated");
    }
    
    if (updates.displayName !== undefined) {
       if (updates.displayName.trim().length === 0) {
           throw new Error("Display name cannot be empty");
       }
       this.currentUser.displayName = updates.displayName.trim();
    }
    
    if (updates.username !== undefined) {
        if (updates.username.trim().length < 3) {
            throw new Error("Username must be at least 3 characters");
        }
        this.currentUser.username = updates.username.trim();
    }
    
    if (updates.avatar !== undefined) {
        this.currentUser.avatar = updates.avatar;
    }
    
    this.currentUser.lastActiveAt = Date.now();
    this.save();
    this.notify();
  }

  public logout(): void {
    this.currentUser = null;
    apiClient.setSessionToken(null);
    wsClient.setAuthToken(null);
    this.save();
    this.notify();

    // Async backend logout call (fire and forget / catch error)
    if (typeof window !== 'undefined') {
      apiClient.post('/auth/logout').catch(() => {});
    }
  }

  public reset(): void {
    this.logout();
  }
  
  /**
   * Local account-context setter used by tests/offline flows ONLY. This is NOT an
   * authentication path and grants no privileges — the backend is authoritative for
   * real auth (see loginWithBackend / demoLogin). Always assigns USER role.
   */
  public login(email: string): void {
    const safeEmail = email.toLowerCase().trim();
    const namePrefix = safeEmail.split('@')[0];

    const b64 = typeof btoa !== 'undefined' ? btoa(safeEmail) : Buffer.from(safeEmail).toString('base64');
    const stableId = 'demo-' + b64.replace(/=/g, '');

    this.currentUser = {
      id: stableId,
      username: namePrefix,
      displayName: namePrefix,
      email: safeEmail,
      avatar: '',
      role: 'USER',
      accountStatus: 'ACTIVE',
      createdAt: Date.now(),
      lastActiveAt: Date.now()
    };
    this.save();
    this.notify();
  }

  /**
   * Authoritative backend authentication
   */
  public async loginWithBackend(email: string, password: string): Promise<User | { requires2FA: true, tempToken: string }> {
    const safeEmail = email.toLowerCase().trim();
    const namePrefix = safeEmail.split('@')[0];

    if (!password) {
      throw new Error('Password is required');
    }

    // Authoritative backend login. Invalid credentials MUST fail (no auto-signup,
    // no local fallback) so the error surfaces to the user.
    const res = await apiClient.post<AuthSessionResponse>('/auth/login', {
      email: safeEmail,
      password,
    });

    if (res.requires2FA && res.tempToken) {
      return { requires2FA: true, tempToken: res.tempToken };
    }

    return this.handleAuthSuccess(res, safeEmail, namePrefix);
  }

  /**
   * Provision a fresh demo account on the backend (server-generated random
   * credentials) and establish a real authenticated session. Safe replacement for
   * the previous shared hardcoded-password demo login.
   */
  public async demoLogin(): Promise<User> {
    const res = await apiClient.post<AuthSessionResponse>('/auth/demo-session', {});
    if (!res || !res.user) {
      throw new Error('Failed to create demo session');
    }
    return this.handleAuthSuccess(res, res.user.email, res.user.displayName || 'Demo Trader');
  }

  public async signupWithBackend(email: string, name: string, password: string): Promise<User | { requires2FA: true, tempToken: string }> {
    const safeEmail = email.toLowerCase().trim();
    const displayName = name.trim() || safeEmail.split('@')[0];

    if (!password) {
      throw new Error('Password is required');
    }

    const signupRes = await apiClient.post<AuthSessionResponse>('/auth/signup', {
      email: safeEmail,
      password,
      username: displayName,
      displayName: displayName,
    });

    const loginRes = await apiClient.post<AuthSessionResponse>('/auth/login', {
      email: safeEmail,
      password,
    });

    if (loginRes.requires2FA && loginRes.tempToken) {
      return { requires2FA: true, tempToken: loginRes.tempToken };
    }

    return this.handleAuthSuccess(loginRes || signupRes, safeEmail, displayName);
  }

  public async bootstrapFromBackend(): Promise<User | null> {
    try {
      const res = await apiClient.get<AuthSessionResponse>('/auth/me');
      if (res && res.user) {
        return this.handleAuthSuccess(res, res.user.email, res.user.displayName || res.user.username || 'Trader');
      }
    } catch {
      // Unauthenticated or backend unavailable — do NOT trust local state.
    }
    // Backend did not confirm a session: clear any cached local user so the UI
    // never shows an authenticated state without backend confirmation.
    this.currentUser = null;
    apiClient.setSessionToken(null);
    this.save();
    return null;
  }

  public async verify2FA(tempToken: string, token: string): Promise<User> {
    const res = await apiClient.post<AuthSessionResponse>('/auth/2fa/verify-login', {
      tempToken,
      token
    });
    
    // We expect the backend to return the user session here
    if (res.user) {
      return this.handleAuthSuccess(res, res.user.email, res.user.displayName || res.user.username || 'Trader');
    }
    
    throw new Error('Invalid 2FA response');
  }

  private handleAuthSuccess(res: AuthSessionResponse, email: string, defaultName: string): User {
    const user = res.user;
    if (!user) throw new Error("Missing user payload in auth response");
    const accounts = res.accounts || user.accounts || [];

    const spotAcc = accounts.find(a => a.type === 'SPOT');
    const futuresAcc = accounts.find(a => a.type === 'FUTURES');
    const fundingAcc = accounts.find(a => a.type === 'FUNDING');

    if (res.sessionToken) {
      apiClient.setSessionToken(res.sessionToken);
      wsClient.setAuthToken(res.sessionToken);
    }

    this.currentUser = {
      id: user.id,
      username: user.username || defaultName,
      displayName: user.displayName || user.username || defaultName,
      email: user.email || email,
      avatar: '',
      role: (user.role as any) || 'USER',
      accountStatus: (user.accountStatus as any) || 'ACTIVE',
      createdAt: user.createdAt ? new Date(user.createdAt).getTime() : Date.now(),
      lastActiveAt: Date.now(),
      accounts: accounts.map(a => ({ id: a.id, type: a.type })),
      spotAccountId: spotAcc?.id,
      futuresAccountId: futuresAcc?.id,
      fundingAccountId: fundingAcc?.id,
    };

    this.save();
    this.notify();
    return this.currentUser;
  }
}

export const userService = new UserService(typeof window !== 'undefined');
