import { Fragment, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listFeedback, reviewFeedback, listProjects, triageAllPending, generateFeedbackPrompt } from '../api/client';
import type { FeedbackItem, Project, TriageStatus, GeneratePromptResponse } from '../types';
import FeedbackForm from '../components/feedback/FeedbackForm';
import PromptReviewModal from '../components/feedback/PromptReviewModal';
import { FeedbackDetailModal } from '../components/projects/FeedbackTab';

const PAGE_SIZE = 25;

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
  const [statusFilter, setStatusFilter] = useState<'all' | 'actionable' | TriageStatus>('actionable');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<FeedbackItem | null>(null);
  const [showSubmitForm, setShowSubmitForm] = useState(false);
  const [promptData, setPromptData] = useState<GeneratePromptResponse | null>(null);
  const [promptProjectCode, setPromptProjectCode] = useState('');
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [page, setPage] = useState(0);

  const feedbackParams: Record<string, string> = {};
  if (projectFilter !== 'all') feedbackParams.projectCode = projectFilter;
  if (statusFilter !== 'all' && statusFilter !== 'actionable') feedbackParams.triageStatus = statusFilter;
  if (sourceFilter !== 'all') feedbackParams.sourceType = sourceFilter;

  const { data: rawFeedback = [], isLoading } = useQuery({
    queryKey: ['feedback', feedbackParams],
    queryFn: () => listFeedback(Object.keys(feedbackParams).length > 0 ? feedbackParams : undefined),
  });

  // "Actionable" filters to pending + triaged (items needing review)
  const feedback = statusFilter === 'actionable'
    ? rawFeedback.filter((f: FeedbackItem) => f.triageStatus === 'pending' || f.triageStatus === 'triaged')
    : rawFeedback;

  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
  });

  const projectByCode = new Map<string, Project>(projects.map((p) => [p.code, p]));

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

  const generatePromptMutation = useMutation({
    mutationFn: (code: string) => generateFeedbackPrompt(code),
    onSuccess: (data) => setPromptData(data),
  });

  // Compute which projects have accepted-unsubmitted feedback
  const projectsWithAccepted = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of feedback) {
      if (f.triageStatus === 'accepted' && !f.promptSubmittedAt && f.projectCode) {
        counts.set(f.projectCode, (counts.get(f.projectCode) || 0) + 1);
      }
    }
    return counts;
  }, [feedback]);

  const totalAcceptedUnsubmitted = Array.from(projectsWithAccepted.values()).reduce((a, b) => a + b, 0);

  const sourceTypes = [...new Set(feedback.map((f) => f.sourceType))];

  // Pagination
  const totalPages = Math.max(1, Math.ceil(feedback.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pagedFeedback = feedback.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  // Reset page when filters change
  const handleFilterChange = (setter: (v: string) => void, value: string) => {
    setter(value);
    setPage(0);
  };

  const handleGeneratePrompt = () => {
    if (projectFilter !== 'all' && projectsWithAccepted.has(projectFilter)) {
      // Already filtered to a project — go directly
      setPromptProjectCode(projectFilter);
      generatePromptMutation.mutate(projectFilter);
    } else {
      // Show project picker
      setShowProjectPicker(true);
    }
  };

  const handlePickProject = (code: string) => {
    setShowProjectPicker(false);
    setPromptProjectCode(code);
    setProjectFilter(code);
    generatePromptMutation.mutate(code);
  };

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
          {totalAcceptedUnsubmitted > 0 && (
            <button
              onClick={handleGeneratePrompt}
              disabled={generatePromptMutation.isPending}
              className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-500 text-sm font-medium disabled:opacity-50"
            >
              {generatePromptMutation.isPending ? 'Generating...' : `Generate Prompt (${totalAcceptedUnsubmitted})`}
            </button>
          )}
          </div>
        </div>

        {/* Filter bar */}
        <div className="flex flex-wrap gap-3 mb-6">
          <select
            value={projectFilter}
            onChange={(e) => handleFilterChange(setProjectFilter, e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
          >
            <option value="all">All Projects</option>
            {projects.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name}
              </option>
            ))}
          </select>

          <select
            value={statusFilter}
            onChange={(e) => handleFilterChange((v) => setStatusFilter(v as 'all' | 'actionable' | TriageStatus), e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
          >
            <option value="actionable">Needs Review</option>
            <option value="all">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="triaged">Triaged</option>
            <option value="accepted">Accepted</option>
            <option value="dismissed">Dismissed</option>
          </select>

          <select
            value={sourceFilter}
            onChange={(e) => handleFilterChange(setSourceFilter, e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
          >
            <option value="all">All Sources</option>
            {sourceTypes.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>

          {/* Page info */}
          {feedback.length > PAGE_SIZE && (
            <span className="text-xs text-gray-500 self-center ml-auto">
              {safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, feedback.length)} of {feedback.length}
            </span>
          )}
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
                {pagedFeedback.map((item: FeedbackItem) => {
                  const isPending = item.triageStatus === 'pending';
                  const isExpanded = expandedId === item.id;
                  const project = item.projectCode ? projectByCode.get(item.projectCode) : null;

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
                          {project ? project.name : item.projectCode || '--'}
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
                                onClick={(e) => { e.stopPropagation(); reviewMutation.mutate({ id: item.id, action: 'accept' }); }}
                                disabled={reviewMutation.isPending}
                                className="px-3 py-1 bg-green-600 hover:bg-green-500 text-white text-xs rounded transition-colors disabled:opacity-50"
                              >
                                Accept
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); reviewMutation.mutate({ id: item.id, action: 'dismiss' }); }}
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

            {/* Pagination controls */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-700">
                <button
                  onClick={() => setPage(Math.max(0, safePage - 1))}
                  disabled={safePage === 0}
                  className="px-3 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  Previous
                </button>
                <div className="flex items-center gap-1">
                  {Array.from({ length: totalPages }, (_, i) => (
                    <button
                      key={i}
                      onClick={() => setPage(i)}
                      className={`w-7 h-7 rounded text-xs font-medium transition-colors ${
                        i === safePage
                          ? 'bg-indigo-600 text-white'
                          : 'text-gray-500 hover:text-gray-300 hover:bg-gray-700'
                      }`}
                    >
                      {i + 1}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))}
                  disabled={safePage >= totalPages - 1}
                  className="px-3 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  Next
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Project picker modal for Generate Prompt */}
      {showProjectPicker && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowProjectPicker(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-5 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold text-gray-200">Select Project for Prompt</h3>
              <button onClick={() => setShowProjectPicker(false)} className="text-gray-500 hover:text-gray-300">&times;</button>
            </div>
            <p className="text-xs text-gray-400 mb-3">Choose which project's accepted feedback to compile into a prompt.</p>
            <div className="space-y-1.5 max-h-60 overflow-y-auto">
              {Array.from(projectsWithAccepted.entries()).map(([code, count]) => {
                const proj = projectByCode.get(code);
                return (
                  <button
                    key={code}
                    onClick={() => handlePickProject(code)}
                    className="w-full flex items-center justify-between px-3 py-2 rounded bg-gray-800 hover:bg-gray-700 transition-colors text-left"
                  >
                    <span className="text-sm text-gray-200">{proj?.name || code}</span>
                    <span className="text-xs text-green-400 font-mono">{count} accepted</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Prompt review modal */}
      {promptData && (
        <PromptReviewModal
          prompt={promptData.prompt}
          warnings={promptData.warnings}
          feedbackIds={promptData.feedbackIds}
          batchId={promptData.batchId}
          projectCode={promptProjectCode}
          projectId={projectByCode.get(promptProjectCode)?.id || ''}
          projectName={projectByCode.get(promptProjectCode)?.name || promptProjectCode}
          onClose={() => setPromptData(null)}
          onSubmitted={() => queryClient.invalidateQueries({ queryKey: ['feedback'] })}
        />
      )}

      {/* Feedback detail modal with continuous review */}
      {selectedItem && createPortal(
        <FeedbackDetailModal
          item={selectedItem}
          projectCode={selectedItem.projectCode || ''}
          projectName={selectedItem.projectCode ? (projectByCode.get(selectedItem.projectCode)?.name || selectedItem.projectCode) : ''}
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
