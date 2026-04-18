import { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getCIStatus, ciCommit, ciPush, ciDeploy, ciRestartProd, ciStartProd, ciTogglePause, getDeployAllStreamUrl, getRestartDevStreamUrl } from '../../api/client';
import type { CIStatus } from '../../types';

interface CITabProps {
  projectCode: string;
  hasLocalPath: boolean;
  hasGitHubUrl: boolean;
  hasDeployCmd: boolean;
  hasStartDevCmd: boolean;
  hasStartProdCmd: boolean;
  hasRestartProdCmd: boolean;
  paused?: boolean;
  githubUrl?: string;
  isCloned?: boolean;
  cloneStreaming?: boolean;
  cloneLog?: string[];
  hasGitHubPAT?: boolean;
  onClone?: () => void;
  onPull?: () => void;
  onSaveGithubUrl?: (url: string) => Promise<void>;
  onPausedChange?: (paused: boolean) => void;
}

export type CILogEntry = { time: string; source: string; text: string; isError?: boolean }

export default function CITab({ projectCode, hasLocalPath, hasGitHubUrl, hasDeployCmd, hasStartDevCmd, hasStartProdCmd, hasRestartProdCmd, paused, githubUrl, isCloned, cloneStreaming, cloneLog, hasGitHubPAT, onClone, onPull, onSaveGithubUrl, onPausedChange }: CITabProps) {
  const hasProdData = hasDeployCmd || hasStartProdCmd || hasRestartProdCmd;
  const [env, setEnv] = useState<'prod' | 'dev'>(!hasProdData && hasStartDevCmd ? 'dev' : 'prod');
  const [ciLog, setCiLog] = useState<CILogEntry[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  const appendLog = (source: string, text: string, isError?: boolean) => {
    setCiLog(prev => [...prev, { time: new Date().toLocaleTimeString(), source, text, isError }]);
    setTimeout(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, 50);
  };

  const { data: ciStatus, isLoading, refetch } = useQuery<CIStatus>({
    queryKey: ['ciStatus', projectId],
    queryFn: () => getCIStatus(projectId),
    refetchInterval: 60_000,
    enabled: hasGitHubUrl,
  });

  return (
    <div className="space-y-4">
      {/* Prod / Dev subtabs */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-lg p-1 w-fit">
        {(['prod', 'dev'] as const).map(e => (
          <button
            key={e}
            onClick={() => setEnv(e)}
            className={`px-4 py-1 text-xs font-semibold rounded transition-colors ${env === e ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}
          >
            {e === 'prod' ? 'Prod' : 'Dev'}
          </button>
        ))}
      </div>

      {/* GitHub CI status — shown in both tabs */}
      <CIStatusCard
        status={ciStatus}
        isLoading={isLoading && hasGitHubUrl}
        hasGitHubUrl={hasGitHubUrl}
        githubUrl={githubUrl}
        onRefresh={() => refetch()}
        onSaveGithubUrl={onSaveGithubUrl}
      />

      {env === 'prod' && (
        <div className="space-y-6">
          {/* Pause toggle */}
          <PauseToggle projectId={projectCode} paused={!!paused} onPausedChange={onPausedChange} />

          {/* Aggregate deploy */}
          <DeployAllCard projectId={projectCode} hasLocalPath={hasLocalPath} hasGitHubUrl={hasGitHubUrl} hasDeployCmd={hasDeployCmd} />

          {/* Individual prod actions */}
          {(hasDeployCmd || hasStartProdCmd || hasRestartProdCmd) && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {hasDeployCmd && <DeployCard projectId={projectCode} appendLog={appendLog} />}
              {hasStartProdCmd && <StartProdCard projectId={projectCode} appendLog={appendLog} />}
              {hasRestartProdCmd && <RestartProdCard projectId={projectCode} appendLog={appendLog} />}
            </div>
          )}
        </div>
      )}

      {env === 'dev' && (
        <div className="space-y-6">
          {/* Restart Dev — primary action */}
          {hasStartDevCmd && (
            <RestartDevCard projectId={projectCode} appendLog={appendLog} />
          )}
          {!hasStartDevCmd && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <p className="text-xs text-amber-400/80 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2">
                Set a <strong className="text-amber-300">startDev</strong> command in project Settings → Deployment to enable dev restart.
              </p>
            </div>
          )}

          {/* Git dev actions */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {hasGitHubUrl && (
              <CloneCard isCloned={!!isCloned} cloneStreaming={!!cloneStreaming} cloneLog={cloneLog} hasGitHubPAT={hasGitHubPAT} onClone={onClone} onPull={onPull} />
            )}
            <CommitCard projectId={projectCode} hasLocalPath={hasLocalPath} />
            <PushCard projectId={projectCode} hasLocalPath={hasLocalPath} hasGitHubUrl={hasGitHubUrl} />
          </div>
        </div>
      )}

      {/* Shared CI output terminal */}
      {ciLog.length > 0 && (
        <div className="border-t border-gray-800 pt-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Output</span>
            <button onClick={() => setCiLog([])} className="text-[10px] text-gray-600 hover:text-gray-400 transition-colors">Clear</button>
          </div>
          <div ref={logRef} className="bg-gray-950 border border-gray-800 rounded-lg p-2.5 max-h-48 overflow-y-auto space-y-0.5">
            {ciLog.map((entry, i) => (
              <div key={i} className="flex gap-2 text-[10px] font-mono leading-relaxed">
                <span className="text-gray-600 shrink-0">{entry.time}</span>
                <span className="text-indigo-400/70 shrink-0">[{entry.source}]</span>
                <span className={entry.isError ? 'text-red-400' : 'text-gray-300'}>{entry.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PauseToggle({ projectCode, paused, onPausedChange }: { projectCode: string; paused: boolean; onPausedChange?: (paused: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const toggle = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await ciTogglePause(projectCode, !paused);
      onPausedChange?.(res.paused);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-xl px-5 py-3">
      <div>
        <p className="text-sm font-semibold text-white">Project Paused</p>
        <p className="text-xs text-gray-500">Paused projects are excluded from bulk Start/Restart operations.</p>
        {error && <p className="text-red-400 text-xs mt-1">{error}</p>}
      </div>
      <button
        onClick={toggle}
        disabled={busy}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none disabled:opacity-50 ${paused ? 'bg-amber-500' : 'bg-gray-700'}`}
        role="switch"
        aria-checked={paused}
      >
        <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${paused ? 'translate-x-5' : 'translate-x-0'}`} />
      </button>
    </div>
  );
}

function CIStatusCard({ status, isLoading, hasGitHubUrl, githubUrl, onRefresh, onSaveGithubUrl }: {
  status?: CIStatus;
  isLoading: boolean;
  hasGitHubUrl: boolean;
  githubUrl?: string;
  onRefresh: () => void;
  onSaveGithubUrl?: (url: string) => Promise<void>;
}) {
  const [editingUrl, setEditingUrl] = useState(false);
  const [urlInput, setUrlInput] = useState(githubUrl || '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const handleSave = async () => {
    if (!urlInput.trim() || !onSaveGithubUrl) return;
    setSaving(true);
    setSaveError('');
    try {
      await onSaveGithubUrl(urlInput.trim());
      setEditingUrl(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (!hasGitHubUrl) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-white mb-3">GitHub CI Status</h3>
        <p className="text-sm text-gray-500 mb-3">No GitHub repository URL configured.</p>
        {onSaveGithubUrl && (
          <div className="space-y-2">
            <input
              type="text"
              value={urlInput}
              onChange={e => setUrlInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSave()}
              placeholder="https://github.com/owner/repo"
              className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-white text-xs placeholder-gray-600 focus:outline-none focus:border-indigo-500"
            />
            <button
              onClick={handleSave}
              disabled={saving || !urlInput.trim()}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 rounded transition-colors"
            >
              {saving ? 'Saving…' : 'Save GitHub URL'}
            </button>
            {saveError && <p className="text-red-400 text-xs">{saveError}</p>}
          </div>
        )}
      </div>
    );
  }

  if (isLoading) {
    return <div className="h-28 animate-pulse rounded-xl bg-gray-800" />;
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-sm font-semibold text-white shrink-0">GitHub CI Status</h3>
          {!editingUrl && githubUrl && onSaveGithubUrl && (
            <button
              onClick={() => { setUrlInput(githubUrl); setEditingUrl(true); }}
              className="text-[10px] text-gray-600 hover:text-gray-400 truncate font-mono max-w-[200px] transition-colors"
              title="Edit GitHub URL"
            >
              {githubUrl.replace('https://github.com/', '')}
            </button>
          )}
        </div>
        <button
          onClick={onRefresh}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors shrink-0"
        >
          Refresh
        </button>
      </div>

      {editingUrl && (
        <div className="mb-4 space-y-2">
          <input
            type="text"
            value={urlInput}
            onChange={e => setUrlInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') setEditingUrl(false); }}
            autoFocus
            className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-white text-xs placeholder-gray-600 focus:outline-none focus:border-indigo-500"
          />
          <div className="flex gap-2">
            <button onClick={handleSave} disabled={saving || !urlInput.trim()} className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium px-3 py-1 rounded transition-colors">
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => setEditingUrl(false)} className="bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs font-medium px-3 py-1 rounded transition-colors">
              Cancel
            </button>
          </div>
          {saveError && <p className="text-red-400 text-xs">{saveError}</p>}
        </div>
      )}

      {status?.githubError && (
        <p className="text-sm text-yellow-400 mb-3">{status.githubError}</p>
      )}

      {status?.lastCommit ? (
        <div className="space-y-3">
          <div className="flex items-start gap-3">
            <span className="font-mono text-xs text-indigo-400 bg-indigo-900/30 px-1.5 py-0.5 rounded shrink-0">
              {status.lastCommit.sha}
            </span>
            <div className="min-w-0">
              <p className="text-sm text-white truncate">{status.lastCommit.message}</p>
              <p className="text-xs text-gray-500">{status.lastCommit.author} · {new Date(status.lastCommit.date).toLocaleString()}</p>
            </div>
          </div>
          {status.checkRuns && status.checkRuns.length > 0 && (
            <div className="border-t border-gray-800 pt-3 space-y-1.5">
              {status.checkRuns.map((run, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <CheckRunDot conclusion={run.conclusion} status={run.status} />
                  <span className="text-gray-300">{run.name}</span>
                  <span className="text-gray-600">{run.conclusion || run.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-gray-500">
          {!status ? 'Loading…' : 'No GitHub URL configured or no commits found.'}
        </p>
      )}
    </div>
  );
}

function CheckRunDot({ conclusion, status }: { conclusion: string; status: string }) {
  if (conclusion === 'success') return <span className="w-2 h-2 rounded-full bg-green-400 shrink-0" />;
  if (conclusion === 'failure') return <span className="w-2 h-2 rounded-full bg-red-400 shrink-0" />;
  if (status === 'in_progress') return <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />;
  return <span className="w-2 h-2 rounded-full bg-gray-500 shrink-0" />;
}

function CloneCard({ isCloned, cloneStreaming, cloneLog, hasGitHubPAT, onClone, onPull }: { isCloned: boolean; cloneStreaming: boolean; cloneLog?: string[]; hasGitHubPAT?: boolean; onClone?: () => void; onPull?: () => void }) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [cloneLog]);

  return (
    <ActionCard
      title={isCloned ? 'Pull' : 'Clone'}
      description={isCloned ? 'Pull latest changes from GitHub' : 'Clone the repository locally'}
      icon={
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
        </svg>
      }
    >
      <div className="space-y-2 mt-3">
        {!hasGitHubPAT && !isCloned ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 space-y-2">
            <p className="text-xs text-amber-300 font-medium">GitHub PAT required</p>
            <p className="text-xs text-amber-200/70">Set a Personal Access Token with <code className="bg-black/30 px-1 rounded">repo</code> scope in your Profile before cloning.</p>
            <a
              href="/profile"
              className="block w-full text-center bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-300 text-xs font-medium py-1.5 rounded transition-colors"
            >
              Go to Profile →
            </a>
          </div>
        ) : cloneStreaming ? (
          <div className="flex items-center gap-2 text-xs text-indigo-300">
            <div className="w-3 h-3 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            {isCloned ? 'Pulling…' : 'Cloning…'}
          </div>
        ) : isCloned ? (
          <button
            onClick={onPull}
            className="w-full bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium py-1.5 rounded transition-colors"
          >
            Pull
          </button>
        ) : (
          <button
            onClick={onClone}
            className="w-full bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium py-1.5 rounded transition-colors"
          >
            Clone repository
          </button>
        )}
        {cloneLog && cloneLog.length > 0 && (
          <div ref={logRef} className="font-mono text-[10px] bg-black rounded p-2 max-h-32 overflow-y-auto whitespace-pre-wrap">
            {cloneLog.map((line, i) => (
              <div key={i} className={line.startsWith('ERROR:') ? 'text-red-400' : 'text-green-300'}>{line}</div>
            ))}
          </div>
        )}
      </div>
    </ActionCard>
  );
}

function CommitCard({ projectCode, hasLocalPath }: { projectCode: string; hasLocalPath: boolean }) {
  const [message, setMessage] = useState('');
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setError(''); setOutput(''); setBusy(true);
    try {
      const res = await ciCommit(projectCode, message.trim());
      setOutput(res.output || res.status);
      setMessage('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ActionCard
      title="Commit"
      description="Stage all changes and commit"
      icon={
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.042 21.672 13.684 16.6m0 0-2.51 2.225.569-9.47 5.227 7.917-3.286-.672ZM12 2.25V4.5m5.834.166-1.591 1.591M20.25 10.5H18M7.757 14.743l-1.59 1.59M6 10.5H3.75m4.007-4.243-1.59-1.59" />
        </svg>
      }
      disabled={!hasLocalPath}
      disabledMsg="No local path configured"
    >
      <div className="space-y-2 mt-3">
        <input
          type="text"
          value={message}
          onChange={e => setMessage(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && run()}
          placeholder="Commit message (optional)"
          disabled={busy}
          className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-white text-xs placeholder-gray-600 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
        />
        <button
          onClick={run}
          disabled={busy}
          className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium py-1.5 rounded transition-colors"
        >
          {busy ? 'Committing…' : 'Commit'}
        </button>
        {output && <OutputBox text={output} />}
        {error && <p className="text-red-400 text-xs">{error}</p>}
      </div>
    </ActionCard>
  );
}

function PushCard({ projectCode, hasLocalPath, hasGitHubUrl }: { projectCode: string; hasLocalPath: boolean; hasGitHubUrl: boolean }) {
  const [output, setOutput] = useState('');
  const [warning, setWarning] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setError(''); setOutput(''); setWarning(''); setBusy(true);
    try {
      const res = await ciPush(projectId);
      setOutput(res.output || res.status);
      if (res.githubWarning) setWarning(res.githubWarning);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ActionCard
      title="Push"
      description="Push commits to GitHub"
      icon={
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
        </svg>
      }
      disabled={!hasLocalPath || !hasGitHubUrl}
      disabledMsg={!hasGitHubUrl ? "No GitHub URL configured" : "No local path configured"}
    >
      <div className="space-y-2 mt-3">
        {warning && <p className="text-xs text-amber-400 bg-amber-900/20 border border-amber-800/50 rounded p-2">{warning}</p>}
        <button
          onClick={run}
          disabled={busy}
          className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium py-1.5 rounded transition-colors"
        >
          {busy ? 'Pushing…' : 'Push'}
        </button>
        {output && <OutputBox text={output} />}
        {error && <p className="text-red-400 text-xs">{error}</p>}
      </div>
    </ActionCard>
  );
}

function DeployCard({ projectCode, appendLog }: { projectCode: string; appendLog: (source: string, text: string, isError?: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const run = async () => {
    setConfirming(false);
    setBusy(true);
    appendLog('Deploy', 'Deploying to production...');
    try {
      const res = await ciDeploy(projectId);
      appendLog('Deploy', res.output || res.status || 'Done');
    } catch (e) {
      appendLog('Deploy', e instanceof Error ? e.message : 'Failed', true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ActionCard
      title="Deploy"
      description="Run the deployProd command"
      icon={
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.59 14.37a6 6 0 0 1-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 0 0 6.16-12.12A14.98 14.98 0 0 0 9.631 8.41m5.96 5.96a14.926 14.926 0 0 1-5.841 2.58m-.119-8.54a6 6 0 0 0-7.381 5.84h4.8m2.581-5.84a14.927 14.927 0 0 0-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 0 1-2.448-2.448 14.9 14.9 0 0 1 .06-.312m-2.24 2.39a4.493 4.493 0 0 0-1.757 4.306 4.493 4.493 0 0 0 4.306-1.758M16.5 9a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z" />
        </svg>
      }
    >
      <div className="mt-3">
        {confirming ? (
          <div className="space-y-2">
            <p className="text-xs text-amber-400">Deploy to production?</p>
            <div className="flex gap-2">
              <button onClick={run} className="flex-1 bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium py-1.5 rounded transition-colors">Yes, deploy</button>
              <button onClick={() => setConfirming(false)} className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-medium py-1.5 rounded transition-colors border border-gray-700">Cancel</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setConfirming(true)} disabled={busy}
            className="w-full bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-medium py-1.5 rounded transition-colors">
            {busy ? 'Deploying…' : 'Deploy to prod'}
          </button>
        )}
      </div>
    </ActionCard>
  );
}

function RestartDevCard({ projectCode, appendLog }: { projectCode: string; appendLog: (source: string, text: string, isError?: boolean) => void }) {
  const [streaming, setStreaming] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const run = () => {
    setError(''); setDone(false); setStreaming(true);
    appendLog('Restart Dev', 'Starting dev server...');
    const es = new EventSource(getRestartDevStreamUrl(projectId));
    es.onmessage = (e) => {
      const line = e.data as string;
      if (line === 'DONE') {
        es.close(); setStreaming(false); setDone(true);
        appendLog('Restart Dev', 'Done');
      } else if (line.startsWith('ERROR:')) {
        const msg = line.slice(6).trim();
        setError(msg); es.close(); setStreaming(false); setDone(true);
        appendLog('Restart Dev', msg, true);
      } else {
        appendLog('Restart Dev', line);
      }
    };
    es.onerror = () => { es.close(); setStreaming(false); setError('Connection lost'); appendLog('Restart Dev', 'Connection lost', true); };
  };

  return (
    <ActionCard
      title="Restart Dev"
      description="Run the startDev command"
      icon={
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
        </svg>
      }
    >
      <div className="mt-3 space-y-2">
        <button onClick={run} disabled={streaming}
          className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium py-1.5 rounded transition-colors">
          {streaming ? (
            <span className="flex items-center justify-center gap-2">
              <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Running…
            </span>
          ) : done ? 'Restart Dev Again' : 'Restart Dev'}
        </button>
        {error && <p className="text-red-400 text-xs">{error}</p>}
        {done && !error && <p className="text-xs text-green-400">✓ Done — see output below</p>}
      </div>
    </ActionCard>
  );
}

function RestartProdCard({ projectCode, appendLog }: { projectCode: string; appendLog: (source: string, text: string, isError?: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const run = async () => {
    setConfirming(false);
    setBusy(true);
    appendLog('Restart Prod', 'Restarting production...');
    try {
      const res = await ciRestartProd(projectId);
      appendLog('Restart Prod', res.output || res.status || 'Done');
    } catch (e) {
      appendLog('Restart Prod', e instanceof Error ? e.message : 'Failed', true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ActionCard
      title="Restart Prod"
      description="Run the restartProd command"
      icon={
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
        </svg>
      }
    >
      <div className="mt-3">
        {confirming ? (
          <div className="space-y-2">
            <p className="text-xs text-amber-400">Restart production?</p>
            <div className="flex gap-2">
              <button onClick={run} className="flex-1 bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium py-1.5 rounded transition-colors">Yes, restart</button>
              <button onClick={() => setConfirming(false)} className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-medium py-1.5 rounded border border-gray-700 transition-colors">Cancel</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setConfirming(true)} disabled={busy}
            className="w-full bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-medium py-1.5 rounded transition-colors">
            {busy ? 'Restarting…' : 'Restart Prod'}
          </button>
        )}
      </div>
    </ActionCard>
  );
}

function StartProdCard({ projectCode, appendLog }: { projectCode: string; appendLog: (source: string, text: string, isError?: boolean) => void }) {
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    appendLog('Start Prod', 'Starting production...');
    try {
      const res = await ciStartProd(projectId);
      appendLog('Start Prod', res.output || res.status || 'Done');
    } catch (e) {
      appendLog('Start Prod', e instanceof Error ? e.message : 'Failed', true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ActionCard
      title="Start Prod"
      description="Run the startProd command"
      icon={
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />
        </svg>
      }
    >
      <div className="mt-3">
        <button onClick={run} disabled={busy}
          className="w-full bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-xs font-medium py-1.5 rounded transition-colors">
          {busy ? 'Starting…' : 'Start Prod'}
        </button>
      </div>
    </ActionCard>
  );
}

type DeployStep = { name: string; lines: string[]; status: 'running' | 'done' | 'error' };

function DeployAllCard({ projectCode, hasLocalPath, hasDeployCmd }: { projectCode: string; hasLocalPath: boolean; hasGitHubUrl: boolean; hasDeployCmd: boolean }) {
  const [commitMsg, setCommitMsg] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [steps, setSteps] = useState<DeployStep[]>([]);
  const [done, setDone] = useState(false);
  const [globalError, setGlobalError] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [steps]);

  const STEP_LABELS: Record<string, string> = { commit: 'Commit', push: 'Push', deploy: 'Deploy' };

  const start = () => {
    setConfirming(false);
    setSteps([]);
    setDone(false);
    setGlobalError('');
    setStreaming(true);

    const url = getDeployAllStreamUrl(projectCode, commitMsg.trim() || undefined);
    const es = new EventSource(url);
    esRef.current = es;

    es.onmessage = (e) => {
      const line = e.data as string;
      if (line === 'DONE') {
        es.close();
        setStreaming(false);
        setDone(true);
      } else if (line.startsWith('STEP:')) {
        const name = line.slice(5);
        setSteps(prev => [...prev, { name, lines: [], status: 'running' }]);
      } else if (line.startsWith('STEP_DONE:')) {
        const name = line.slice(10);
        setSteps(prev => prev.map(s => s.name === name ? { ...s, status: 'done' } : s));
      } else if (line.startsWith('STEP_ERROR:')) {
        const name = line.slice(11);
        setSteps(prev => prev.map(s => s.name === name ? { ...s, status: 'error' } : s));
      } else if (line.startsWith('ERROR:')) {
        setGlobalError(line.slice(6).trim());
      } else {
        // Output line — append to current (last) step, or to a generic bucket
        setSteps(prev => {
          if (prev.length === 0) return prev;
          const updated = [...prev];
          updated[updated.length - 1] = { ...updated[updated.length - 1], lines: [...updated[updated.length - 1].lines, line] };
          return updated;
        });
      }
    };
    es.onerror = () => {
      es.close();
      setStreaming(false);
      setGlobalError('Connection lost — check server logs');
    };
  };

  const reset = () => { setSteps([]); setDone(false); setGlobalError(''); setCommitMsg(''); };

  return (
    <div className="bg-gray-900 border border-indigo-500/30 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-indigo-400">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
          </svg>
        </span>
        <h4 className="text-sm font-semibold text-white">Deploy to Production</h4>
        {(done || globalError) && !streaming && (
          <button onClick={reset} className="ml-auto text-[10px] text-gray-500 hover:text-gray-300">Reset</button>
        )}
      </div>
      <p className="text-xs text-gray-500 mb-3">Commit uncommitted changes, push to GitHub, then deploy.</p>

      {!hasDeployCmd ? (
        <p className="text-xs text-amber-400/80 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2">
          Set a <strong className="text-amber-300">deployProd</strong> command in project Settings → Deployment to enable this.
        </p>
      ) : streaming || steps.length > 0 || done || globalError ? (
        <div ref={logRef} className="space-y-2 max-h-96 overflow-y-auto">
          {steps.map((step) => (
            <div key={step.name}>
              <div className="flex items-center gap-2 mb-1">
                {step.status === 'running' && <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse shrink-0" />}
                {step.status === 'done' && <span className="w-2 h-2 rounded-full bg-green-400 shrink-0" />}
                {step.status === 'error' && <span className="w-2 h-2 rounded-full bg-red-400 shrink-0" />}
                <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                  {STEP_LABELS[step.name] ?? step.name}
                </span>
                {step.status === 'done' && <span className="text-[10px] text-green-400">✓</span>}
                {step.status === 'error' && <span className="text-[10px] text-red-400">✗</span>}
              </div>
              {step.lines.length > 0 && (
                <pre className="text-[10px] text-gray-300 bg-gray-950 border border-gray-800 rounded p-2 overflow-x-auto max-h-48 whitespace-pre-wrap break-all">
                  {step.lines.join('\n')}
                </pre>
              )}
            </div>
          ))}
          {globalError && (
            <p className="text-xs text-red-400 bg-red-900/20 border border-red-800/40 rounded px-3 py-2">{globalError}</p>
          )}
          {done && !globalError && (
            <p className="text-xs text-green-400 font-medium">✓ Deployment complete</p>
          )}
          {streaming && steps.length === 0 && (
            <div className="flex items-center gap-2 text-xs text-indigo-300">
              <div className="w-3 h-3 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
              Starting…
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <input
            type="text"
            value={commitMsg}
            onChange={e => setCommitMsg(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !confirming && setConfirming(true)}
            placeholder="Commit message (optional — skips commit if blank)"
            className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-white text-xs placeholder-gray-600 focus:outline-none focus:border-indigo-500"
          />
          {confirming ? (
            <div className="space-y-2">
              <p className="text-xs text-amber-400">Deploy to production?{commitMsg ? ` Commit: "${commitMsg}"` : ' (no commit)'}</p>
              <div className="flex gap-2">
                <button onClick={start} className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium py-1.5 rounded transition-colors">Yes, deploy</button>
                <button onClick={() => setConfirming(false)} className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-medium py-1.5 rounded border border-gray-700 transition-colors">Cancel</button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              disabled={!hasLocalPath}
              className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium py-2 rounded transition-colors"
            >
              Deploy to Production →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ActionCard({ title, description, icon, disabled, disabledMsg, children }: {
  title: string;
  description: string;
  icon: React.ReactNode;
  disabled?: boolean;
  disabledMsg?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`bg-gray-900 border rounded-xl p-4 ${disabled ? 'border-gray-800 opacity-60' : 'border-gray-800'}`}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-indigo-400">{icon}</span>
        <h4 className="text-sm font-semibold text-white">{title}</h4>
      </div>
      <p className="text-xs text-gray-500 mb-1">{description}</p>
      {disabled && disabledMsg ? (
        <p className="text-xs text-amber-500 mt-2">{disabledMsg}</p>
      ) : children}
    </div>
  );
}

function OutputBox({ text }: { text: string }) {
  return (
    <pre className="text-[10px] text-gray-300 bg-gray-950 border border-gray-800 rounded p-2 overflow-x-auto max-h-32 whitespace-pre-wrap break-all">
      {text}
    </pre>
  );
}
