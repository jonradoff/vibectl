import { useState, type FormEvent } from 'react';
import { useAuth } from '../../contexts/AuthContext';

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const { passwordSet, authenticated, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!authenticated) {
    if (passwordSet === false) return <SetupScreen />;
    return <LoginScreen />;
  }

  return <>{children}</>;
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
  const { login } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(password);
    } catch {
      setError('Incorrect password.');
      setPassword('');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <Logo />
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Admin password</label>
            <input
              type="password"
              autoFocus
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Enter password"
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button
            type="submit"
            disabled={loading || !password}
            className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-2.5 rounded-lg text-sm transition-colors"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}

function SetupScreen() {
  const { recheck } = useAuth();

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-lg">
        <Logo />
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-5 mb-6">
          <p className="text-amber-300 font-medium text-sm mb-1">No admin password set</p>
          <p className="text-amber-200/70 text-sm">
            VibeCtl is running in open-access mode. Set a password to secure your instance.
          </p>
        </div>

        <p className="text-gray-300 text-sm mb-3">Run this command in your terminal to set a password:</p>
        <pre className="bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 text-sm text-indigo-300 font-mono mb-6 overflow-x-auto">
          vibectl admin set-password
        </pre>

        <p className="text-gray-500 text-xs mb-4">
          Or use the API directly:{' '}
          <code className="text-gray-400">POST /api/v1/admin/set-password</code>
          {' '}with{' '}
          <code className="text-gray-400">{'{ "currentPassword": "", "newPassword": "..." }'}</code>
        </p>

        <button
          onClick={recheck}
          className="w-full bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 font-medium py-2.5 rounded-lg text-sm transition-colors"
        >
          I've set a password — continue
        </button>
      </div>
    </div>
  );
}
