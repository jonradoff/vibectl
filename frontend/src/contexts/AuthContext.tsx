import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { getAuthStatus, adminLogin, setStoredToken, clearStoredToken } from '../api/client';

interface AuthContextValue {
  passwordSet: boolean | null; // null = still loading
  authenticated: boolean;
  loading: boolean;
  login: (password: string) => Promise<void>;
  logout: () => void;
  recheck: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [passwordSet, setPasswordSet] = useState<boolean | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);

  const recheck = useCallback(async () => {
    setLoading(true);
    try {
      const status = await getAuthStatus();
      setPasswordSet(status.passwordSet);
      setAuthenticated(!status.passwordSet || status.tokenValid);
    } catch {
      setPasswordSet(true);
      setAuthenticated(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { recheck(); }, [recheck]);

  useEffect(() => {
    const handle = () => {
      setAuthenticated(false);
    };
    window.addEventListener('vibectl:unauthorized', handle);
    return () => window.removeEventListener('vibectl:unauthorized', handle);
  }, []);

  const login = useCallback(async (password: string) => {
    const { token } = await adminLogin(password);
    setStoredToken(token);
    setAuthenticated(true);
  }, []);

  const logout = useCallback(() => {
    clearStoredToken();
    setAuthenticated(false);
  }, []);

  return (
    <AuthContext.Provider value={{ passwordSet, authenticated, loading, login, logout, recheck }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
