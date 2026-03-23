import { useState, useEffect } from 'react';
import { listUsers, preAuthorizeUser, createEmailUser, setPasswordForUser, updateUser } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import type { User, GlobalRole, ProjectRole } from '../types';

function GitHubOAuthNotice() {
  const [showHelp, setShowHelp] = useState(false);
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 mb-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-amber-300 font-medium text-sm mb-1">GitHub OAuth is not configured</p>
          <p className="text-amber-200/70 text-sm">
            Team members cannot sign in with GitHub until OAuth credentials are set. Only the built-in admin password login is currently active.
          </p>
        </div>
        <button
          onClick={() => setShowHelp(v => !v)}
          className="text-xs text-amber-300 hover:text-amber-200 border border-amber-500/40 rounded px-2 py-1 shrink-0 transition-colors"
        >
          {showHelp ? 'Hide' : 'Setup guide'}
        </button>
      </div>
      {showHelp && (
        <div className="mt-4 rounded-lg border border-amber-500/20 bg-gray-900/50 p-4 text-sm space-y-3">
          <ol className="list-decimal list-inside space-y-1.5 text-gray-300">
            <li>Go to <span className="text-indigo-400 font-mono">github.com/settings/developers</span> → <strong>OAuth Apps</strong> → <strong>New OAuth App</strong>.</li>
            <li>
              Set the <strong>Authorization callback URL</strong> to:
              <pre className="mt-1 rounded bg-gray-900 px-3 py-2 text-xs text-green-300 overflow-x-auto">{window.location.origin}/api/v1/auth/github/callback</pre>
            </li>
            <li>Copy the <strong>Client ID</strong> and generate a <strong>Client Secret</strong>.</li>
            <li>
              Set both as environment variables and restart VibeCtl:
              <pre className="mt-1 rounded bg-gray-900 px-3 py-2 text-xs text-green-300 overflow-x-auto">{`GITHUB_CLIENT_ID=Ov23li...
GITHUB_CLIENT_SECRET=abc123...`}</pre>
            </li>
            <li>On Fly.io: <span className="font-mono text-xs text-green-300">fly secrets set GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=...</span></li>
          </ol>
          <p className="text-gray-500 text-xs">Full setup guide is also available in Settings.</p>
        </div>
      )}
    </div>
  );
}

const ROLE_DESCRIPTIONS: Record<ProjectRole, string> = {
  owner: 'Full control — manage members, deploy, commit, push',
  devops: 'Deploy to prod, push to GitHub, commit',
  developer: 'Commit changes, run CI',
  contributor: 'Create & update issues, add feedback',
  reporter: 'Create issues and feedback',
  viewer: 'Read-only access',
};

export default function UsersPage() {
  const { currentUser, githubEnabled } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showCreateEmail, setShowCreateEmail] = useState(false);

  const load = async () => {
    try {
      const data = await listUsers();
      setUsers(data);
    } catch {
      // permission error — handled in UI
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const isSuperAdmin = currentUser?.globalRole === 'super_admin';

  if (!isSuperAdmin) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-12">
        <p className="text-gray-400">You need super_admin access to manage users.</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white mb-1">Users</h1>
          <p className="text-gray-400 text-sm">Manage user accounts and access levels.</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowCreateEmail(true)}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-2 px-4 rounded-lg text-sm transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Add Email/Password User
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 bg-gray-700 hover:bg-gray-600 text-white font-medium py-2 px-4 rounded-lg text-sm transition-colors"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z" />
            </svg>
            Pre-authorize GitHub
          </button>
        </div>
      </div>

      {/* GitHub OAuth notice */}
      {!githubEnabled && <GitHubOAuthNotice />}

      {/* Admin fallback notice */}
      {currentUser?.isAdminFallback && (
        <div className="rounded-xl border border-blue-500/30 bg-blue-500/10 p-4 mb-6">
          <p className="text-blue-300 font-medium text-sm mb-1">You are the built-in admin</p>
          <p className="text-blue-200/70 text-sm">
            Your account was automatically created from the legacy admin password. To add team members,
            enter their GitHub username below — they'll be able to sign in with GitHub OAuth once added.
            Each user can be assigned a <strong>project-level role</strong> (owner, devops, developer, contributor,
            reporter, or viewer) on each project separately.
          </p>
        </div>
      )}

      {/* Roles reference */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 mb-6">
        <h3 className="text-sm font-medium text-gray-300 mb-3">Project Role Reference</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {(Object.entries(ROLE_DESCRIPTIONS) as [ProjectRole, string][]).map(([role, desc]) => (
            <div key={role} className="flex items-start gap-2.5">
              <span className={`mt-0.5 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold shrink-0 ${roleBadgeClass(role)}`}>
                {role}
              </span>
              <span className="text-xs text-gray-400">{desc}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-gray-500 mt-3">
          Global role "super_admin" bypasses all project-level checks.
          Project roles are set per-project in the project settings → Members tab.
        </p>
      </div>

      {/* User list */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="space-y-2">
          {users.map(u => (
            <UserRow
              key={u.id}
              user={u}
              isSelf={u.id === currentUser?.id}
              onUpdate={async (updates) => {
                await updateUser(u.id, updates);
                load();
              }}
              onReload={load}
            />
          ))}
        </div>
      )}

      {/* Pre-authorize modal */}
      {showCreate && (
        <PreAuthorizeModal
          onClose={() => setShowCreate(false)}
          onCreate={async (githubUsername, displayName, globalRole) => {
            await preAuthorizeUser({ githubUsername, displayName: displayName || undefined, globalRole });
            setShowCreate(false);
            load();
          }}
        />
      )}

      {/* Email/Password user creation modal */}
      {showCreateEmail && (
        <CreateEmailUserModal
          onClose={() => setShowCreateEmail(false)}
          onCreated={() => { setShowCreateEmail(false); load(); }}
        />
      )}
    </div>
  );
}

function roleBadgeClass(role: ProjectRole | GlobalRole): string {
  const map: Record<string, string> = {
    owner: 'bg-purple-500/20 text-purple-300',
    devops: 'bg-orange-500/20 text-orange-300',
    developer: 'bg-blue-500/20 text-blue-300',
    contributor: 'bg-green-500/20 text-green-300',
    reporter: 'bg-yellow-500/20 text-yellow-300',
    viewer: 'bg-gray-500/20 text-gray-300',
    super_admin: 'bg-red-500/20 text-red-300',
    member: 'bg-gray-500/20 text-gray-400',
  };
  return map[role] ?? 'bg-gray-500/20 text-gray-400';
}

function UserRow({ user, isSelf, onUpdate, onReload }: {
  user: User;
  isSelf: boolean;
  onUpdate: (updates: Partial<User>) => Promise<void>;
  onReload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [showSetPassword, setShowSetPassword] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [tempPassword, setTempPassword] = useState('');

  const toggle = async (field: 'disabled' | 'globalRole', value: boolean | GlobalRole) => {
    setBusy(true);
    try {
      await onUpdate({ [field]: value });
    } finally {
      setBusy(false);
    }
  };

  const handleSetPassword = async (email?: string) => {
    setBusy(true);
    try {
      const res = await setPasswordForUser(user.id, { email });
      setTempPassword(res.temporaryPassword);
      onReload();
    } catch {
      // handled via UI
    } finally {
      setBusy(false);
    }
  };

  // Show password button for any non-admin-fallback user (not self)
  // — users with email get "Reset password"; GitHub-only users get "Set password"
  const canManagePassword = !isSelf && !user.isAdminFallback;

  return (
    <div className="flex items-center gap-4 bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
      <div className="w-9 h-9 rounded-full bg-indigo-600/30 flex items-center justify-center text-indigo-300 font-semibold text-sm shrink-0">
        {user.displayName.charAt(0).toUpperCase()}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-white text-sm font-medium">{user.displayName}</span>
          {isSelf && <span className="text-[10px] text-gray-500">(you)</span>}
          {user.isAdminFallback && (
            <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-yellow-500/20 text-yellow-300">admin fallback</span>
          )}
          <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold ${roleBadgeClass(user.globalRole)}`}>
            {user.globalRole}
          </span>
          {!user.githubId && user.githubUsername && (
            <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-amber-500/20 text-amber-300">pending first login</span>
          )}
          {user.disabled && (
            <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-red-500/20 text-red-300">disabled</span>
          )}
        </div>
        <div className="text-xs text-gray-500 truncate">
          {user.githubUsername ? `@${user.githubUsername}` : ''}{user.githubUsername && user.email ? ' · ' : ''}{user.email || (!user.githubUsername ? 'admin fallback' : '')}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {!user.isAdminFallback && (
          <button
            disabled={busy}
            onClick={() => setShowEdit(true)}
            className="text-xs text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded px-2 py-1 transition-colors disabled:opacity-50"
          >
            Edit
          </button>
        )}
        {canManagePassword && (
          <button
            disabled={busy}
            onClick={() => setShowSetPassword(true)}
            className="text-xs text-indigo-400 hover:text-indigo-300 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded px-2 py-1 transition-colors disabled:opacity-50"
          >
            {user.email ? 'Reset password' : 'Set password'}
          </button>
        )}
        {!isSelf && (
          <>
            <button
              disabled={busy || user.isAdminFallback}
              onClick={() => toggle('globalRole', user.globalRole === 'super_admin' ? 'member' : 'super_admin')}
              className="text-xs text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded px-2 py-1 transition-colors disabled:opacity-50"
            >
              {user.globalRole === 'super_admin' ? 'Demote' : 'Make admin'}
            </button>
            <button
              disabled={busy || user.isAdminFallback}
              onClick={() => toggle('disabled', !user.disabled)}
              className={`text-xs border rounded px-2 py-1 transition-colors disabled:opacity-50 ${
                user.disabled
                  ? 'text-green-400 border-green-700 hover:bg-green-900/30'
                  : 'text-red-400 border-red-800 hover:bg-red-900/30'
              }`}
            >
              {user.disabled ? 'Enable' : 'Disable'}
            </button>
          </>
        )}
      </div>

      {/* Edit profile modal */}
      {showEdit && (
        <EditUserModal
          user={user}
          onClose={() => setShowEdit(false)}
          onSave={async (updates) => { await onUpdate(updates); setShowEdit(false); }}
        />
      )}

      {/* Set / reset password modal */}
      {showSetPassword && !tempPassword && (
        <SetPasswordInlineModal
          userName={user.displayName}
          hasEmail={!!user.email}
          onCancel={() => setShowSetPassword(false)}
          onConfirm={(email) => handleSetPassword(email)}
          busy={busy}
        />
      )}
      {tempPassword && (
        <TempPasswordDisplay password={tempPassword} onClose={() => { setTempPassword(''); setShowSetPassword(false); }} />
      )}
    </div>
  );
}

function PreAuthorizeModal({ onClose, onCreate }: {
  onClose: () => void;
  onCreate: (githubUsername: string, displayName: string, globalRole: string) => Promise<void>;
}) {
  const [githubUsername, setGithubUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [globalRole, setGlobalRole] = useState('member');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!githubUsername.trim()) return;
    setError('');
    setIsLoading(true);
    try {
      await onCreate(githubUsername.trim().replace(/^@/, ''), displayName.trim(), globalRole);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to pre-authorize user');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-white mb-1">Pre-authorize GitHub user</h2>
        <p className="text-sm text-gray-400 mb-5">
          The user will be able to sign in with their GitHub account once added.
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">
              GitHub username <span className="text-red-400">*</span>
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">@</span>
              <input
                autoFocus
                type="text"
                value={githubUsername}
                onChange={e => setGithubUsername(e.target.value)}
                placeholder="octocat"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-7 pr-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">
              Display name <span className="text-gray-600">(optional — defaults to username)</span>
            </label>
            <input
              type="text"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder="Alice Smith"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Global role</label>
            <select
              value={globalRole}
              onChange={e => setGlobalRole(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-indigo-500"
            >
              <option value="member">member — access controlled by project roles</option>
              <option value="super_admin">super_admin — full access to everything</option>
            </select>
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="text-sm text-gray-400 hover:text-white px-4 py-2 rounded-lg transition-colors">
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading || !githubUsername.trim()}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium py-2 px-4 rounded-lg text-sm transition-colors"
            >
              {isLoading ? 'Adding…' : 'Pre-authorize'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CreateEmailUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [globalRole, setGlobalRole] = useState('member');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [tempPassword, setTempPassword] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setError('');
    setIsLoading(true);
    try {
      const result = await createEmailUser({ email: email.trim(), displayName: displayName.trim() || undefined, globalRole });
      setTempPassword(result.temporaryPassword);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user');
    } finally {
      setIsLoading(false);
    }
  };

  if (tempPassword) {
    return (
      <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
        <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md p-6">
          <h2 className="text-lg font-semibold text-white mb-1">User Created</h2>
          <p className="text-sm text-gray-400 mb-4">
            Share this temporary password with the user. They will be required to change it on first login.
          </p>
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 mb-4">
            <p className="text-[10px] uppercase text-amber-400 font-semibold mb-2">Temporary Password (shown once)</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-lg font-mono text-white bg-gray-800 rounded px-3 py-2 select-all">{tempPassword}</code>
              <button
                onClick={() => navigator.clipboard.writeText(tempPassword)}
                className="text-xs text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded px-2 py-2 transition-colors"
              >
                Copy
              </button>
            </div>
          </div>
          <button
            onClick={() => { onCreated(); }}
            className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-2.5 rounded-lg text-sm transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-white mb-1">Add Email/Password User</h2>
        <p className="text-sm text-gray-400 mb-5">
          Create a user account with email login. A temporary password will be generated.
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Email <span className="text-red-400">*</span></label>
            <input
              autoFocus type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="user@example.com"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Display name <span className="text-gray-600">(optional)</span></label>
            <input
              type="text" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Alice Smith"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Global role</label>
            <select value={globalRole} onChange={e => setGlobalRole(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-indigo-500">
              <option value="member">member</option>
              <option value="super_admin">super_admin</option>
            </select>
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="text-sm text-gray-400 hover:text-white px-4 py-2 rounded-lg transition-colors">Cancel</button>
            <button type="submit" disabled={isLoading || !email.trim()}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium py-2 px-4 rounded-lg text-sm transition-colors">
              {isLoading ? 'Creating…' : 'Create User'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SetPasswordInlineModal({ userName, hasEmail, onCancel, onConfirm, busy }: {
  userName: string; hasEmail: boolean; onCancel: () => void; onConfirm: (email?: string) => void; busy: boolean;
}) {
  const [email, setEmail] = useState('');
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4" onClick={onCancel}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-sm p-5" onClick={e => e.stopPropagation()}>
        {hasEmail ? (
          <>
            <h3 className="text-sm font-semibold text-white mb-2">Reset password for {userName}?</h3>
            <p className="text-xs text-gray-400 mb-4">
              A new temporary password will be generated. The user will be required to set a new password on next login.
            </p>
          </>
        ) : (
          <>
            <h3 className="text-sm font-semibold text-white mb-3">Set password for {userName}</h3>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Email address</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="user@example.com" autoFocus
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          </>
        )}
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onCancel} className="text-xs text-gray-400 hover:text-white px-3 py-1.5 rounded transition-colors">Cancel</button>
          <button onClick={() => onConfirm(hasEmail ? undefined : (email || undefined))} disabled={busy || (!hasEmail && !email.trim())}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors">
            {busy ? 'Generating…' : hasEmail ? 'Reset Password' : 'Set Password'}
          </button>
        </div>
      </div>
    </div>
  );
}

function EditUserModal({ user, onClose, onSave }: {
  user: User;
  onClose: () => void;
  onSave: (updates: Partial<User>) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [email, setEmail] = useState(user.email || '');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);
    try {
      await onSave({
        displayName: displayName.trim() || undefined,
        email: email.trim() || undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-sm p-5" onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-white mb-4">Edit — {user.displayName}</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Display name</label>
            <input
              type="text" value={displayName} onChange={e => setDisplayName(e.target.value)} autoFocus
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Email address</label>
            <input
              type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="user@example.com"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="text-xs text-gray-400 hover:text-white px-3 py-1.5 rounded transition-colors">Cancel</button>
            <button type="submit" disabled={isLoading || !displayName.trim()}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors">
              {isLoading ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function TempPasswordDisplay({ password, onClose }: { password: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-sm p-5" onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-white mb-2">Temporary Password</h3>
        <p className="text-xs text-gray-400 mb-3">Share this with the user. They must change it on first login.</p>
        <div className="flex items-center gap-2 mb-4">
          <code className="flex-1 text-base font-mono text-white bg-gray-800 rounded px-3 py-2 select-all">{password}</code>
          <button onClick={() => navigator.clipboard.writeText(password)}
            className="text-xs text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded px-2 py-2 transition-colors">Copy</button>
        </div>
        <button onClick={onClose} className="w-full bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium py-2 rounded-lg transition-colors">Done</button>
      </div>
    </div>
  );
}
