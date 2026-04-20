import { Fragment, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listFeedback, reviewFeedback, listProjects, triageAllPending } from '../api/client';
import type { FeedbackItem, Project, TriageStatus } from '../types';
import FeedbackForm from '../components/feedback/FeedbackForm';
import { FeedbackDetailModal } from '../components/projects/FeedbackTab';

const triageStatusColors: Record<TriageStatus, string> = {
  pending: 'bg-yellow-500 text-black',
  triaged: 'bg-indigo-500 text-white',
  reviewed: 'bg-blue-500 text-white',
  accepted: 'bg-green-500 text-white',
  dismissed: 'bg-gray-500 text-white',
};

const sourceTypeColors: Record<string, string> = {
  discord: 'bg-indigo-600 text-white',
  email: 'bg-sky-600 text-white',
  slack: 'bg-purple-600 text-white',
  github: 'bg-gray-600 text-white',
  manual: 'bg-teal-600 text-white',
};

function truncate(text: string, max: number) {
  return text.length > max ? text.slice(0, max) + '...' : text;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function FeedbackPage() {
  const queryClient = useQueryClient();
  const [projectFilter, setProjectFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | TriageStatus>('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<FeedbackItem | null>(null);
  const [showSubmitForm, setShowSubmitForm] = useState(false);

  const feedbackParams: Record<string, string> = {};
  if (projectFilter !== 'all') feedbackParams.projectCode = projectFilter;
  if (statusFilter !== 'all') feedbackParams.triageStatus = statusFilter;
  if (sourceFilter !== 'all') feedbackParams.sourceType = sourceFilter;

  const { data: feedback = [], isLoading } = useQuery({
    queryKey: ['feedback', feedbackParams],
    queryFn: () => listFeedback(Object.keys(feedbackParams).length > 0 ? feedbackParams : undefined),
  });

  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
  });

  const projectMap = new Map<string, Project>(projects.map((p) => [p.id, p]));

  const reviewMutation = useMutation({
    mutationFn: ({ id, action, createIssue }: { id: string; action: string; createIssue?: boolean }) =>
      reviewFeedback(id, action, createIssue),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feedback'] });
    },
  });

  const triageMutation = useMutation({
    mutationFn: triageAllPending,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feedback'] });
    },
  });

  const sourceTypes = [...new Set(feedback.map((f) => f.sourceType))];

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">Feedback</h1>
          <div className="flex items-center gap-3">
          <button
            onClick={() => setShowSubmitForm(true)}
            className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-500 text-sm font-medium"
          >
            + Submit Feedback
          </button>
          <FeedbackForm
            open={showSubmitForm}
            onClose={() => setShowSubmitForm(false)}
            projects={projects.map(p => ({ id: p.id, name: p.name, code: p.code }))}
          />
          <button
            onClick={() => triageMutation.mutate()}
            disabled={triageMutation.isPending}
            className="px-4 py-2 bg-amber-600 text-white rounded hover:bg-amber-500 text-sm font-medium disabled:opacity-50"
          >
            {triageMutation.isPending ? 'Analyzing...' : 'Analyze All Pending'}
          </button>
          </div>
        </div>

        {/* Filter bar */}
        <div className="flex flex-wrap gap-3 mb-6">
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
          >
            <option value="all">All Projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'all' | TriageStatus)}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
          >
            <option value="all">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="reviewed">Reviewed</option>
            <option value="accepted">Accepted</option>
            <option value="dismissed">Dismissed</option>
          </select>

          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
          >
            <option value="all">All Sources</option>
            {sourceTypes.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="text-center py-12 text-gray-400">Loading feedback...</div>
        ) : feedback.length === 0 ? (
          <div className="bg-gray-800 rounded-lg p-12 text-center">
            <p className="text-gray-400 text-lg">No feedback found</p>
            <p className="text-gray-500 text-sm mt-2">
              Feedback will appear here once submitted via the API or integrations.
            </p>
          </div>
        ) : (
          <div className="bg-gray-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700 text-gray-400 text-left">
                  <th className="px-4 py-3 font-medium">Source</th>
                  <th className="px-4 py-3 font-medium">Content</th>
                  <th className="px-4 py-3 font-medium">Submitted By</th>
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 font-medium">Project</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {feedback.map((item: FeedbackItem) => {
                  const isPending = item.triageStatus === 'pending';
                  const isExpanded = expandedId === item.id;
                  const project = item.projectCode ? projectMap.get(item.projectCode) : null;

                  return (
                    <Fragment key={item.id}>
                      <tr
                        className={`border-b border-gray-700/50 hover:bg-gray-700/30 cursor-pointer ${
                          isPending ? 'bg-yellow-900/10' : ''
                        }`}
                        onClick={() => setSelectedItem(item)}
                      >
                        <td className="px-4 py-3">
                          <span
                            className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                              sourceTypeColors[item.sourceType] || 'bg-gray-600 text-white'
                            }`}
                          >
                            {item.sourceType}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <button
                            onClick={() =>
                              item.aiAnalysis
                                ? setExpandedId(isExpanded ? null : item.id)
                                : undefined
                            }
                            className={`text-left ${item.aiAnalysis ? 'cursor-pointer hover:text-white' : 'cursor-default'}`}
                          >
                            {truncate(item.rawContent, 100)}
                            {item.aiAnalysis && (
                              <span className="ml-2 text-xs text-blue-400">
                                {isExpanded ? '[-]' : '[+] AI'}
                              </span>
                            )}
                          </button>
                        </td>
                        <td className="px-4 py-3 text-gray-300">
                          {item.submittedBy || '--'}
                        </td>
                        <td className="px-4 py-3 text-gray-400 whitespace-nowrap">
                          {formatDate(item.submittedAt)}
                        </td>
                        <td className="px-4 py-3 text-gray-300">
                          {project ? project.name : '--'}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                              triageStatusColors[item.triageStatus]
                            }`}
                          >
                            {item.triageStatus}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {isPending && (
                            <div className="flex gap-2">
                              <button
                                onClick={() =>
                                  reviewMutation.mutate({
                                    id: item.id,
                                    action: 'accept',
                                  })
                                }
                                disabled={reviewMutation.isPending}
                                className="px-3 py-1 bg-green-600 hover:bg-green-500 text-white text-xs rounded transition-colors disabled:opacity-50"
                              >
                                Accept
                              </button>
                              <button
                                onClick={() =>
                                  reviewMutation.mutate({
                                    id: item.id,
                                    action: 'dismiss',
                                  })
                                }
                                disabled={reviewMutation.isPending}
                                className="px-3 py-1 bg-gray-600 hover:bg-gray-500 text-white text-xs rounded transition-colors disabled:opacity-50"
                              >
                                Dismiss
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                      {isExpanded && item.aiAnalysis && (
                        <tr className="border-b border-gray-700/50">
                          <td colSpan={7} className="px-4 py-4 bg-gray-800/80">
                            <div className="space-y-3 text-sm">
                              <div className="flex items-center gap-4">
                                <span className="text-gray-400">Confidence:</span>
                                <span className="font-mono text-white">
                                  {(item.aiAnalysis.confidence * 100).toFixed(0)}%
                                </span>
                              </div>
                              {item.aiAnalysis.matchedIssueKeys.length > 0 && (
                                <div>
                                  <span className="text-gray-400">Matched Issues:</span>
                                  <div className="flex gap-2 mt-1">
                                    {item.aiAnalysis.matchedIssueKeys.map((key) => (
                                      <span
                                        key={key}
                                        className="px-2 py-0.5 bg-blue-800 text-blue-200 rounded text-xs font-mono"
                                      >
                                        {key}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {item.aiAnalysis.proposedIssue && (
                                <div>
                                  <span className="text-gray-400">Proposed Issue:</span>
                                  <div className="mt-1 p-3 bg-gray-900 rounded">
                                    <p className="font-medium text-white">
                                      {item.aiAnalysis.proposedIssue.title}
                                    </p>
                                    <p className="text-gray-300 mt-1">
                                      {item.aiAnalysis.proposedIssue.description}
                                    </p>
                                    <div className="flex gap-3 mt-2 text-xs text-gray-400">
                                      <span>Type: {item.aiAnalysis.proposedIssue.type}</span>
                                      <span>
                                        Priority: {item.aiAnalysis.proposedIssue.priority}
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              )}
                              <div>
                                <span className="text-gray-400">Reasoning:</span>
                                <p className="text-gray-300 mt-1">
                                  {item.aiAnalysis.reasoning}
                                </p>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Feedback detail modal with continuous review */}
      {selectedItem && createPortal(
        <FeedbackDetailModal
          item={selectedItem}
          projectCode={selectedItem.projectCode ? (projectMap.get(selectedItem.projectCode)?.code || '') : ''}
          onClose={() => setSelectedItem(null)}
          onAccept={(createIssue) => {
            const currentId = selectedItem.id;
            reviewMutation.mutate({ id: currentId, action: 'accept', createIssue }, {
              onSuccess: () => {
                const pending = feedback.filter((i: FeedbackItem) => (i.triageStatus === 'pending' || i.triageStatus === 'triaged') && i.id !== currentId);
                setSelectedItem(pending.length > 0 ? pending[0] : null);
              }
            });
          }}
          onDismiss={() => {
            const currentId = selectedItem.id;
            reviewMutation.mutate({ id: currentId, action: 'dismiss' }, {
              onSuccess: () => {
                const pending = feedback.filter((i: FeedbackItem) => (i.triageStatus === 'pending' || i.triageStatus === 'triaged') && i.id !== currentId);
                setSelectedItem(pending.length > 0 ? pending[0] : null);
              }
            });
          }}
          isMutating={reviewMutation.isPending}
          reviewProgress={(() => {
            const pending = feedback.filter((i: FeedbackItem) => i.triageStatus === 'pending' || i.triageStatus === 'triaged');
            const idx = pending.findIndex((i: FeedbackItem) => i.id === selectedItem.id);
            return idx >= 0 ? { current: idx + 1, total: pending.length } : undefined;
          })()}
        />,
        document.body,
      )}
    </div>
  );
}
