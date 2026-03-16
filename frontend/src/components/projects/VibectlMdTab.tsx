import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getVibectlMd, generateVibectlMd, listDecisions } from '../../api/client';
import type { Project, Decision } from '../../types';

interface VibectlMdTabProps {
  project: Project;
}

export default function VibectlMdTab({ project }: VibectlMdTabProps) {
  const queryClient = useQueryClient();
  const [activeView, setActiveView] = useState<'docs' | 'decisions'>('docs');

  const hasLocalPath = !!project.links.localPath;

  const { data: mdContent, isLoading: mdLoading, error: mdError } = useQuery({
    queryKey: ['vibectlMd', project.id],
    queryFn: () => getVibectlMd(project.id),
    enabled: hasLocalPath,
    retry: false,
  });

  const { data: decisions, isLoading: decisionsLoading } = useQuery({
    queryKey: ['decisions', project.id],
    queryFn: () => listDecisions(project.id, 50),
  });

  const generateMutation = useMutation({
    mutationFn: () => generateVibectlMd(project.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vibectlMd', project.id] });
      queryClient.invalidateQueries({ queryKey: ['project', project.code] });
    },
  });

  if (!hasLocalPath) {
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-800 p-8 text-center text-gray-400">
        <p className="mb-2">No local path configured for this project.</p>
        <p className="text-sm">Set a local path in <span className="font-medium text-indigo-400">Settings</span> to enable VIBECTL.md generation.</p>
      </div>
    );
  }

  const actionColors: Record<string, string> = {
    issue_created: 'text-green-400',
    status_change: 'text-blue-400',
    issue_archived: 'text-gray-500',
    feedback_accepted: 'text-emerald-400',
    feedback_dismissed: 'text-gray-500',
    pm_review: 'text-purple-400',
    manual: 'text-indigo-400',
  };

  return (
    <div className="space-y-4">
      {/* Header bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex items-center rounded bg-gray-800 border border-gray-700">
            <button
              onClick={() => setActiveView('docs')}
              className={`px-3 py-1.5 text-sm font-medium rounded-l transition-colors ${
                activeView === 'docs' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              VIBECTL.md
            </button>
            <button
              onClick={() => setActiveView('decisions')}
              className={`px-3 py-1.5 text-sm font-medium rounded-r transition-colors ${
                activeView === 'decisions' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              Decisions
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {project.vibectlMdGeneratedAt && (
            <span className="text-xs text-gray-500">
              Generated: {new Date(project.vibectlMdGeneratedAt).toLocaleString()}
            </span>
          )}
          <button
            onClick={() => generateMutation.mutate()}
            disabled={generateMutation.isPending}
            className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
          >
            {generateMutation.isPending ? 'Generating...' : 'Regenerate'}
          </button>
        </div>
      </div>

      {generateMutation.isError && (
        <div className="rounded bg-red-900/30 p-3 text-sm text-red-400">
          {generateMutation.error instanceof Error ? generateMutation.error.message : 'Generation failed'}
        </div>
      )}

      {activeView === 'docs' && (
        <div className="rounded-lg border border-gray-700 bg-gray-800 overflow-hidden">
          {mdLoading && (
            <div className="p-6 space-y-3">
              {[...Array(8)].map((_, i) => (
                <div key={i} className="h-4 animate-pulse rounded bg-gray-700" style={{ width: `${60 + Math.random() * 40}%` }} />
              ))}
            </div>
          )}
          {mdError && !mdContent && (
            <div className="p-8 text-center text-gray-400">
              <p className="mb-3">VIBECTL.md has not been generated yet.</p>
              <button
                onClick={() => generateMutation.mutate()}
                disabled={generateMutation.isPending}
                className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                Generate Now
              </button>
            </div>
          )}
          {mdContent && (
            <pre className="p-4 text-sm text-gray-300 whitespace-pre-wrap font-mono leading-relaxed overflow-x-auto max-h-[70vh] overflow-y-auto">
              {mdContent}
            </pre>
          )}
        </div>
      )}

      {activeView === 'decisions' && (
        <div className="rounded-lg border border-gray-700 bg-gray-800 overflow-hidden">
          {decisionsLoading && (
            <div className="p-4 space-y-2">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-6 animate-pulse rounded bg-gray-700" />
              ))}
            </div>
          )}
          {decisions && decisions.length === 0 && (
            <div className="p-8 text-center text-gray-400 text-sm">
              No decisions recorded yet. Decisions are logged when issues are created, statuses change, or feedback is reviewed.
            </div>
          )}
          {decisions && decisions.length > 0 && (
            <div className="divide-y divide-gray-700/50">
              {decisions.map((d: Decision) => (
                <div key={d.id} className="flex items-start gap-3 px-4 py-3">
                  <span className="text-xs text-gray-500 font-mono shrink-0 pt-0.5 w-20">
                    {new Date(d.timestamp).toLocaleDateString()}
                  </span>
                  <span className={`text-xs font-medium shrink-0 pt-0.5 w-28 ${actionColors[d.action] || 'text-gray-400'}`}>
                    {d.action.replace(/_/g, ' ')}
                  </span>
                  <span className="text-sm text-gray-300 flex-1">{d.summary}</span>
                  {d.issueKey && (
                    <span className="text-xs font-mono text-gray-500 shrink-0">{d.issueKey}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
