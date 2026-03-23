import { useState, useEffect, type FormEvent } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { updateSelfProfile, setSelfAnthropicKey, setSelfGitHubPAT, changeOwnPassword, setStoredToken } from '../api/client';
import { useSearchParams } from 'react-router-dom';

export default function ProfilePage() {
  const { currentUser, refreshUser } = useAuth();

  useEffect(() => { refreshUser(); }, []);

  if (!currentUser) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-12">
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  const { githubEnabled } = useAuth();
  const [searchParams] = useSearchParams();
  const [linkSuccess, setLinkSuccess] = useState(false);

  useEffect(() => {
    if (searchParams.get('linked') === 'github') {
      setLinkSuccess(true);
      refreshUser();
    }
  }, [searchParams, refreshUser]);

  // Show password section for admin fallback users AND email/password users (anyone with a passwordHash)
  const showPasswordSection = currentUser.isAdminFallback || !!currentUser.email;

  return (
    <div className="max-w-2xl mx-auto px-6 py-8">
      <h1 className="text-2xl font-bold text-white mb-8">Profile</h1>

      {linkSuccess && (
        <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-4 mb-6">
          <p className="text-green-300 font-medium text-sm">GitHub account linked successfully!</p>
        </div>
      )}

      <div className="space-y-6">
        <ProfileSection user={currentUser} onSaved={refreshUser} />
        {!currentUser.githubId && githubEnabled && <GitHubLinkSection />}
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
        <AnthropicKeySection hasKey={currentUser.hasAnthropicKey} onSaved={refreshUser} />
        <GitHubPATSection hasPAT={currentUser.hasGitHubPAT} onSaved={refreshUser} />
      </div>
    </div>
  );
}

function ProfileSection({ user, onSaved }: { user: { displayName: string; email?: string; gitName?: string; gitEmail?: string; githubUsername?: string }; onSaved: () => Promise<void> }) {
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
      {user.githubUsername && (
        <div className="flex items-center gap-2 mb-4 text-sm text-gray-400">
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z" />
          </svg>
          Connected as @{user.githubUsername}
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Display name</label>
            <input
              type="text"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
          </div>
        </div>
        <div className="border-t border-gray-800 pt-4">
          <p className="text-xs text-gray-500 mb-3">Git commit identity — used when committing via VibeCtl CI</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Git name</label>
              <input
                type="text"
                value={gitName}
                onChange={e => setGitName(e.target.value)}
                placeholder={user.displayName}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Git email</label>
              <input
                type="email"
                value={gitEmail}
                onChange={e => setGitEmail(e.target.value)}
                placeholder={user.email || 'you@example.com'}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          </div>
        </div>
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={busy}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium py-2 px-4 rounded-lg text-sm transition-colors"
          >
            {busy ? 'Saving…' : saved ? 'Saved!' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  );
}

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
                GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
              </a>
            </li>
            <li className="flex gap-2"><span className="text-gray-600 shrink-0">2.</span>Click <strong className="text-gray-300">Generate new token (classic)</strong></li>
            <li className="flex gap-2"><span className="text-gray-600 shrink-0">3.</span>Give it a name like <code className="bg-gray-700 px-1 rounded text-gray-300">VibeCtl</code> and set an expiration</li>
            <li className="flex gap-2"><span className="text-gray-600 shrink-0">4.</span>Under <strong className="text-gray-300">Scopes</strong>, check <code className="bg-gray-700 px-1 rounded text-gray-300">repo</code> (gives read/write access to your repos)</li>
            <li className="flex gap-2"><span className="text-gray-600 shrink-0">5.</span>Click <strong className="text-gray-300">Generate token</strong>, copy the token, and paste it below</li>
          </ol>
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          type="password"
          value={pat}
          onChange={e => setPat(e.target.value)}
          placeholder={hasPAT ? 'Enter new token to replace' : 'github_pat_...'}
          autoComplete="new-password"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm font-mono placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
        />
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
        <input
          type="password"
          value={key}
          onChange={e => setKey(e.target.value)}
          placeholder={hasKey ? 'Enter new key to replace' : 'sk-ant-...'}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm font-mono placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
        />
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
