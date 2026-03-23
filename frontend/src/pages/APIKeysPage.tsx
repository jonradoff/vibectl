import { useState, useEffect } from 'react';
import { listAPIKeys, createAPIKey, revokeAPIKey } from '../api/client';
import type { APIKeyView } from '../api/client';

export default function APIKeysPage() {
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
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white mb-1">API Keys</h1>
          <p className="text-gray-400 text-sm">
            Named tokens for programmatic access (CLI, MCP, scripts). Keys inherit your permissions.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-2 px-4 rounded-lg text-sm transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          New key
        </button>
      </div>

      {/* Usage info */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 mb-6">
        <h3 className="text-sm font-medium text-gray-300 mb-2">Usage</h3>
        <p className="text-xs text-gray-500 mb-2">Include the key as a Bearer token in the Authorization header:</p>
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
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : keys.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <svg className="w-10 h-10 mx-auto mb-3 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 0 1 21.75 8.25Z" />
          </svg>
          <p className="text-sm">No API keys yet</p>
          <p className="text-xs mt-1">Create one to get started</p>
        </div>
      ) : (
        <div className="space-y-2">
          {keys.map(key => (
            <KeyRow
              key={key.id}
              apiKey={key}
              onRevoke={async () => {
                await revokeAPIKey(key.id);
                load();
              }}
            />
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
  const copy = () => {
    navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-4 mb-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <p className="text-green-300 font-medium text-sm mb-1">"{name}" created</p>
          <p className="text-green-200/70 text-xs mb-2">
            Copy this token now — it will never be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="font-mono text-xs text-white bg-gray-900 border border-gray-700 rounded px-3 py-2 flex-1 min-w-0 break-all">
              {token}
            </code>
            <button
              onClick={copy}
              className="shrink-0 text-xs text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded px-2 py-1.5 transition-colors"
            >
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

  const handleRevoke = async () => {
    setBusy(true);
    try { await onRevoke(); } finally { setBusy(false); setConfirming(false); }
  };

  const formatDate = (d: string) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="flex items-center gap-4 bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
      <svg className="w-5 h-5 text-gray-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 0 1 21.75 8.25Z" />
      </svg>
      <div className="flex-1 min-w-0">
        <p className="text-white text-sm font-medium">{apiKey.name}</p>
        <p className="text-xs text-gray-500">
          Created {formatDate(apiKey.createdAt)}
          {apiKey.lastUsedAt ? ` · Last used ${formatDate(apiKey.lastUsedAt)}` : ' · Never used'}
        </p>
      </div>
      <div className="shrink-0">
        {confirming ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400">Revoke?</span>
            <button
              disabled={busy}
              onClick={handleRevoke}
              className="text-xs text-red-400 border border-red-800 hover:bg-red-900/30 rounded px-2 py-1 transition-colors disabled:opacity-50"
            >
              Yes, revoke
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="text-xs text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 rounded px-2 py-1 transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="text-xs text-gray-500 hover:text-red-400 border border-gray-700 hover:border-red-800 rounded px-2 py-1 transition-colors"
          >
            Revoke
          </button>
        )}
      </div>
    </div>
  );
}

function CreateKeyModal({ onClose, onCreate }: {
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setError('');
    setIsLoading(true);
    try {
      await onCreate(name.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create key');
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-white mb-5">Create API key</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Key name <span className="text-red-400">*</span></label>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. My Laptop CLI, CI/CD pipeline"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <p className="text-xs text-gray-500">
            The raw token is shown once on creation. It inherits all your project permissions.
          </p>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="text-sm text-gray-400 hover:text-white px-4 py-2 rounded-lg transition-colors">
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading || !name.trim()}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium py-2 px-4 rounded-lg text-sm transition-colors"
            >
              {isLoading ? 'Creating…' : 'Create key'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
