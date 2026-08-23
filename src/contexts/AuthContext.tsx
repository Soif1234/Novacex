import React, { createContext, useContext, useState, useEffect } from 'react';
import { userService } from '../services/user/UserService';
import { User } from '../services/user/types';

export type AuthStatus = 'INITIALIZING' | 'AUTHENTICATED' | 'UNAUTHENTICATED' | 'AWAITING_2FA';

interface AuthContextType {
  user: User | null;
  status: AuthStatus;
  isAuthenticated: boolean;
  login: (email: string, password?: string) => Promise<boolean>;
  verify2FA: (totp: string) => Promise<boolean>;
  tempToken: string | null;
  cancel2FA: () => void;
  signup: (email: string, name: string, password?: string) => Promise<void> | void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthStatus>('INITIALIZING');
  const [tempToken, setTempToken] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    
    const restoreSession = async () => {
      try {
        // Attempt backend session recovery (/api/v1/auth/me)
        const currentUser = await userService.bootstrapFromBackend();
        
        if (!mounted) return;

        if (currentUser) {
          setUser(currentUser);
          setStatus('AUTHENTICATED');
        } else {
          setUser(null);
          setStatus('UNAUTHENTICATED');
        }
      } catch (error) {
        console.warn('Failed to restore session:', error);
        if (mounted) {
          const fallbackUser = userService.getCurrentUser();
          if (fallbackUser) {
            setUser(fallbackUser);
            setStatus('AUTHENTICATED');
          } else {
            setUser(null);
            setStatus('UNAUTHENTICATED');
          }
        }
      }
    };
    
    restoreSession();

    const unsubscribe = userService.subscribe((newUser) => {
      if (!mounted) return;
      if (newUser) {
        setUser(newUser);
        setStatus('AUTHENTICATED');
      } else {
        setUser(null);
        setStatus('UNAUTHENTICATED');
      }
    });
    
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const login = async (email: string, password = 'DemoPassword123!') => {
    try {
      const res = await userService.loginWithBackend(email, password);
      if (res && 'requires2FA' in res && res.requires2FA) {
        setTempToken(res.tempToken);
        setStatus('AWAITING_2FA');
        return false;
      }
      return true;
    } catch (e) {
      console.error('Login failed', e);
      throw e;
    }
  };

  const signup = async (email: string, name: string, password = 'DemoPassword123!') => {
    try {
      const res = await userService.signupWithBackend(email, name, password);
      if (res && 'requires2FA' in res && res.requires2FA) {
        setTempToken(res.tempToken);
        setStatus('AWAITING_2FA');
        return false;
      }
      return true;
    } catch (e) {
      console.error('Signup failed', e);
      throw e;
    }
  };


  const verify2FA = async (totp: string) => {
    if (!tempToken) throw new Error("No temp token");
    try {
      await userService.verify2FA(tempToken, totp);
      setTempToken(null);
      setStatus('AUTHENTICATED');
      return true;
    } catch (e) {
      console.error('2FA verification failed', e);
      throw e;
    }
  };

  const cancel2FA = () => {
    setTempToken(null);
    setStatus('UNAUTHENTICATED');
  };

  const logout = () => {
    userService.logout();
  };

  if (status === 'INITIALIZING') {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center">
        <div className="text-blue-500 font-bold text-2xl mb-4 tracking-wider">Mallick Exchange</div>
        <div className="text-gray-400 text-sm animate-pulse">Loading...</div>
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ 
      user, 
      status, 
      isAuthenticated: status === 'AUTHENTICATED', 
      login, 
      signup, 
      logout, 
      verify2FA, 
      tempToken, 
      cancel2FA 
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
