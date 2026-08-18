import React, { createContext, useContext, useState, useEffect } from 'react';
import { userService } from '../services/user/UserService';
import { User } from '../services/user/types';

export type AuthStatus = 'INITIALIZING' | 'AUTHENTICATED' | 'UNAUTHENTICATED';

interface AuthContextType {
  user: User | null;
  status: AuthStatus;
  isAuthenticated: boolean;
  login: (email: string) => void;
  signup: (email: string, name: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthStatus>('INITIALIZING');

  useEffect(() => {
    let mounted = true;
    
    // Simulate async restoration for loading state demonstration
    const restoreSession = async () => {
      try {
        // Wait a tiny bit to show the initializing state as requested
        await new Promise(resolve => setTimeout(resolve, 500));
        
        if (!mounted) return;

        const currentUser = userService.getCurrentUser();
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
          setUser(null);
          setStatus('UNAUTHENTICATED');
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

  const login = (email: string) => {
    userService.login(email);
  };

  const signup = (email: string, name: string) => {
    userService.login(email);
    userService.updateProfile({ displayName: name, username: name });
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
      logout 
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
