import React, { createContext, useContext, useState, useEffect } from 'react';

export interface User {
  id: string;
  email: string;
  name: string;
  isDemo: boolean;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  login: (email: string) => void;
  signup: (email: string, name: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    try {
      const saved = sessionStorage.getItem('demo_user');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  const login = (email: string) => {
    const mockUser: User = {
      id: Math.random().toString(36).substring(2, 11),
      email,
      name: email.split('@')[0],
      isDemo: true,
    };
    setUser(mockUser);
    sessionStorage.setItem('demo_user', JSON.stringify(mockUser));
  };

  const signup = (email: string, name: string) => {
    const mockUser: User = {
      id: Math.random().toString(36).substring(2, 11),
      email,
      name,
      isDemo: true,
    };
    setUser(mockUser);
    sessionStorage.setItem('demo_user', JSON.stringify(mockUser));
  };

  const logout = () => {
    setUser(null);
    sessionStorage.removeItem('demo_user');
  };

  return (
    <AuthContext.Provider value={{ user, isAuthenticated: !!user, login, signup, logout }}>
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
