import { useState, type FormEvent } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useMode } from '../../contexts/ModeContext';
import { ModeIndicator } from '../layout/ModeIndicator';
import { authChangePassword, setStoredToken } from '../../api/client';

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const { authenticated, loading, requirePasswordChange, usersExist } = useAuth();
  const { isClientMode, isConfigured, loading: modeLoading } = useMode();

  if (loading || modeLoading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Client mode but REMOTE_SERVER_URL not set — show setup instructions.
  if (isClientMode && !isConfigured) {
    return <ClientNotConfiguredScreen />;
  }

  if (!usersExist) {
    return <NoAdminScreen />;
  }

  if (!authenticated) {
    return <LoginScreen />;
  }

  if (requirePasswordChange) {
    return <ChangePasswordScreen />;
  }

  return <>{children}</>;
}

function ClientNotConfiguredScreen() {
  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <Logo />
        <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-5 mb-4">
          <p className="text-indigo-300 font-semibold text-sm mb-2">Client mode — remote server not configured</p>
          <p className="text-indigo-200/70 text-sm mb-4">
            This instance is running in <span className="text-white font-mono">client</span> mode but no remote server URL is set.
            Set the following environment variable and restart the server:
          </p>
          <pre className="rounded bg-gray-900 px-3 py-2.5 text-xs text-green-300 overflow-x-auto mb-3">
            REMOTE_SERVER_URL=https://your-vibectl-server.example.com
          </pre>
          <p className="text-indigo-200/70 text-sm mb-2">
            Optionally provide an API key for machine-to-machine operations:
          </p>
          <pre className="rounded bg-gray-900 px-3 py-2.5 text-xs text-green-300 overflow-x-auto">
            REMOTE_API_KEY=vk_your_api_key_here
          </pre>
        </div>
        <p className="text-gray-600 text-xs text-center">
          After setting the variables, restart the server and reload this page.
        </p>
      </div>
    </div>
  );
}

function NoAdminScreen() {
  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <Logo />
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-5">
          <p className="text-amber-300 font-semibold text-sm mb-2">No admin account configured</p>
          <p className="text-amber-200/70 text-sm mb-4">
            VibeCtl has no users yet. Set an admin password using the CLI before logging in:
          </p>
          <pre className="rounded bg-gray-900 px-3 py-2.5 text-xs text-green-300 overflow-x-auto mb-3">
            vibectl admin set-password
          </pre>
          <p className="text-gray-500 text-xs">
            On Fly.io, run: <span className="text-green-300 font-mono">fly ssh console -a vibectl</span>, then run the command above.
          </p>
        </div>
      </div>
    </div>
  );
}

function Logo() {
  return (
    <div className="flex items-center gap-3 mb-8">
      <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white font-bold text-lg">
        V
      </div>
      <span className="text-2xl font-semibold text-white tracking-tight">VibeCtl</span>
    </div>
  );
}

function LoginScreen() {
  const { login, githubEnabled } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);
    try {
      await login({ email: email || undefined, password });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('fetch') || msg.includes('network') || msg.includes('Failed to fetch')) {
        setError('Cannot reach server. Check that the backend is running.');
      } else {
        setError('Invalid email or password.');
      }
      setPassword('');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <Logo />
        <ModeIndicator />

        <form onSubmit={handleSubmit} className="space-y-4 mb-6">
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Email</label>
            <input
              type="text"
              autoFocus
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="Email address"
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Password"
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button
            type="submit"
            disabled={isLoading || !password}
            className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-2.5 rounded-lg text-sm transition-colors"
          >
            {isLoading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {githubEnabled && (
          <>
            <div className="flex items-center gap-3 mb-6">
              <div className="flex-1 h-px bg-gray-800" />
              <span className="text-xs text-gray-600">or</span>
              <div className="flex-1 h-px bg-gray-800" />
            </div>
            <button
              type="button"
              onClick={() => { window.location.href = '/api/v1/auth/github'; }}
              className="w-full flex items-center justify-center gap-2.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-white font-medium py-2.5 rounded-lg text-sm transition-colors"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z" />
              </svg>
              Continue with GitHub
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ChangePasswordScreen() {
  const { currentUser, recheck, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (newPassword !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setIsLoading(true);
    try {
      const { token } = await authChangePassword(currentPassword, newPassword);
      setStoredToken(token);
      await recheck();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <Logo />
        <ModeIndicator />
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 mb-6">
          <div className="flex items-start justify-between gap-2 mb-1">
            <p className="text-amber-300 font-medium text-sm">Password change required</p>
            <button
              onClick={logout}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors shrink-0"
            >
              Sign out
            </button>
          </div>
          {currentUser?.displayName && (
            <p className="text-amber-200/50 text-xs mb-2">Signed in as <span className="text-amber-200/80 font-medium">{currentUser.displayName}</span></p>
          )}
          <p className="text-amber-200/70 text-sm">
            {currentUser?.isAdminFallback
              ? 'You are signed in as the built-in admin. Please set a personal password.'
              : 'Your account was created with a temporary password. Please set a new one to continue.'}
          </p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Current / temporary password</label>
            <input
              type="password"
              autoFocus
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">New password</label>
            <input
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              placeholder="At least 8 characters"
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Confirm new password</label>
            <input
              type="password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button
            type="submit"
            disabled={isLoading || !currentPassword || !newPassword || !confirm}
            className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-2.5 rounded-lg text-sm transition-colors"
          >
            {isLoading ? 'Saving…' : 'Set new password'}
          </button>
        </form>
      </div>
    </div>
  );
}
