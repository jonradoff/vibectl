import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getSettings, updateSettings } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import type { AppSettings } from '../types';
import DelegationSection from '../components/settings/DelegationSection';
import AdaptersSection from '../components/settings/AdaptersSection';

// ─── Help Drawers ────────────────────────────────────────────────────────────

function AnthropicHelpDrawer() {
  return (
    <div className="mt-4 rounded-lg border border-indigo-500/30 bg-indigo-500/5 p-4 text-sm space-y-3">
      <p className="text-indigo-300 font-medium">How to set up your Anthropic API key</p>
      <ol className="list-decimal list-inside space-y-1.5 text-gray-300">
        <li>Go to <span className="text-indigo-400 font-mono">console.anthropic.com</span> and sign in (or create an account).</li>
        <li>Navigate to <strong>API Keys</strong> in the left sidebar.</li>
        <li>Click <strong>Create Key</strong>, give it a name (e.g. "vibectl"), and copy the key.</li>
        <li>
          Set it as an environment variable before starting VibeCtl:
          <pre className="mt-1.5 rounded bg-gray-900 px-3 py-2 text-xs text-green-300 overflow-x-auto">ANTHROPIC_API_KEY=sk-ant-...</pre>
        </li>
        <li>
          On Fly.io, set it as a secret:
          <pre className="mt-1.5 rounded bg-gray-900 px-3 py-2 text-xs text-green-300 overflow-x-auto">fly secrets set ANTHROPIC_API_KEY=sk-ant-...</pre>
        </li>
      </ol>
      <p className="text-gray-500 text-xs">
        The Anthropic API key enables: AI triage of feedback, automated issue summaries, PM review agent, architecture analysis, and VIBECTL.md auto-regeneration.
      </p>
    </div>
  );
}

function GitHubOAuthHelpDrawer() {
  const callbackURL = `${window.location.origin}/api/v1/auth/github/callback`;
  return (
    <div className="mt-4 rounded-lg border border-indigo-500/30 bg-indigo-500/5 p-4 text-sm space-y-3">
      <p className="text-indigo-300 font-medium">How to set up GitHub OAuth login</p>
      <ol className="list-decimal list-inside space-y-2 text-gray-300">
        <li>
          Go to <span className="text-indigo-400 font-mono">github.com/settings/developers</span> → <strong>OAuth Apps</strong> → <strong>New OAuth App</strong>.
        </li>
        <li>
          Fill in the form:
          <ul className="mt-1 ml-4 list-disc space-y-1 text-gray-400">
            <li><strong>Application name:</strong> VibeCtl (or any name)</li>
            <li><strong>Homepage URL:</strong> {window.location.origin}</li>
            <li><strong>Authorization callback URL:</strong> <span className="font-mono text-xs break-all">{callbackURL}</span></li>
          </ul>
        </li>
        <li>Click <strong>Register application</strong>, then copy the <strong>Client ID</strong>.</li>
        <li>Click <strong>Generate a new client secret</strong> and copy it (shown only once).</li>
        <li>
          Add both to your environment (in <span className="font-mono text-xs">.env</span> for local, or your host's secrets panel for production):
          <pre className="mt-1.5 rounded bg-gray-900 px-3 py-2 text-xs text-green-300 overflow-x-auto">{`GITHUB_CLIENT_ID=Ov23li...
GITHUB_CLIENT_SECRET=abc123...`}</pre>
        </li>
        <li>Restart VibeCtl — the "Continue with GitHub" button will appear on the login screen.</li>
        <li>Go to <strong>Users</strong> and pre-authorize team members by their GitHub username before they log in.</li>
      </ol>
      <p className="text-gray-500 text-xs mt-1">
        When users log in via GitHub, VibeCtl automatically captures their OAuth token and uses it for clone/pull/push — no manual PAT setup needed.
      </p>
    </div>
  );
}

function GitHubTokenHelpDrawer() {
  return (
    <div className="mt-4 rounded-lg border border-indigo-500/30 bg-indigo-500/5 p-4 text-sm space-y-3">
      <p className="text-indigo-300 font-medium">How to set up the GitHub API token</p>
      <ol className="list-decimal list-inside space-y-2 text-gray-300">
        <li>
          Go to <span className="text-indigo-400 font-mono">github.com/settings/tokens</span> → <strong>Tokens (classic)</strong> → <strong>Generate new token (classic)</strong>.
        </li>
        <li>
          Give it a name (e.g. "vibectl-ci"), set an expiration, and select the <strong>repo</strong> scope
          (or just <strong>public_repo</strong> if all your repos are public).
        </li>
        <li>Click <strong>Generate token</strong> and copy it.</li>
        <li>
          Add it to your environment (in <span className="font-mono text-xs">.env</span> for local, or your host's secrets panel for production):
          <pre className="mt-1.5 rounded bg-gray-900 px-3 py-2 text-xs text-green-300 overflow-x-auto">GITHUB_TOKEN=ghp_...</pre>
        </li>
        <li>Restart VibeCtl — the CI tab will start showing commit history and check run status.</li>
      </ol>
      <p className="text-gray-500 text-xs mt-1">
        This is a server-level read token used only for fetching CI status (last commit, check runs). It is
        separate from per-user tokens used for clone/pull/push. Without it, the GitHub API rate limit is
        60 requests/hour for the whole server; with it, you get 5 000/hour.
      </p>
    </div>
  );
}

// ─── Dependency status card ───────────────────────────────────────────────────

type DepStatus = 'ok' | 'warn' | 'error';

function DepCard({
  label,
  status,
  description,
  helpContent,
}: {
  label: string;
  status: DepStatus;
  description: string;
  helpContent?: React.ReactNode;
}) {
  const [showHelp, setShowHelp] = useState(false);

  const dot = {
    ok: 'bg-green-500',
    warn: 'bg-amber-500',
    error: 'bg-red-500',
  }[status];

  const statusLabel = {
    ok: 'Configured',
    warn: 'Not configured',
    error: 'Error',
  }[status];

  const statusColor = {
    ok: 'text-green-400',
    warn: 'text-amber-400',
    error: 'text-red-400',
  }[status];

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className={`mt-1 inline-block w-2 h-2 rounded-full shrink-0 ${dot}`} />
          <div>
            <p className="text-sm font-medium text-white">{label}</p>
            <p className="text-xs text-gray-400 mt-0.5">{description}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className={`text-xs font-medium ${statusColor}`}>{statusLabel}</span>
          {status !== 'ok' && helpContent && (
            <button
              onClick={() => setShowHelp(v => !v)}
              className="text-xs text-indigo-400 hover:text-indigo-300 border border-indigo-500/40 rounded px-2 py-0.5 transition-colors"
            >
              {showHelp ? 'Hide steps' : 'Setup guide'}
            </button>
          )}
        </div>
      </div>
      {showHelp && helpContent}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

function SettingsPage() {
  const queryClient = useQueryClient();
  const { githubEnabled, githubTokenConfigured, anthropicEnabled } = useAuth();
  const [autoRegen, setAutoRegen] = useState(false);
  const [schedule, setSchedule] = useState('daily');
  const [experimentalShell, setExperimentalShell] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
  });

  useEffect(() => {
    if (settings) {
      setAutoRegen(settings.vibectlMdAutoRegen);
      setSchedule(settings.vibectlMdSchedule || 'daily');
      setExperimentalShell(settings.experimentalShell ?? false);
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: (data: Partial<AppSettings>) => updateSettings(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      showToast('Settings saved');
    },
  });

  const handleSave = () => {
    saveMutation.mutate({
      vibectlMdAutoRegen: autoRegen,
      vibectlMdSchedule: autoRegen ? schedule : '',
      experimentalShell,
    });
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-950 p-6">
        <div className="h-48 animate-pulse rounded-lg bg-gray-800" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 p-6 text-gray-100">
      {toast && (
        <div className="fixed right-6 top-6 z-50 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white shadow-lg">
          {toast}
        </div>
      )}

      <div className="max-w-2xl">
        <h1 className="mb-2 text-2xl font-bold text-white">Settings</h1>
        <p className="mb-6 text-gray-400 text-sm">Application-wide configuration for VibeCtl.</p>

        {/* System Health */}
        <div className="rounded-lg border border-gray-700 bg-gray-800 p-6 mb-6">
          <h2 className="mb-1 text-base font-semibold text-white">System Health</h2>
          <p className="mb-4 text-xs text-gray-500">Status of external integrations and required services.</p>
          <div className="space-y-3">
            <DepCard
              label="MongoDB"
              status="ok"
              description={`Database connection — required for all VibeCtl functionality.${
                settings?.dbName ? ` DB: ${settings.dbName}` : ''
              }${settings?.dbUser ? ` · User: ${settings.dbUser}` : ''}`}
            />
            <DepCard
              label="Anthropic API Key"
              status={anthropicEnabled ? 'ok' : 'warn'}
              description="Enables AI triage, issue summaries, PM review, architecture analysis, and VIBECTL.md auto-regeneration."
              helpContent={<AnthropicHelpDrawer />}
            />
          </div>
        </div>

        {/* GitHub */}
        <div className="rounded-lg border border-gray-700 bg-gray-800 p-6 mb-6">
          <h2 className="mb-1 text-base font-semibold text-white">GitHub</h2>
          <p className="mb-4 text-xs text-gray-500">Two separate GitHub integrations — configure each independently.</p>
          <div className="space-y-3">
            <DepCard
              label="GitHub OAuth — user login"
              status={githubEnabled ? 'ok' : 'warn'}
              description={githubEnabled
                ? 'Team members can sign in with their GitHub account. Their OAuth token is automatically used for clone/pull/push.'
                : 'Not configured. Without this, only admin password login is available. Users must manually add a PAT for git operations.'}
              helpContent={<GitHubOAuthHelpDrawer />}
            />
            <DepCard
              label="GitHub API Token — CI status"
              status={githubTokenConfigured ? 'ok' : 'warn'}
              description={githubTokenConfigured
                ? 'Server-level read token is configured. The CI tab shows commit history and check run status for linked repos.'
                : 'Not configured. The CI tab cannot fetch commit history or check run status. Without a token, the GitHub API rate limit is 60 req/hour for the whole server.'}
              helpContent={<GitHubTokenHelpDrawer />}
            />
          </div>
        </div>

        {/* Integrations (Adapters) */}
        <div className="mb-6">
          <AdaptersSection />
        </div>

        {/* Delegation */}
        <div className="mb-6">
          <DelegationSection />
        </div>

        {/* VIBECTL.md Auto-Regen */}
        <div className="rounded-lg border border-gray-700 bg-gray-800 p-6 mb-6">
          <h2 className="mb-4 text-base font-semibold text-white">VIBECTL.md Auto-Regeneration</h2>

          {!anthropicEnabled && (
            <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
              <p className="text-amber-300 text-xs">
                An Anthropic API key is required for auto-regeneration. Configure it above.
              </p>
            </div>
          )}

          <div className="flex items-center gap-3 mb-4">
            <button
              onClick={() => setAutoRegen(!autoRegen)}
              disabled={!anthropicEnabled}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                autoRegen ? 'bg-indigo-600' : 'bg-gray-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  autoRegen ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
            <span className="text-sm text-gray-300">
              {autoRegen ? 'Enabled' : 'Disabled'} — automatically regenerate VIBECTL.md for all projects
            </span>
          </div>

          {autoRegen && (
            <div className="mt-4">
              <label className="mb-2 block text-sm font-medium text-gray-300">Schedule</label>
              <select
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                className="rounded border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-200 outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
              <p className="mt-1 text-xs text-gray-500">
                VIBECTL.md will be regenerated for all non-archived projects on this schedule.
              </p>
            </div>
          )}
        </div>

        {/* Experimental Features */}
        <div className="rounded-lg border border-gray-700 bg-gray-800 p-6 mb-6">
          <div className="flex items-start gap-3 mb-4">
            <div>
              <h2 className="text-base font-semibold text-white">Experimental Features</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Features in development. Off by default — super admins can always access them regardless of this setting.
              </p>
            </div>
            <span className="ml-auto shrink-0 inline-flex items-center rounded px-2 py-0.5 text-[10px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30">
              experimental
            </span>
          </div>
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4 rounded-lg border border-gray-700 bg-gray-800/50 p-4">
              <div>
                <p className="text-sm font-medium text-white">Shell</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  Interactive per-user shell tab on project cards. When off, the Shell tab is hidden for non-admin users and direct WebSocket connections are rejected.
                </p>
              </div>
              <button
                onClick={() => setExperimentalShell(v => !v)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                  experimentalShell ? 'bg-indigo-600' : 'bg-gray-600'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    experimentalShell ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </div>
        </div>

        <button
          onClick={handleSave}
          disabled={saveMutation.isPending}
          className="rounded bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {saveMutation.isPending ? 'Saving...' : 'Save Settings'}
        </button>

        {settings?.updatedAt && (
          <p className="mt-3 text-xs text-gray-600">
            Last updated: {new Date(settings.updatedAt).toLocaleString()}
          </p>
        )}
      </div>
    </div>
  );
}

export default SettingsPage;
