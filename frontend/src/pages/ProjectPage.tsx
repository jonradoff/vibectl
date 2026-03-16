import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getProjectByCode, listProjectFeedback, runHealthCheck } from '../api/client';
import type { FeedbackItem } from '../types';
import IssueTable from '../components/issues/IssueTable';
import ProjectSettings from '../components/projects/ProjectSettings';
import ChatView from '../components/chat/ChatView';
import HealthChecksTab from '../components/projects/HealthChecksTab';
import VibectlMdTab from '../components/projects/VibectlMdTab';

type Tab = 'issues' | 'terminal' | 'feedback' | 'health' | 'docs' | 'settings';

function ProjectPage() {
  const { code } = useParams<{ code: string }>();
  const [activeTab, setActiveTab] = useState<Tab>('issues');

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
        <div className="rounded-lg border border-gray-700 overflow-hidden" style={{ height: '600px' }}>
          <ChatView
            projectId={project.id}
            projectCode={project.code}
            localPath={project.links.localPath}
          />
        </div>
      )}

      {activeTab === 'feedback' && <FeedbackTab projectId={project.id} />}

      {activeTab === 'health' && <HealthChecksTab project={project} />}

      {activeTab === 'docs' && <VibectlMdTab project={project} />}

      {activeTab === 'settings' && <ProjectSettings project={project} />}
    </div>
  );
}

function FeedbackTab({ projectId }: { projectId: string }) {
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

export default ProjectPage;
