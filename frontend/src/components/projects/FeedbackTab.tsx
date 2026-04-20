import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { listProjectFeedback, createFeedback, reviewFeedback, bulkReviewFeedback, triggerTriage, triggerTriageBatch } from '../../api/client'
import type { FeedbackItem } from '../../types'

interface FeedbackTabProps {
  projectId: string
  projectCode: string
}

export default function FeedbackTab({ projectId, projectCode }: FeedbackTabProps) {
  const queryClient = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [selectedItem, setSelectedItem] = useState<FeedbackItem | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['feedback', projectId],
    queryFn: () => listProjectFeedback(projectId),
    refetchInterval: 30_000,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['feedback', projectId] })
    queryClient.invalidateQueries({ queryKey: ['globalDashboard'] })
  }

  const reviewMutation = useMutation({
    mutationFn: ({ id, action, createIssue }: { id: string; action: string; createIssue?: boolean }) =>
      reviewFeedback(id, action, createIssue ?? false),
    onSuccess: () => { invalidate(); setSelectedItem(null) },
  })

  const bulkMutation = useMutation({
    mutationFn: (reqs: { id: string; action: string }[]) => bulkReviewFeedback(reqs),
    onSuccess: () => { invalidate(); setSelectedIds(new Set()) },
  })

  const triageMutation = useMutation({
    mutationFn: (id: string) => triggerTriage(id),
    onSuccess: invalidate,
  })

  const triageBatchMutation = useMutation({
    mutationFn: () => triggerTriageBatch(),
    onSuccess: invalidate,
  })

  const pending = items.filter((i) => i.triageStatus === 'pending' || i.triageStatus === 'triaged')
  const accepted = items.filter((i) => i.triageStatus === 'accepted')
  const dismissed = items.filter((i) => i.triageStatus === 'dismissed')

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleBulkAction = (action: 'accept' | 'dismiss') => {
    const reqs = Array.from(selectedIds).map((id) => ({ id, action }))
    if (reqs.length > 0) bulkMutation.mutate(reqs)
  }

  if (isLoading) {
    return (
      <div className="p-3 space-y-1">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-8 animate-pulse rounded bg-gray-700/50" />
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-700/40 shrink-0">
        <button
          onClick={() => setShowAdd(true)}
          className="rounded bg-indigo-700/60 px-2 py-0.5 text-[10px] text-indigo-200 hover:bg-indigo-700 transition-colors"
        >+ Add</button>
        {pending.length > 0 && (
          <button
            onClick={() => triageBatchMutation.mutate()}
            disabled={triageBatchMutation.isPending}
            className="rounded bg-purple-700/50 px-2 py-0.5 text-[10px] text-purple-300 hover:bg-purple-700 disabled:opacity-50 transition-colors"
          >
            {triageBatchMutation.isPending ? 'Triaging...' : `AI Triage All (${pending.length})`}
          </button>
        )}
        {selectedIds.size > 0 && (
          <>
            <span className="text-[10px] text-gray-500">{selectedIds.size} selected</span>
            <button onClick={() => handleBulkAction('accept')} className="rounded bg-green-700/60 px-1.5 py-0.5 text-[9px] text-green-300 hover:bg-green-700 transition-colors">Accept</button>
            <button onClick={() => handleBulkAction('dismiss')} className="rounded bg-gray-700/50 px-1.5 py-0.5 text-[9px] text-gray-400 hover:bg-gray-700 transition-colors">Dismiss</button>
          </>
        )}
      </div>

      {/* Three-column layout */}
      <div className="flex flex-1 overflow-hidden divide-x divide-gray-700/40">
        {/* Pending */}
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="px-2 py-1 text-[10px] font-medium text-amber-400 bg-amber-900/10 border-b border-gray-700/40 shrink-0">
            Pending ({pending.length})
          </div>
          <div className="flex-1 overflow-y-auto">
            {pending.length === 0 ? (
              <div className="flex items-center justify-center h-12 text-[10px] text-gray-600">None</div>
            ) : (
              pending.map((item) => (
                <FeedbackRow
                  key={item.id}
                  item={item}
                  selected={selectedIds.has(item.id)}
                  onToggle={() => toggleSelect(item.id)}
                  onClick={() => setSelectedItem(item)}
                  onTriage={() => triageMutation.mutate(item.id)}
                  isTriaging={triageMutation.isPending && triageMutation.variables === item.id}
                />
              ))
            )}
          </div>
        </div>

        {/* Accepted */}
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="px-2 py-1 text-[10px] font-medium text-green-400 bg-green-900/10 border-b border-gray-700/40 shrink-0">
            Accepted ({accepted.length})
          </div>
          <div className="flex-1 overflow-y-auto">
            {accepted.length === 0 ? (
              <div className="flex items-center justify-center h-12 text-[10px] text-gray-600">None</div>
            ) : (
              accepted.map((item) => (
                <FeedbackRow key={item.id} item={item} onClick={() => setSelectedItem(item)} />
              ))
            )}
          </div>
        </div>

        {/* Dismissed */}
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="px-2 py-1 text-[10px] font-medium text-gray-500 bg-gray-800/30 border-b border-gray-700/40 shrink-0">
            Dismissed ({dismissed.length})
          </div>
          <div className="flex-1 overflow-y-auto">
            {dismissed.length === 0 ? (
              <div className="flex items-center justify-center h-12 text-[10px] text-gray-600">None</div>
            ) : (
              dismissed.map((item) => (
                <FeedbackRow key={item.id} item={item} onClick={() => setSelectedItem(item)} />
              ))
            )}
          </div>
        </div>
      </div>

      {/* Add feedback modal */}
      {showAdd && (
        <AddFeedbackModal
          projectCode={projectCode}
          onClose={() => setShowAdd(false)}
          onCreated={invalidate}
        />
      )}

      {/* Feedback detail modal — continuous review mode */}
      {selectedItem && createPortal(
        <FeedbackDetailModal
          item={selectedItem}
          projectCode={projectCode}
          onClose={() => setSelectedItem(null)}
          onAccept={(createIssue) => {
            const currentId = selectedItem.id
            reviewMutation.mutate({ id: currentId, action: 'accept', createIssue }, {
              onSuccess: () => {
                // Advance to next pending item
                const remainingPending = pending.filter(i => i.id !== currentId)
                if (remainingPending.length > 0) {
                  setSelectedItem(remainingPending[0])
                } else {
                  setSelectedItem(null)
                }
              }
            })
          }}
          onDismiss={() => {
            const currentId = selectedItem.id
            reviewMutation.mutate({ id: currentId, action: 'dismiss' }, {
              onSuccess: () => {
                const remainingPending = pending.filter(i => i.id !== currentId)
                if (remainingPending.length > 0) {
                  setSelectedItem(remainingPending[0])
                } else {
                  setSelectedItem(null)
                }
              }
            })
          }}
          isMutating={reviewMutation.isPending}
          reviewProgress={(() => {
            const idx = pending.findIndex(i => i.id === selectedItem.id)
            return idx >= 0 ? { current: idx + 1, total: pending.length } : undefined
          })()}
        />,
        document.body,
      )}
    </div>
  )
}

// ─── Feedback Row (summary only — no Accept/Dismiss buttons) ─────────────────

interface FeedbackRowProps {
  item: FeedbackItem
  selected?: boolean
  onToggle?: () => void
  onClick?: () => void
  onTriage?: () => void
  isTriaging?: boolean
}

function FeedbackRow({ item, selected, onToggle, onClick, onTriage, isTriaging }: FeedbackRowProps) {
  const isTriaged = item.triageStatus === 'triaged'
  const proposal = item.aiAnalysis?.proposedIssue

  return (
    <div
      className={`border-b border-gray-700/30 text-xs transition-colors cursor-pointer ${
        selected ? 'bg-indigo-900/20' : 'hover:bg-gray-700/20'
      }`}
      onClick={onClick}
    >
      <div className="flex items-start gap-1.5 px-2 py-1.5">
        {onToggle && (
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => { e.stopPropagation(); onToggle() }}
            onClick={(e) => e.stopPropagation()}
            className="mt-0.5 shrink-0 accent-indigo-500"
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1 text-[10px] text-gray-500 mb-0.5">
            <span className="rounded bg-gray-700 px-1 font-mono">{item.sourceType}</span>
            {item.submittedBy && <span>{item.submittedBy}</span>}
            <span className="ml-auto">{new Date(item.submittedAt).toLocaleDateString()}</span>
          </div>
          <p className="text-gray-200 line-clamp-2 whitespace-pre-wrap">{item.rawContent}</p>
          {isTriaged && proposal && (
            <div className="mt-1 rounded border border-indigo-500/30 bg-indigo-900/20 px-2 py-0.5">
              <p className="text-[10px] text-indigo-300 font-medium">{proposal.title}</p>
            </div>
          )}
          {item.linkedIssueKey && (
            <span className="inline-block mt-0.5 text-[10px] text-indigo-400 font-mono">{item.linkedIssueKey}</span>
          )}
        </div>
      </div>
      {/* Triage button only — no Accept/Dismiss in summary */}
      {onTriage && !isTriaged && (
        <div className="px-2 pb-1.5">
          <button
            onClick={(e) => { e.stopPropagation(); onTriage() }}
            disabled={isTriaging}
            className="rounded bg-indigo-700/50 px-1.5 py-0.5 text-[9px] text-indigo-300 hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {isTriaging ? '...' : 'AI Triage'}
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Feedback Detail Modal ───────────────────────────────────────────────────

export function FeedbackDetailModal({ item, projectCode, projectName, onClose, onAccept, onDismiss, isMutating, reviewProgress }: {
  item: FeedbackItem
  projectCode: string
  projectName?: string
  onClose: () => void
  onAccept: (createIssue: boolean) => void
  onDismiss: () => void
  isMutating: boolean
  reviewProgress?: { current: number; total: number }
}) {
  const isPending = item.triageStatus === 'pending' || item.triageStatus === 'triaged'
  const proposal = item.aiAnalysis?.proposedIssue

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-5 max-w-2xl w-full max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
              item.triageStatus === 'accepted' ? 'bg-green-900/40 text-green-400' :
              item.triageStatus === 'dismissed' ? 'bg-gray-700/50 text-gray-400' :
              'bg-amber-900/30 text-amber-400'
            }`}>{item.triageStatus}</span>
            <span className="rounded bg-gray-700 px-1.5 py-0.5 text-[10px] font-mono text-gray-400">{item.sourceType}</span>
            {(projectName || projectCode) && (
              <span className="rounded bg-indigo-900/40 px-1.5 py-0.5 text-[10px] font-medium text-indigo-300">
                {projectName || projectCode}
              </span>
            )}
            {reviewProgress && (
              <span className="text-[10px] text-gray-500">
                Reviewing {reviewProgress.current} of {reviewProgress.total}
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-sm">&times;</button>
        </div>

        {/* Content — full, not truncated */}
        <div className="flex-1 overflow-y-auto space-y-3 mb-4">
          <div>
            <label className="text-[10px] text-gray-500 uppercase tracking-wider">Content</label>
            <div className="mt-1 rounded bg-gray-800/60 border border-gray-700/40 p-3 text-xs text-gray-200 whitespace-pre-wrap max-h-[40vh] overflow-y-auto">
              {item.rawContent}
            </div>
          </div>

          {/* Standard fields */}
          <div className="grid grid-cols-2 gap-3 text-[11px]">
            <div>
              <span className="text-gray-500">Submitted by:</span>
              <span className="ml-1 text-gray-300">{item.submittedBy || '(unknown)'}</span>
            </div>
            <div>
              <span className="text-gray-500">Date:</span>
              <span className="ml-1 text-gray-300">{new Date(item.submittedAt).toLocaleString()}</span>
            </div>
            {item.sourceUrl && (
              <div className="col-span-2">
                <span className="text-gray-500">Source URL:</span>
                <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" className="ml-1 text-indigo-400 hover:text-indigo-300 break-all">{item.sourceUrl}</a>
              </div>
            )}
            {item.submittedViaKey && (
              <div>
                <span className="text-gray-500">API Key:</span>
                <span className="ml-1 text-gray-300 font-mono">{item.submittedViaKey}</span>
              </div>
            )}
            {item.linkedIssueKey && (
              <div>
                <span className="text-gray-500">Linked Issue:</span>
                <a href={`/projects/${projectCode}/issues/${item.linkedIssueKey}`} className="ml-1 text-indigo-400 hover:text-indigo-300 font-mono">{item.linkedIssueKey}</a>
              </div>
            )}
          </div>

          {/* Metadata (JSON) */}
          {item.metadata && Object.keys(item.metadata).length > 0 && (
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-wider">Metadata</label>
              <pre className="mt-1 rounded bg-gray-800/60 border border-gray-700/40 p-3 text-[10px] text-gray-400 font-mono whitespace-pre-wrap overflow-x-auto max-h-40 overflow-y-auto">
                {JSON.stringify(item.metadata, null, 2)}
              </pre>
            </div>
          )}

          {/* AI Analysis */}
          {proposal && (
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-wider">AI Proposal</label>
              <div className="mt-1 rounded border border-indigo-500/30 bg-indigo-900/20 p-3 space-y-1">
                <p className="text-xs text-indigo-300 font-medium">{proposal.title}</p>
                {proposal.description && <p className="text-[10px] text-gray-400">{proposal.description}</p>}
                <div className="flex gap-1.5">
                  <span className="rounded bg-gray-700 px-1.5 py-0.5 text-[9px] font-mono text-gray-400">{proposal.type}</span>
                  <span className="rounded bg-gray-700 px-1.5 py-0.5 text-[9px] font-mono text-gray-400">{proposal.priority}</span>
                </div>
                {item.aiAnalysis?.reasoning && (
                  <p className="text-[10px] text-gray-500 italic mt-1">{item.aiAnalysis.reasoning}</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-2 pt-3 border-t border-gray-700/40">
          {isPending && (
            <>
              <button
                onClick={() => onAccept(true)}
                disabled={isMutating}
                className="rounded bg-green-700/60 px-3 py-1.5 text-xs text-green-200 hover:bg-green-700 disabled:opacity-50 transition-colors"
              >
                {isMutating ? 'Saving...' : 'Accept + Issue'}
              </button>
              <button
                onClick={() => onAccept(false)}
                disabled={isMutating}
                className="rounded bg-green-900/40 px-3 py-1.5 text-xs text-green-300 hover:bg-green-900/60 disabled:opacity-50 transition-colors"
              >
                Accept
              </button>
              <button
                onClick={onDismiss}
                disabled={isMutating}
                className="rounded bg-gray-700/50 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-700 disabled:opacity-50 transition-colors"
              >
                Dismiss
              </button>
            </>
          )}
          <button
            onClick={onClose}
            className="rounded bg-gray-800 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-700 transition-colors ml-auto"
          >
            Exit Review
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Add Feedback Modal ──────────────────────────────────────────────────────

function AddFeedbackModal({ projectCode, onClose, onCreated }: {
  projectCode: string
  onClose: () => void
  onCreated: () => void
}) {
  const [content, setContent] = useState('')
  const [sourceType, setSourceType] = useState('manual')

  const mutation = useMutation({
    mutationFn: () => createFeedback({ projectCode, rawContent: content, sourceType }),
    onSuccess: () => { onCreated(); onClose() },
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-5 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-white mb-3">Add Feedback</h3>
        <select
          value={sourceType}
          onChange={(e) => setSourceType(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 mb-2"
        >
          <option value="manual">Manual</option>
          <option value="feedback_api">API</option>
          <option value="github">GitHub</option>
          <option value="support">Support</option>
        </select>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={4}
          placeholder="Paste or type feedback..."
          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 resize-none mb-3"
          autoFocus
        />
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-3 py-1 text-xs text-gray-400 hover:text-gray-200">Cancel</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={!content.trim() || mutation.isPending}
            className="px-3 py-1 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium transition-colors"
          >
            {mutation.isPending ? 'Submitting...' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  )
}
