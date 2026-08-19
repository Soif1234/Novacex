import { User } from './types';

export class UserService {
  private persistKey = 'novacex_demo_user';
  private currentUser: User | null = null;
  private subscribers: Set<(user: User | null) => void> = new Set();

  constructor(private persist: boolean = true) {
    if (this.persist) {
      this.load();
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
          const safeEmail = email.toLowerCase().trim();
          const role = (parsed.role === 'ADMIN' || safeEmail === 'admin@mallickexchange.com') ? 'ADMIN' : 'USER';
          this.currentUser = {
            id: parsed.id || 'demo-user-1',
            username: parsed.username || parsed.name || 'DemoTrader',
            displayName: parsed.displayName || parsed.name || 'Demo Trader',
            email: email,
            avatar: parsed.avatar || '',
            role: role,
            accountStatus: parsed.accountStatus || 'ACTIVE',
            createdAt: parsed.createdAt || Date.now(),
            lastActiveAt: Date.now()
          };
        } else if (oldData) {
          const parsed = JSON.parse(oldData);
          const email = parsed.email || 'demo@mallickexchange.com';
          const safeEmail = email.toLowerCase().trim();
          const role = (parsed.role === 'ADMIN' || safeEmail === 'admin@mallickexchange.com') ? 'ADMIN' : 'USER';
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

  public logout() {
    this.currentUser = null;
    this.save();
    this.notify();
  }

  public reset() {
    this.currentUser = null;
    this.save();
    this.notify();
  }
  
  public login(email: string) {
     const safeEmail = email.toLowerCase().trim();
     const namePrefix = safeEmail.split('@')[0];
     const isAdmin = safeEmail === 'admin@mallickexchange.com';
     
     // Generate a stable ID based on email so that if they logout and login with the same email, they get the same ID
     const b64 = typeof btoa !== 'undefined' ? btoa(safeEmail) : Buffer.from(safeEmail).toString('base64');
     const stableId = 'demo-' + b64.replace(/=/g, '');

     this.currentUser = {
      id: stableId,
      username: namePrefix,
      displayName: namePrefix,
      email: safeEmail,
      avatar: '',
      role: isAdmin ? 'ADMIN' : 'USER',
      accountStatus: 'ACTIVE',
      createdAt: Date.now(),
      lastActiveAt: Date.now()
    };
    this.save();
    this.notify();
  }
}

export const userService = new UserService(typeof window !== 'undefined');
