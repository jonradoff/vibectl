import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import {
  getAuthStatus,
  authLogin,
  authMe,
  authLogout,
  setStoredToken,
  clearStoredToken,
  getStoredToken,
} from '../api/client';
import type { User } from '../types';

interface AuthContextValue {
  currentUser: User | null;
  authenticated: boolean;
  loading: boolean;
  githubEnabled: boolean;
  githubTokenConfigured: boolean;
  anthropicEnabled: boolean;
  requirePasswordChange: boolean;
  usersExist: boolean;
  login: (credentials: { email?: string; password: string }) => Promise<void>;
  logout: () => void;
  recheck: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [githubEnabled, setGithubEnabled] = useState(false);
  const [githubTokenConfigured, setGithubTokenConfigured] = useState(false);
  const [anthropicEnabled, setAnthropicEnabled] = useState(false);
  const [requirePasswordChange, setRequirePasswordChange] = useState(false);
  const [usersExist, setUsersExist] = useState(true);

  const refreshUser = useCallback(async () => {
    try {
      const user = await authMe();
      setCurrentUser(user);
    } catch {
      // ignore — if we can't fetch the user, we stay with what we have
    }
  }, []);

  const recheck = useCallback(async () => {
    setLoading(true);
    try {
      const status = await getAuthStatus();
      setGithubEnabled(status.githubEnabled);
      setGithubTokenConfigured(status.githubTokenConfigured ?? false);
      setAnthropicEnabled(status.anthropicEnabled ?? false);
      setUsersExist(status.usersExist);

      if (!status.usersExist) {
        // No admin set up yet — deny access, show CLI setup message
        setAuthenticated(false);
        setCurrentUser(null);
        return;
      }

      if (status.tokenValid && getStoredToken()) {
        setAuthenticated(true);
        // Fetch current user info
        try {
          const user = await authMe();
          setCurrentUser(user);
          // Only force password change if they have no GitHub login — if they logged in
          // via GitHub they don't need the temp password and can set one from their profile.
          setRequirePasswordChange(user.isDefaultPassword && !user.githubId);
        } catch {
          // /auth/me failed but the earlier /auth/status said the token is
          // valid — treat this as a transient network / DB blip, keep the
          // user logged in, and let the next recheck retry. Previously we
          // forced-logout here, which under a degraded Mongo Atlas link
          // was kicking Jon to the login screen every few minutes.
        }
      } else if (!getStoredToken()) {
        // No token stored → user is genuinely unauthenticated. Safe to
        // drop into the login screen.
        setAuthenticated(false);
        setCurrentUser(null);
      } else {
        // We DO have a stored token but the server said tokenValid=false.
        // Under normal operation this means the token was revoked or
        // expired — clear it. But when Mongo is slow the backend's Verify
        // call times out and returns tokenValid=false spuriously. Do NOT
        // force logout here; drop authenticated so the AuthGate re-checks
        // shortly, without wiping the token. If the token really is bad
        // the next successful recheck (or an actual 401 from a real
        // endpoint via the vibectl:unauthorized event) will clear it.
        setAuthenticated(false);
        setCurrentUser(null);
      }
    } catch {
      // /auth/status itself errored — network/DB blip. Keep whatever auth
      // state we already have. Do NOT flip to unauthenticated; the app
      // was working a moment ago, no reason to drop the user.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { recheck(); }, [recheck]);

  useEffect(() => {
    const handle = () => {
      setAuthenticated(false);
      setCurrentUser(null);
    };
    window.addEventListener('vibectl:unauthorized', handle);
    return () => window.removeEventListener('vibectl:unauthorized', handle);
  }, []);

  const login = useCallback(async (credentials: { email?: string; password: string }) => {
    const result = await authLogin(credentials);
    setStoredToken(result.token);
    setCurrentUser(result.user);
    setAuthenticated(true);
    setRequirePasswordChange(result.requirePasswordChange || result.user.isDefaultPassword);
  }, []);

  const logout = useCallback(async () => {
    try { await authLogout(); } catch { /* ignore */ }
    clearStoredToken();
    setAuthenticated(false);
    setCurrentUser(null);
    setRequirePasswordChange(false);
  }, []);

  return (
    <AuthContext.Provider value={{
      currentUser,
      authenticated,
      loading,
      githubEnabled,
      githubTokenConfigured,
      anthropicEnabled,
      requirePasswordChange,
      usersExist,
      login,
      logout,
      recheck,
      refreshUser,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
