import { useState, useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createProject, checkDir, ensureDir, detectGitRemote, detectProjectScripts, suggestClonePath, suggestNewPath } from '../../api/client';
import type { DetectedScripts } from '../../api/client';

interface ProjectFormProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

type Step = 'basics' | 'repo';
type RepoMode = 'clone' | 'local' | 'new';

function ProjectForm({ open, onClose, onCreated }: ProjectFormProps) {
  const queryClient = useQueryClient();

  // Step 1
  const [step, setStep] = useState<Step>('basics');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [step1Error, setStep1Error] = useState('');

  // Step 2 — mode selection
  const [repoMode, setRepoMode] = useState<RepoMode>('clone');

  // Clone mode
  const [githubUrl, setGithubUrl] = useState('');
  const [suggestedPath, setSuggestedPath] = useState('');
  const [suggestLoading, setSuggestLoading] = useState(false);

  // Local path mode
  const [localPath, setLocalPath] = useState('');
  const [detectedRemote, setDetectedRemote] = useState('');
  const [localGithubUrl, setLocalGithubUrl] = useState('');
  const [dirExists, setDirExists] = useState<boolean | null>(null);
  const [detectLoading, setDetectLoading] = useState(false);
  const [detectedScripts, setDetectedScripts] = useState<DetectedScripts | null>(null);

  // New project dir mode
  const [newPath, setNewPath] = useState('');
  const [newPathLoading, setNewPathLoading] = useState(false);

  const [step2Error, setStep2Error] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const suggestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-suggest clone path when GitHub URL changes
  useEffect(() => {
    if (suggestTimer.current) clearTimeout(suggestTimer.current);
    if (!githubUrl.trim()) { setSuggestedPath(''); return; }
    suggestTimer.current = setTimeout(async () => {
      setSuggestLoading(true);
      try {
        const { path } = await suggestClonePath(githubUrl.trim());
        setSuggestedPath(path);
      } catch {
        setSuggestedPath('');
      } finally {
        setSuggestLoading(false);
      }
    }, 400);
  }, [githubUrl]);

  // Auto-detect dir exists + git remote + project scripts when local path changes
  useEffect(() => {
    if (detectTimer.current) clearTimeout(detectTimer.current);
    setDirExists(null);
    setDetectedRemote('');
    setLocalGithubUrl('');
    setDetectedScripts(null);
    if (!localPath.trim()) return;
    detectTimer.current = setTimeout(async () => {
      setDetectLoading(true);
      try {
        const [dirResult, remoteResult] = await Promise.all([
          checkDir(localPath.trim()),
          detectGitRemote(localPath.trim()),
        ]);
        setDirExists(dirResult.exists);
        if (remoteResult.remoteUrl) {
          setDetectedRemote(remoteResult.remoteUrl);
          setLocalGithubUrl(remoteResult.remoteUrl);
        }
        // Run script detection only if dir exists
        if (dirResult.exists) {
          const scripts = await detectProjectScripts(localPath.trim());
          setDetectedScripts(scripts);
        }
      } catch {
        setDirExists(false);
      } finally {
        setDetectLoading(false);
      }
    }, 400);
  }, [localPath]);

  // Auto-fetch new project path when entering 'new' mode
  useEffect(() => {
    if (repoMode !== 'new' || !code) { setNewPath(''); return; }
    setNewPathLoading(true);
    suggestNewPath(code)
      .then(({ path }) => setNewPath(path))
      .catch(() => setNewPath(''))
      .finally(() => setNewPathLoading(false));
  }, [repoMode, code]);

  const mutation = useMutation({
    mutationFn: createProject,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['globalDashboard'] });
      onCreated();
      onClose();
    },
    onError: (err: Error) => {
      setStep2Error(err.message);
      setSubmitting(false);
    },
  });

  function reset() {
    setStep('basics');
    setName(''); setCode(''); setDescription('');
    setRepoMode('clone');
    setGithubUrl(''); setSuggestedPath('');
    setLocalPath(''); setDetectedRemote(''); setLocalGithubUrl(''); setDirExists(null); setDetectedScripts(null);
    setNewPath('');
    setStep1Error(''); setStep2Error('');
    setSubmitting(false);
  }

  function handleClose() { reset(); onClose(); }

  function handleStep1Next(e: React.FormEvent) {
    e.preventDefault();
    setStep1Error('');
    if (!name.trim()) { setStep1Error('Name is required.'); return; }
    if (!/^[A-Z]{3,5}$/.test(code)) { setStep1Error('Code must be 3–5 uppercase letters.'); return; }
    setStep('repo');
  }

  async function handleCreate() {
    setStep2Error('');
    setSubmitting(true);

    const links: { localPath?: string; githubUrl?: string } = {};

    if (repoMode === 'clone') {
      if (!githubUrl.trim()) { setStep2Error('GitHub URL is required.'); setSubmitting(false); return; }
      links.githubUrl = githubUrl.trim();
    } else if (repoMode === 'local') {
      if (!localPath.trim()) { setStep2Error('Local path is required.'); setSubmitting(false); return; }
      if (dirExists === false) {
        try { await ensureDir(localPath.trim()); } catch (err) {
          setStep2Error(`Could not create directory: ${err}`);
          setSubmitting(false);
          return;
        }
      }
      links.localPath = localPath.trim();
      if (localGithubUrl.trim()) links.githubUrl = localGithubUrl.trim();
    } else if (repoMode === 'new') {
      if (!newPath) { setStep2Error('Could not determine project directory.'); setSubmitting(false); return; }
      try { await ensureDir(newPath); } catch (err) {
        setStep2Error(`Could not create directory: ${err}`);
        setSubmitting(false);
        return;
      }
      links.localPath = newPath;
    }

    // Build deployment config from detected scripts (local mode only)
    let deployment: import('../../types').DeploymentConfig | undefined;
    if (repoMode === 'local' && detectedScripts) {
      const d: import('../../types').DeploymentConfig = {};
      if (detectedScripts.deployProd)  d.deployProd  = detectedScripts.deployProd;
      if (detectedScripts.startDev)    d.startDev    = detectedScripts.startDev;
      if (detectedScripts.startProd)   d.startProd   = detectedScripts.startProd;
      if (detectedScripts.restartProd) d.restartProd = detectedScripts.restartProd;
      if (detectedScripts.viewLogs)    d.viewLogs    = detectedScripts.viewLogs;
      if (Object.keys(d).length > 0) deployment = d;
    }

    mutation.mutate({ name: name.trim(), code, description: description.trim(), links, goals: [], deployment });
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-lg rounded-xl bg-gray-800 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold text-white">New Project</h2>
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className={step === 'basics' ? 'text-indigo-400 font-medium' : ''}>1. Basics</span>
              <span>→</span>
              <span className={step === 'repo' ? 'text-indigo-400 font-medium' : ''}>2. Repository</span>
            </div>
          </div>
          <button onClick={handleClose} className="text-gray-400 hover:text-white">
            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        </div>

        <div className="p-6">
          {/* ---- STEP 1: Basics ---- */}
          {step === 'basics' && (
            <form onSubmit={handleStep1Next} className="space-y-4">
              <div>
                <label className="block text-sm text-gray-300 mb-1.5">Name *</label>
                <input
                  autoFocus
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2.5 text-gray-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  placeholder="My Project"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1.5">
                  Code * <span className="text-gray-500 text-xs">(3–5 uppercase letters)</span>
                </label>
                <input
                  type="text"
                  value={code}
                  onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5))}
                  className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2.5 font-mono text-gray-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  placeholder="PROJ"
                  maxLength={5}
                />
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1.5">Description</label>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  rows={3}
                  className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2.5 text-gray-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  placeholder="What is this project?"
                />
              </div>
              {step1Error && <p className="text-sm text-red-400">{step1Error}</p>}
              <div className="flex justify-end gap-3 pt-1">
                <button type="button" onClick={handleClose} className="rounded-lg px-4 py-2 text-sm text-gray-400 hover:text-gray-200">Cancel</button>
                <button type="submit" className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-500">
                  Next →
                </button>
              </div>
            </form>
          )}

          {/* ---- STEP 2: Repository ---- */}
          {step === 'repo' && (
            <div className="space-y-5">
              <p className="text-sm text-gray-400">
                How would you like to set up the code for <span className="text-white font-medium">{name}</span>?
              </p>

              {/* Mode cards */}
              <div className="grid grid-cols-3 gap-2">
                {([
                  { mode: 'clone' as RepoMode, icon: '⬇', label: 'Clone from GitHub' },
                  { mode: 'local' as RepoMode, icon: '📁', label: 'Use local path' },
                  { mode: 'new'   as RepoMode, icon: '✦', label: 'New project dir' },
                ]).map(({ mode, icon, label }) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setRepoMode(mode)}
                    className={`rounded-lg border p-3 text-left text-sm transition-colors ${
                      repoMode === mode
                        ? 'border-indigo-500 bg-indigo-600/20 text-white'
                        : 'border-gray-600 bg-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-300'
                    }`}
                  >
                    <div className="text-xl mb-1.5">{icon}</div>
                    <div className="font-medium leading-snug text-xs">{label}</div>
                  </button>
                ))}
              </div>

              {/* Clone mode */}
              {repoMode === 'clone' && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm text-gray-300 mb-1.5">GitHub URL</label>
                    <input
                      autoFocus
                      type="text"
                      value={githubUrl}
                      onChange={e => setGithubUrl(e.target.value)}
                      className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2.5 text-gray-100 font-mono text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      placeholder="https://github.com/owner/repo"
                    />
                  </div>
                  {githubUrl.trim() && (
                    <div className="rounded-lg bg-gray-900 border border-gray-700 px-3 py-2.5 text-xs flex items-center gap-2">
                      <span className="text-gray-500 shrink-0">Server path:</span>
                      {suggestLoading
                        ? <span className="text-gray-500 italic">calculating…</span>
                        : suggestedPath
                          ? <span className="text-green-400 font-mono break-all">{suggestedPath}</span>
                          : <span className="text-gray-500 italic">enter a valid GitHub URL</span>
                      }
                    </div>
                  )}
                  <p className="text-xs text-gray-500">
                    The repo will be cloned to the path above on this server and the clone will start automatically.
                    For private repos, make sure your GitHub PAT is saved in your profile.
                  </p>
                </div>
              )}

              {/* Local path mode */}
              {repoMode === 'local' && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm text-gray-300 mb-1.5">Local directory path</label>
                    <input
                      autoFocus
                      type="text"
                      value={localPath}
                      onChange={e => setLocalPath(e.target.value)}
                      className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2.5 text-gray-100 font-mono text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      placeholder="/Users/you/projects/myproject"
                    />
                    {localPath.trim() && !detectLoading && dirExists !== null && (
                      <p className={`mt-1.5 text-xs ${dirExists ? 'text-green-400' : 'text-amber-400'}`}>
                        {dirExists
                          ? detectedRemote ? 'Directory exists · git remote detected' : 'Directory exists · no git remote found'
                          : 'Directory does not exist — will be created'}
                      </p>
                    )}
                    {detectLoading && <p className="mt-1.5 text-xs text-gray-500">Checking…</p>}
                    {/* Auto-detected scripts summary */}
                    {!detectLoading && detectedScripts && (detectedScripts.deployShFound || detectedScripts.startShFound || detectedScripts.flyTomlFound) && (
                      <div className="mt-2 rounded-lg bg-green-900/20 border border-green-700/40 px-3 py-2 space-y-1">
                        <p className="text-[11px] font-semibold text-green-400">⚡ Auto-configured from project files:</p>
                        {detectedScripts.deployShFound && (
                          <p className="text-[11px] text-green-300/80"><span className="font-mono">deploy.sh</span> → deployProd</p>
                        )}
                        {detectedScripts.startShFound && (
                          <p className="text-[11px] text-green-300/80"><span className="font-mono">start.sh</span> → startDev</p>
                        )}
                        {detectedScripts.flyTomlFound && (
                          <p className="text-[11px] text-green-300/80"><span className="font-mono">fly.toml</span> ({detectedScripts.flyAppName}) → startProd, restartProd, viewLogs{!detectedScripts.deployShFound ? ', deployProd' : ''}</p>
                        )}
                      </div>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm text-gray-300 mb-1.5">
                      GitHub URL
                      {detectedRemote && <span className="ml-2 text-xs text-green-400 font-normal">auto-detected</span>}
                      <span className="ml-1 text-xs text-gray-500 font-normal">(optional)</span>
                    </label>
                    <input
                      type="text"
                      value={localGithubUrl}
                      onChange={e => setLocalGithubUrl(e.target.value)}
                      className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2.5 text-gray-100 font-mono text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      placeholder="https://github.com/owner/repo"
                    />
                    {!localGithubUrl && (
                      <p className="mt-1.5 text-xs text-gray-500">You can add this later in project settings.</p>
                    )}
                  </div>
                </div>
              )}

              {/* New project dir mode */}
              {repoMode === 'new' && (
                <div className="rounded-lg bg-gray-900 border border-gray-700 px-4 py-3 space-y-2">
                  <p className="text-xs text-gray-400">
                    A fresh directory will be created on this server for your project. You can clone or connect a repo later.
                  </p>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-gray-500 shrink-0">Server path:</span>
                    {newPathLoading
                      ? <span className="text-gray-500 italic">calculating…</span>
                      : newPath
                        ? <span className="text-green-400 font-mono break-all">{newPath}</span>
                        : <span className="text-red-400 italic">unavailable</span>
                    }
                  </div>
                </div>
              )}

              {step2Error && <p className="text-sm text-red-400">{step2Error}</p>}

              <div className="flex items-center justify-between pt-1">
                <button type="button" onClick={() => setStep('basics')} className="rounded-lg px-4 py-2 text-sm text-gray-400 hover:text-gray-200">
                  ← Back
                </button>
                <div className="flex gap-3">
                  <button type="button" onClick={handleClose} className="rounded-lg px-4 py-2 text-sm text-gray-400 hover:text-gray-200">
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleCreate}
                    disabled={
                      submitting ||
                      mutation.isPending ||
                      (repoMode === 'clone' && !githubUrl.trim()) ||
                      (repoMode === 'new' && (!newPath || newPathLoading))
                    }
                    className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {submitting || mutation.isPending
                      ? 'Creating…'
                      : repoMode === 'clone' ? 'Create & Clone' : 'Create Project'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ProjectForm;
