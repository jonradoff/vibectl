import { useState, useEffect, type FormEvent } from 'react';
import { useAuth } from '../contexts/AuthContext';
import {
  updateSelfProfile, setSelfAnthropicKey, setSelfGitHubPAT,
  changeOwnPassword, setStoredToken,
  listAPIKeys, createAPIKey, revokeAPIKey,
} from '../api/client';
import type { APIKeyView } from '../api/client';
import { useSearchParams } from 'react-router-dom';

// ─── Tab config ──────────────────────────────────────────────────────────────

type TabKey = 'profile' | 'github' | 'llms' | 'api-keys' | 'claude-code';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'profile',     label: 'Profile'     },
  { key: 'github',      label: 'GitHub'      },
  { key: 'llms',        label: 'LLMs'        },
  { key: 'api-keys',    label: 'API Keys'    },
  { key: 'claude-code', label: 'Claude Code' },
];

// ─── Page shell ──────────────────────────────────────────────────────────────

export default function ProfilePage() {
  const { currentUser, refreshUser, githubEnabled } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [linkSuccess, setLinkSuccess] = useState(false);

  useEffect(() => { refreshUser(); }, []);

  useEffect(() => {
    if (searchParams.get('linked') === 'github') {
      setLinkSuccess(true);
      refreshUser();
    }
  }, [searchParams, refreshUser]);

  const rawTab = searchParams.get('tab') as TabKey | null;
  const activeTab: TabKey = TABS.some(t => t.key === rawTab) ? rawTab! : 'profile';

  const setTab = (tab: TabKey) => {
    const next = new URLSearchParams(searchParams);
    if (tab === 'profile') next.delete('tab');
    else next.set('tab', tab);
    setSearchParams(next, { replace: true });
  };

  if (!currentUser) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-12 flex items-center justify-center py-16">
        <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const showPasswordSection = currentUser.isAdminFallback || !!currentUser.email;

  return (
    <div className="max-w-2xl mx-auto px-6 py-8">
      <h1 className="text-2xl font-bold text-white mb-6">Account</h1>

      {linkSuccess && (
        <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-4 mb-6">
          <p className="text-green-300 font-medium text-sm">GitHub account linked successfully!</p>
        </div>
      )}

      {/* Tab bar */}
      <div className="flex border-b border-gray-800 mb-6">
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setTab(tab.key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
              activeTab === tab.key
                ? 'border-indigo-500 text-white'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'profile' && (
        <div className="space-y-6">
          <ProfileSection user={currentUser} onSaved={refreshUser} />
          {currentUser.githubId && currentUser.isDefaultPassword && currentUser.email && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
              <p className="text-amber-300 font-medium text-sm mb-1">You have a temporary password</p>
              <p className="text-amber-200/70 text-sm">
                Your account was assigned a temporary password. You're signed in via GitHub so you don't need it,
                but you can set a permanent password below if you'd like to log in with email too.
              </p>
            </div>
          )}
          {showPasswordSection && <PasswordSection />}
        </div>
      )}

      {activeTab === 'github' && (
        <div className="space-y-6">
          {!currentUser.githubId && githubEnabled && <GitHubLinkSection />}
          {currentUser.githubId && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <h2 className="text-base font-semibold text-white mb-1">GitHub OAuth</h2>
              <div className="flex items-center gap-2 text-sm text-green-400">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z" />
                </svg>
                Connected as @{currentUser.githubUsername}
              </div>
            </div>
          )}
          {!githubEnabled && !currentUser.githubId && (
            <div className="rounded-xl border border-gray-800 bg-gray-900 p-5 text-sm text-gray-500">
              GitHub OAuth is not configured on this server. Ask your admin to add <code className="text-gray-400">GITHUB_CLIENT_ID</code> and <code className="text-gray-400">GITHUB_CLIENT_SECRET</code>.
            </div>
          )}
          <GitHubPATSection hasPAT={currentUser.hasGitHubPAT} onSaved={refreshUser} />
        </div>
      )}

      {activeTab === 'llms' && (
        <div className="space-y-6">
          <AnthropicKeySection hasKey={currentUser.hasAnthropicKey} onSaved={refreshUser} />
        </div>
      )}

      {activeTab === 'api-keys' && (
        <APIKeysTab />
      )}

      {activeTab === 'claude-code' && (
        <ClaudeCodePrefsSection
          fontSize={currentUser.claudeCodeFontSize || 14}
          onSaved={refreshUser}
        />
      )}
    </div>
  );
}

// ─── Profile tab ─────────────────────────────────────────────────────────────

function ProfileSection({ user, onSaved }: {
  user: { displayName: string; email?: string; gitName?: string; gitEmail?: string; githubUsername?: string };
  onSaved: () => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [email, setEmail] = useState(user.email ?? '');
  const [gitName, setGitName] = useState(user.gitName ?? '');
  const [gitEmail, setGitEmail] = useState(user.gitEmail ?? '');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await updateSelfProfile({
        displayName: displayName.trim() || user.displayName,
        email: email.trim() || undefined,
        gitName: gitName.trim() || undefined,
        gitEmail: gitEmail.trim() || undefined,
      });
      await onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
      <h2 className="text-base font-semibold text-white mb-4">Personal info</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Display name</label>
            <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500" />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500" />
          </div>
        </div>
        <div className="border-t border-gray-800 pt-4">
          <p className="text-xs text-gray-500 mb-3">Git commit identity — used when committing via VibeCtl CI</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Git name</label>
              <input type="text" value={gitName} onChange={e => setGitName(e.target.value)} placeholder={user.displayName}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Git email</label>
              <input type="email" value={gitEmail} onChange={e => setGitEmail(e.target.value)} placeholder={user.email || 'you@example.com'}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500" />
            </div>
          </div>
        </div>
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <div className="flex justify-end">
          <button type="submit" disabled={busy}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium py-2 px-4 rounded-lg text-sm transition-colors">
            {busy ? 'Saving…' : saved ? 'Saved!' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  );
}

function PasswordSection() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (next !== confirm) { setError('Passwords do not match.'); return; }
    if (next.length < 8) { setError('Password must be at least 8 characters.'); return; }
    setBusy(true);
    try {
      const { token } = await changeOwnPassword(current, next);
      setStoredToken(token);
      setCurrent(''); setNext(''); setConfirm('');
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
      <h2 className="text-base font-semibold text-white mb-4">Change password</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm text-gray-400 mb-1.5">Current password</label>
          <input type="password" value={current} onChange={e => setCurrent(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">New password</label>
            <input type="password" value={next} onChange={e => setNext(e.target.value)} placeholder="At least 8 characters"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500" />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Confirm new password</label>
            <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500" />
          </div>
        </div>
        {error && <p className="text-red-400 text-sm">{error}</p>}
        {success && <p className="text-green-400 text-sm">Password changed successfully.</p>}
        <div className="flex justify-end">
          <button type="submit" disabled={busy || !current || !next || !confirm}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium py-2 px-4 rounded-lg text-sm transition-colors">
            {busy ? 'Saving…' : 'Change password'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── GitHub tab ───────────────────────────────────────────────────────────────

function GitHubLinkSection() {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <h2 className="text-base font-semibold text-white mb-1">Link GitHub Account</h2>
      <p className="text-sm text-gray-400 mb-4">
        Connect your GitHub account to enable GitHub OAuth login and access to private repos.
      </p>
      <button
        onClick={() => { window.location.href = '/api/v1/auth/github/link'; }}
        className="flex items-center gap-2.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-white font-medium py-2.5 px-4 rounded-lg text-sm transition-colors"
      >
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z" />
        </svg>
        Connect GitHub Account
      </button>
    </div>
  );
}

function GitHubPATSection({ hasPAT, onSaved }: { hasPAT: boolean; onSaved: () => Promise<void> }) {
  const [pat, setPat] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await setSelfGitHubPAT(pat.trim());
      await onSaved();
      setPat('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save token');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
      <h2 className="text-base font-semibold text-white mb-1">GitHub Personal Access Token</h2>
      <p className="text-sm text-gray-500 mb-4">
        {hasPAT
          ? 'Token stored (encrypted). Used for clone/pull/push operations on this server.'
          : 'Required to clone and pull repositories on this server.'}
      </p>
      {!hasPAT && (
        <div className="mb-5 rounded-xl border border-gray-800 bg-gray-800/40 p-4 space-y-3">
          <p className="text-xs font-semibold text-gray-300 uppercase tracking-wide">How to create a token</p>
          <ol className="space-y-2 text-sm text-gray-400">
            <li className="flex gap-2"><span className="text-gray-600 shrink-0">1.</span>Go to{' '}
              <a href="https://github.com/settings/tokens/new?scopes=repo&description=VibeCtl" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:text-indigo-300 underline">
                GitHub → Settings → Developer settings → Personal access tokens
              </a>
            </li>
            <li className="flex gap-2"><span className="text-gray-600 shrink-0">2.</span>Click <strong className="text-gray-300">Generate new token (classic)</strong></li>
            <li className="flex gap-2"><span className="text-gray-600 shrink-0">3.</span>Give it a name like <code className="bg-gray-700 px-1 rounded text-gray-300">VibeCtl</code> and set an expiration</li>
            <li className="flex gap-2"><span className="text-gray-600 shrink-0">4.</span>Check <code className="bg-gray-700 px-1 rounded text-gray-300">repo</code> scope, then generate and paste below</li>
          </ol>
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-3">
        <input type="password" value={pat} onChange={e => setPat(e.target.value)}
          placeholder={hasPAT ? 'Enter new token to replace' : 'github_pat_...'}
          autoComplete="new-password"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm font-mono placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500" />
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <div className="flex justify-end">
          <button type="submit" disabled={busy || !pat.trim()}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium py-2 px-4 rounded-lg text-sm transition-colors">
            {busy ? 'Saving…' : saved ? 'Saved!' : hasPAT ? 'Update token' : 'Save token'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── LLMs tab ─────────────────────────────────────────────────────────────────

function AnthropicKeySection({ hasKey, onSaved }: { hasKey: boolean; onSaved: () => Promise<void> }) {
  const [key, setKey] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await setSelfAnthropicKey(key.trim());
      await onSaved();
      setKey('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save key');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
      <h2 className="text-base font-semibold text-white mb-1">Anthropic API key</h2>
      <p className="text-sm text-gray-500 mb-4">
        {hasKey
          ? 'Your personal Anthropic key is stored (encrypted). Update it below.'
          : 'Store your personal Anthropic API key to use AI features.'}
      </p>
      <form onSubmit={handleSubmit} className="space-y-3">
        <input type="password" value={key} onChange={e => setKey(e.target.value)}
          placeholder={hasKey ? 'Enter new key to replace' : 'sk-ant-...'}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm font-mono placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500" />
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <div className="flex justify-end">
          <button type="submit" disabled={busy || !key.trim()}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium py-2 px-4 rounded-lg text-sm transition-colors">
            {busy ? 'Saving…' : saved ? 'Saved!' : hasKey ? 'Update key' : 'Save key'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── API Keys tab ─────────────────────────────────────────────────────────────

function APIKeysTab() {
  const [keys, setKeys] = useState<APIKeyView[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newToken, setNewToken] = useState<{ name: string; token: string } | null>(null);

  const load = async () => {
    try {
      const data = await listAPIKeys();
      setKeys(data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-400">
          Named tokens for programmatic access (CLI, MCP, scripts). Keys inherit your permissions.
        </p>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-2 px-4 rounded-lg text-sm transition-colors shrink-0 ml-4"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          New key
        </button>
      </div>

      {/* Usage info */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
        <h3 className="text-sm font-medium text-gray-300 mb-2">Usage</h3>
        <p className="text-xs text-gray-500 mb-2">Include the key as a Bearer token:</p>
        <pre className="text-xs text-indigo-300 font-mono bg-gray-950 border border-gray-800 rounded px-3 py-2 overflow-x-auto">
          {`Authorization: Bearer vk_<your-key>`}
        </pre>
        <p className="text-xs text-gray-500 mt-2">
          Or set <code className="text-gray-400">VIBECTL_TOKEN=vk_...</code> in your environment.
        </p>
      </div>

      {/* New token reveal */}
      {newToken && (
        <NewTokenBanner
          name={newToken.name}
          token={newToken.token}
          onDismiss={() => setNewToken(null)}
        />
      )}

      {/* Key list */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : keys.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <svg className="w-10 h-10 mx-auto mb-3 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 0 1 21.75 8.25Z" />
          </svg>
          <p className="text-sm">No API keys yet</p>
          <p className="text-xs mt-1">Create one to get started</p>
        </div>
      ) : (
        <div className="space-y-2">
          {keys.map(key => (
            <KeyRow key={key.id} apiKey={key} onRevoke={async () => { await revokeAPIKey(key.id); load(); }} />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateKeyModal
          onClose={() => setShowCreate(false)}
          onCreate={async (name) => {
            const { token } = await createAPIKey(name);
            setShowCreate(false);
            setNewToken({ name, token });
            load();
          }}
        />
      )}
    </div>
  );
}

function NewTokenBanner({ name, token, onDismiss }: { name: string; token: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard.writeText(token); setCopied(true); setTimeout(() => setCopied(false), 2000); };

  return (
    <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <p className="text-green-300 font-medium text-sm mb-1">"{name}" created</p>
          <p className="text-green-200/70 text-xs mb-2">Copy this token now — it will never be shown again.</p>
          <div className="flex items-center gap-2">
            <code className="font-mono text-xs text-white bg-gray-900 border border-gray-700 rounded px-3 py-2 flex-1 min-w-0 break-all">{token}</code>
            <button onClick={copy} className="shrink-0 text-xs text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded px-2 py-1.5 transition-colors">
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
        <button onClick={onDismiss} className="text-gray-500 hover:text-gray-300 shrink-0 mt-0.5">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function KeyRow({ apiKey, onRevoke }: { apiKey: APIKeyView; onRevoke: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const handleRevoke = async () => { setBusy(true); try { await onRevoke(); } finally { setBusy(false); setConfirming(false); } };
  const formatDate = (d: string) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="flex items-center gap-4 bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
      <svg className="w-5 h-5 text-gray-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 0 1 21.75 8.25Z" />
      </svg>
      <div className="flex-1 min-w-0">
        <p className="text-white text-sm font-medium">{apiKey.name}</p>
        <p className="text-xs text-gray-500">
          Created {formatDate(apiKey.createdAt)}{apiKey.lastUsedAt ? ` · Last used ${formatDate(apiKey.lastUsedAt)}` : ' · Never used'}
        </p>
      </div>
      <div className="shrink-0">
        {confirming ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400">Revoke?</span>
            <button disabled={busy} onClick={handleRevoke} className="text-xs text-red-400 border border-red-800 hover:bg-red-900/30 rounded px-2 py-1 transition-colors disabled:opacity-50">Yes, revoke</button>
            <button onClick={() => setConfirming(false)} className="text-xs text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 rounded px-2 py-1 transition-colors">Cancel</button>
          </div>
        ) : (
          <button onClick={() => setConfirming(true)} className="text-xs text-gray-500 hover:text-red-400 border border-gray-700 hover:border-red-800 rounded px-2 py-1 transition-colors">Revoke</button>
        )}
      </div>
    </div>
  );
}

function CreateKeyModal({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setError('');
    setIsLoading(true);
    try { await onCreate(name.trim()); }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to create key'); setIsLoading(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-white mb-5">Create API key</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Key name <span className="text-red-400">*</span></label>
            <input autoFocus type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. My Laptop CLI, CI/CD pipeline"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500" />
          </div>
          <p className="text-xs text-gray-500">The raw token is shown once on creation. It inherits all your project permissions.</p>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="text-sm text-gray-400 hover:text-white px-4 py-2 rounded-lg transition-colors">Cancel</button>
            <button type="submit" disabled={isLoading || !name.trim()} className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium py-2 px-4 rounded-lg text-sm transition-colors">
              {isLoading ? 'Creating…' : 'Create key'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Claude Code preferences ─────────────────────────────────────────────────

const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 22;
const FONT_SIZE_DEFAULT = 14;

const PREVIEW_LINES = [
  { role: 'user', text: 'Add a health check endpoint to the API' },
  { role: 'assistant', text: 'I\'ll add a `/healthz` endpoint that returns the server status and dependency health.' },
  { role: 'tool', text: '$ grep -r "healthz" internal/' },
  { role: 'assistant', text: 'The endpoint is ready. It checks MongoDB connectivity and returns a JSON response with uptime and version info.' },
];

function ClaudeCodePrefsSection({ fontSize, onSaved }: { fontSize: number; onSaved: () => void }) {
  const [size, setSize] = useState(fontSize);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateSelfProfile({ claudeCodeFontSize: size });
      await onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
        <h2 className="text-base font-semibold text-white mb-4">Font Size</h2>
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <span className="text-xs text-gray-500 w-6 text-right">{FONT_SIZE_MIN}</span>
            <input
              type="range"
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              value={size}
              onChange={e => setSize(Number(e.target.value))}
              className="flex-1 accent-indigo-500"
            />
            <span className="text-xs text-gray-500 w-6">{FONT_SIZE_MAX}</span>
            <span className="text-sm font-mono text-white w-12 text-center bg-gray-800 rounded px-2 py-0.5">{size}px</span>
          </div>

          {size !== FONT_SIZE_DEFAULT && (
            <button onClick={() => setSize(FONT_SIZE_DEFAULT)} className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors">
              Reset to default ({FONT_SIZE_DEFAULT}px)
            </button>
          )}

          {/* Preview */}
          <div className="rounded-lg border border-gray-700 bg-gray-800 overflow-hidden">
            <div className="px-3 py-1.5 bg-gray-900 border-b border-gray-700">
              <span className="text-[10px] text-gray-500 uppercase tracking-wider">Preview</span>
            </div>
            <div className="px-3 py-2 space-y-2" style={{ fontSize: `${size}px` }}>
              {PREVIEW_LINES.map((line, i) => {
                if (line.role === 'user') {
                  return (
                    <div key={i} className="flex justify-end">
                      <div className="rounded-lg bg-indigo-600/30 border border-indigo-500/30 px-3 py-1.5 max-w-[85%]">
                        <p className="text-gray-200" style={{ fontSize: 'inherit' }}>{line.text}</p>
                      </div>
                    </div>
                  );
                }
                if (line.role === 'tool') {
                  return (
                    <div key={i} className="rounded bg-gray-900 border border-gray-700 px-2.5 py-1.5">
                      <code className="text-amber-300 font-mono" style={{ fontSize: `${Math.max(size - 2, 9)}px` }}>{line.text}</code>
                    </div>
                  );
                }
                return (
                  <div key={i} className="text-gray-300" style={{ fontSize: 'inherit' }}>
                    {line.text}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={handleSave}
              disabled={saving || size === fontSize}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium py-2 px-5 rounded-lg text-sm transition-colors"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            {saved && <span className="text-xs text-green-400">Saved</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
