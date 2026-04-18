import { useState, useEffect, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getProjectByCode, listProjectFeedback, runHealthCheck, removeClone, getCloneSSEUrl, getPullSSEUrl } from '../api/client';
import type { FeedbackItem } from '../types';
import IssueTable from '../components/issues/IssueTable';
import ProjectSettings from '../components/projects/ProjectSettings';
import ChatView from '../components/chat/ChatView';
import HealthChecksTab from '../components/projects/HealthChecksTab';
import VibectlMdTab from '../components/projects/VibectlMdTab';
import CITab from '../components/projects/CITab';
import MembersPanel from '../components/projects/MembersPanel';

type Tab = 'issues' | 'terminal' | 'feedback' | 'health' | 'docs' | 'ci' | 'members' | 'settings';

function ProjectPage() {
  const { code } = useParams<{ code: string }>();
  const [searchParams] = useSearchParams();
  const autoClone = searchParams.get('clone') === '1';
  const [activeTab, setActiveTab] = useState<Tab>(autoClone ? 'terminal' : 'issues');

  const {
    data: project,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['project', code],
    queryFn: () => getProjectByCode(code!),
    enabled: !!code,
  });

  const monitorEnv = project?.healthCheck?.monitorEnv;
  const { data: healthResults } = useQuery({
    queryKey: ['healthcheck', project?.id],
    queryFn: () => runHealthCheck(project!.id),
    enabled: !!project && !!monitorEnv,
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-950 p-6">
        <div className="mb-6 h-10 w-64 animate-pulse rounded bg-gray-800" />
        <div className="h-48 animate-pulse rounded-lg bg-gray-800" />
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="min-h-screen bg-gray-950 p-6">
        <div className="rounded bg-red-900/30 p-4 text-red-400">
          {error ? `Failed to load project: ${(error as Error).message}` : 'Project not found.'}
        </div>
      </div>
    );
  }

  // Compute worst-case health status color for the tab indicator
  const healthStatusColor = (() => {
    if (!monitorEnv || !healthResults || healthResults.length === 0) return undefined;
    if (healthResults.some((r) => r.status === 'down')) return 'bg-red-400';
    if (healthResults.some((r) => r.status !== 'up')) return 'bg-yellow-400';
    return 'bg-green-400';
  })();

  const tabs: { key: Tab; label: string; statusDot?: string }[] = [
    { key: 'issues', label: 'Issues' },
    { key: 'terminal', label: 'Terminal' },
    { key: 'feedback', label: 'Feedback' },
    { key: 'health', label: 'Health', statusDot: healthStatusColor },
    { key: 'docs', label: 'Docs' },
    { key: 'ci', label: 'CI' },
    { key: 'members', label: 'Members' },
    { key: 'settings', label: 'Settings' },
  ];

  const handleCopyPath = () => {
    if (project.links.localPath) {
      navigator.clipboard.writeText(project.links.localPath);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 p-6">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-white">{project.name}</h1>
          <span className="rounded bg-indigo-600 px-2.5 py-0.5 text-sm font-mono text-white">
            {project.code}
          </span>
          {(() => {
            const frontendUrl = monitorEnv === 'dev'
              ? project.healthCheck?.frontend.devUrl
              : monitorEnv === 'prod'
                ? project.healthCheck?.frontend.prodUrl
                : (project.healthCheck?.frontend.devUrl || project.healthCheck?.frontend.prodUrl);
            if (!frontendUrl) return null;
            return (
              <a
                href={frontendUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-full bg-indigo-600 px-2.5 py-0.5 text-xs font-medium text-white hover:bg-indigo-500 transition-colors"
                title={`Open ${frontendUrl}`}
              >
                Go
                <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </a>
            );
          })()}
          {monitorEnv && healthResults && healthResults.length > 0 && (() => {
            const allUp = healthResults.every((r) => r.status === 'up');
            const allDown = healthResults.every((r) => r.status === 'down');
            return (
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                  allUp
                    ? 'bg-green-600/20 text-green-400'
                    : allDown
                      ? 'bg-red-600/20 text-red-400'
                      : 'bg-yellow-600/20 text-yellow-400'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    allUp ? 'bg-green-400' : allDown ? 'bg-red-400' : 'bg-yellow-400'
                  }`}
                />
                {allUp ? 'Running' : allDown ? 'Stopped' : 'Degraded'}
              </span>
            );
          })()}
        </div>
        {project.description && (
          <p className="mt-2 text-gray-400">{project.description}</p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
          {project.links.localPath && (
            <button
              onClick={handleCopyPath}
              className="flex items-center gap-1.5 text-gray-400 hover:text-white"
              title="Copy local path"
            >
              <span className="font-mono text-xs">{project.links.localPath}</span>
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
            </button>
          )}
          {project.links.githubUrl && (
            <a
              href={project.links.githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-400 hover:text-indigo-300"
            >
              GitHub
              <svg
                className="ml-1 inline h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                />
              </svg>
            </a>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-6 border-b border-gray-700">
        <nav className="-mb-px flex gap-6">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`border-b-2 pb-3 text-sm font-medium transition-colors ${
                activeTab === tab.key
                  ? 'border-indigo-500 text-indigo-400'
                  : 'border-transparent text-gray-400 hover:border-gray-600 hover:text-gray-200'
              }`}
            >
              {tab.label}
              {tab.statusDot && (
                <span className={`ml-1.5 inline-block h-2 w-2 rounded-full ${tab.statusDot}`} />
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      {activeTab === 'issues' && (
        <IssueTable projectId={project.id} projectCode={project.code} />
      )}

      {activeTab === 'terminal' && (
        <TerminalTab project={project} autoClone={autoClone} />
      )}

      {activeTab === 'feedback' && <FeedbackTab projectId={project.id} />}

      {activeTab === 'health' && <HealthChecksTab project={project} />}

      {activeTab === 'docs' && <VibectlMdTab project={project} />}

      {activeTab === 'ci' && (
        <CITab
          projectId={project.id}
          hasLocalPath={!!project.links.localPath}
          hasGitHubUrl={!!project.links.githubUrl}
          hasDeployCmd={!!project.deployment?.deployProd}
          hasStartDevCmd={!!project.deployment?.startDev}
          hasStartProdCmd={!!project.deployment?.startProd}
          hasRestartProdCmd={!!project.deployment?.restartProd}
          paused={project.paused}
          isCloned={project.cloneStatus === 'cloned' || !!project.links.localPath}
        />
      )}

      {activeTab === 'members' && <MembersPanel projectId={project.id} />}

      {activeTab === 'settings' && <ProjectSettings project={project} />}
    </div>
  );
}

function FeedbackTab({ projectId }: { projectCode: string }) {
  const { data: feedback, isLoading, error } = useQuery({
    queryKey: ['projectFeedback', projectId],
    queryFn: () => listProjectFeedback(projectId),
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-lg bg-gray-800" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded bg-red-900/30 p-4 text-red-400">
        Failed to load feedback: {(error as Error).message}
      </div>
    );
  }

  if (!feedback || feedback.length === 0) {
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-800 p-8 text-center text-gray-400">
        No feedback submitted yet.
      </div>
    );
  }

  const triageColors: Record<string, string> = {
    pending: 'text-yellow-400',
    reviewed: 'text-blue-400',
    accepted: 'text-green-400',
    dismissed: 'text-gray-500',
  };

  return (
    <div className="space-y-3">
      {feedback.map((item: FeedbackItem) => (
        <div
          key={item.id}
          className="rounded-lg border border-gray-700 bg-gray-800 p-4"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs text-gray-500">
              {item.sourceType}
              {item.submittedBy && ` by ${item.submittedBy}`}
            </span>
            <span className={`text-xs font-medium ${triageColors[item.triageStatus] ?? 'text-gray-400'}`}>
              {item.triageStatus.replace(/\b\w/g, (c) => c.toUpperCase())}
            </span>
          </div>
          <p className="text-sm text-gray-300">{item.rawContent}</p>
          <p className="mt-2 text-xs text-gray-500">
            {new Date(item.submittedAt).toLocaleString()}
          </p>
        </div>
      ))}
    </div>
  );
}

function TerminalTab({ project, autoClone = false }: { project: import('../types').Project; autoClone?: boolean }) {
  const queryClient = useQueryClient();
  const [cloneLog, setCloneLog] = useState<string[]>([]);
  const [streaming, setStreaming] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const autoCloneStarted = useRef(false);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [cloneLog]);

  const startSSE = (url: string) => {
    setCloneLog([]);
    setStreaming(true);
    const es = new EventSource(url);
    es.onmessage = (e) => {
      const line = e.data as string;
      if (line === 'DONE') {
        es.close();
        setStreaming(false);
        queryClient.invalidateQueries({ queryKey: ['project', project.code] });
      } else if (line.startsWith('ERROR: ')) {
        setCloneLog(prev => [...prev, line]);
        es.close();
        setStreaming(false);
        queryClient.invalidateQueries({ queryKey: ['project', project.code] });
      } else {
        setCloneLog(prev => [...prev, line]);
      }
    };
    es.onerror = () => { es.close(); setStreaming(false); };
  };

  const handleClone = () => startSSE(getCloneSSEUrl(project.id));
  const handlePull = () => startSSE(getPullSSEUrl(project.id));

  // Auto-start clone when arriving from the "Create & Clone" wizard step
  useEffect(() => {
    if (autoClone && !autoCloneStarted.current && !streaming && project.cloneStatus !== 'cloned' && !!project.links.githubUrl) {
      autoCloneStarted.current = true;
      startSSE(getCloneSSEUrl(project.id));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);
  const handleRemove = async () => {
    await removeClone(project.id);
    queryClient.invalidateQueries({ queryKey: ['project', project.code] });
  };

  const isCloned = project.cloneStatus === 'cloned' || !!project.links.localPath;
  const isCloning = project.cloneStatus === 'cloning' || streaming;
  const hasGitHub = !!project.links.githubUrl;

  // If cloned, show the chat view with the local path
  if (isCloned && !streaming) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 text-xs text-gray-500">
          <span className="font-mono">{project.links.localPath}</span>
          <div className="flex gap-2">
            <button onClick={handlePull}
              className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors">
              Pull
            </button>
            <button onClick={handleRemove}
              className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors">
              Remove clone
            </button>
          </div>
        </div>
        <div className="rounded-lg border border-gray-700 overflow-hidden" style={{ height: '560px' }}>
          <ChatView
            projectId={project.id}
            projectCode={project.code}
            localPath={project.links.localPath}
          />
        </div>
      </div>
    );
  }

  // If actively streaming clone output, show log
  if (isCloning || cloneLog.length > 0) {
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-900 p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          {streaming && <div className="w-3 h-3 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />}
          <span>{streaming ? 'Cloning…' : 'Clone output'}</span>
        </div>
        <div ref={logRef} className="font-mono text-xs text-green-300 bg-black rounded p-3 h-64 overflow-y-auto whitespace-pre-wrap">
          {cloneLog.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      </div>
    );
  }

  // No local path: show clone prompt if github URL configured
  if (hasGitHub) {
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-900 p-8 flex flex-col items-center gap-4 text-center">
        <div className="text-gray-400 text-sm">
          <p className="text-white font-medium mb-1">No local copy yet</p>
          <p>Clone the repository to this server to start a Claude Code session.</p>
          <p className="mt-1 font-mono text-xs text-gray-500">{project.links.githubUrl}</p>
        </div>
        {project.cloneStatus === 'error' && (
          <p className="text-red-400 text-xs">{project.cloneError}</p>
        )}
        <button onClick={handleClone}
          className="bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-2 px-6 rounded-lg text-sm transition-colors">
          Clone repository
        </button>
      </div>
    );
  }

  // No local path and no github URL: show the existing local-path chat view (shows its own prompt)
  return (
    <div className="rounded-lg border border-gray-700 overflow-hidden" style={{ height: '600px' }}>
      <ChatView
        projectId={project.id}
        projectCode={project.code}
        localPath={project.links.localPath}
      />
    </div>
  );
}

export default ProjectPage;
