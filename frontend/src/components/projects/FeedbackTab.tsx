import { useState } from 'react'
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
    onSuccess: invalidate,
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
          className="rounded bg-indigo-600/80 px-2 py-1 text-[10px] font-medium text-white hover:bg-indigo-500 transition-colors"
        >
          + Add Feedback
        </button>
        {pending.length > 0 && (
          <button
            onClick={() => triageBatchMutation.mutate()}
            disabled={triageBatchMutation.isPending}
            className="rounded bg-gray-700 px-2 py-1 text-[10px] font-medium text-gray-300 hover:bg-gray-600 transition-colors disabled:opacity-50"
          >
            {triageBatchMutation.isPending ? 'Triaging…' : `AI Triage All (${pending.length})`}
          </button>
        )}
        {selectedIds.size > 0 && (
          <>
            <span className="text-[10px] text-gray-400">{selectedIds.size} selected</span>
            <button
              onClick={() => handleBulkAction('accept')}
              disabled={bulkMutation.isPending}
              className="rounded bg-green-700/60 px-2 py-1 text-[10px] text-green-300 hover:bg-green-700 transition-colors disabled:opacity-50"
            >
              Accept All
            </button>
            <button
              onClick={() => handleBulkAction('dismiss')}
              disabled={bulkMutation.isPending}
              className="rounded bg-gray-600/60 px-2 py-1 text-[10px] text-gray-300 hover:bg-gray-600 transition-colors disabled:opacity-50"
            >
              Dismiss All
            </button>
          </>
        )}
        <span className="ml-auto text-[10px] text-gray-500">
          {items.length} total
        </span>
      </div>

      {/* Three columns */}
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
                  onAccept={(createIssue) => reviewMutation.mutate({ id: item.id, action: 'accept', createIssue })}
                  onDismiss={() => reviewMutation.mutate({ id: item.id, action: 'dismiss' })}
                  onTriage={() => triageMutation.mutate(item.id)}
                  isTriaging={triageMutation.isPending && triageMutation.variables === item.id}
                  isMutating={reviewMutation.isPending && (reviewMutation.variables as { id: string })?.id === item.id}
                  projectCode={projectCode}
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
                <FeedbackRow
                  key={item.id}
                  item={item}
                  projectCode={projectCode}
                />
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
                <FeedbackRow
                  key={item.id}
                  item={item}
                  projectCode={projectCode}
                />
              ))
            )}
          </div>
        </div>
      </div>

      {showAdd && (
        <AddFeedbackModal
          projectId={projectId}
          onClose={() => setShowAdd(false)}
          onCreated={invalidate}
        />
      )}
    </div>
  )
}

interface FeedbackRowProps {
  item: FeedbackItem
  projectCode: string
  selected?: boolean
  onToggle?: () => void
  onAccept?: (createIssue: boolean) => void
  onDismiss?: () => void
  onTriage?: () => void
  isTriaging?: boolean
  isMutating?: boolean
}

function FeedbackRow({
  item,
  projectCode,
  selected,
  onToggle,
  onAccept,
  onDismiss,
  onTriage,
  isTriaging,
  isMutating,
}: FeedbackRowProps) {
  const [expanded, setExpanded] = useState(false)
  const isTriaged = item.triageStatus === 'triaged'
  const proposal = item.aiAnalysis?.proposedIssue

  return (
    <div
      className={`border-b border-gray-700/30 text-xs transition-colors ${
        selected ? 'bg-indigo-900/20' : 'hover:bg-gray-700/20'
      }`}
    >
      <div className="flex items-start gap-1.5 px-2 py-1.5">
        {onToggle && (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            className="mt-0.5 shrink-0 accent-indigo-500"
          />
        )}
        <div className="flex-1 min-w-0">
          {/* Source + submitter row */}
          <div className="flex items-center gap-1 text-[10px] text-gray-500 mb-0.5">
            <span className="rounded bg-gray-700 px-1 font-mono">{item.sourceType}</span>
            {item.submittedBy && <span>{item.submittedBy}</span>}
            <span className="ml-auto">{new Date(item.submittedAt).toLocaleDateString()}</span>
          </div>

          {/* Content */}
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-left w-full text-gray-200"
          >
            <p className={`whitespace-pre-wrap ${expanded ? '' : 'line-clamp-2'}`}>
              {item.rawContent}
            </p>
          </button>

          {/* AI proposal — show when triaged */}
          {isTriaged && proposal && (
            <div className="mt-1 rounded border border-indigo-500/30 bg-indigo-900/20 px-2 py-1 space-y-0.5">
              <p className="text-[10px] text-indigo-300 font-medium">{proposal.title}</p>
              <div className="flex gap-1 flex-wrap">
                <span className="rounded bg-gray-700 px-1 text-[9px] font-mono text-gray-400">{proposal.type}</span>
                <span className="rounded bg-gray-700 px-1 text-[9px] font-mono text-gray-400">{proposal.priority}</span>
              </div>
            </div>
          )}

          {/* Linked issue */}
          {item.linkedIssueKey && (
            <a
              href={`/projects/${projectCode}/issues/${item.linkedIssueKey}`}
              className="inline-block mt-0.5 text-[10px] text-indigo-400 hover:text-indigo-300 font-mono"
              onClick={(e) => e.stopPropagation()}
            >
              → {item.linkedIssueKey}
            </a>
          )}
        </div>
      </div>

      {/* Actions */}
      {(onAccept || onDismiss || onTriage) && (
        <div className="flex gap-1 px-2 pb-1.5">
          {!isTriaged && onTriage && (
            <button
              onClick={onTriage}
              disabled={isTriaging}
              className="rounded bg-indigo-700/50 px-1.5 py-0.5 text-[9px] text-indigo-300 hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {isTriaging ? '…' : 'AI Triage'}
            </button>
          )}
          {onAccept && (
            <>
              <button
                onClick={() => onAccept(true)}
                disabled={isMutating}
                className="rounded bg-green-700/60 px-1.5 py-0.5 text-[9px] text-green-300 hover:bg-green-700 disabled:opacity-50 transition-colors"
                title="Accept and create issue"
              >
                {isMutating ? '…' : '✓ + Issue'}
              </button>
              <button
                onClick={() => onAccept(false)}
                disabled={isMutating}
                className="rounded bg-green-900/40 px-1.5 py-0.5 text-[9px] text-green-400 hover:bg-green-900/60 disabled:opacity-50 transition-colors"
                title="Accept without creating issue"
              >
                ✓
              </button>
            </>
          )}
          {onDismiss && (
            <button
              onClick={onDismiss}
              disabled={isMutating}
              className="rounded bg-gray-700/50 px-1.5 py-0.5 text-[9px] text-gray-400 hover:bg-gray-700 disabled:opacity-50 transition-colors"
            >
              ✕
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function AddFeedbackModal({ projectId, onClose, onCreated }: {
  projectId: string
  onClose: () => void
  onCreated: () => void
}) {
  const [content, setContent] = useState('')
  const [sourceType, setSourceType] = useState('manual')

  const mutation = useMutation({
    mutationFn: () => createFeedback({ projectId, rawContent: content, sourceType }),
    onSuccess: () => { onCreated(); onClose() },
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-gray-800 rounded-lg border border-gray-700 w-full max-w-lg mx-4 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold text-white mb-3">Add Feedback</h2>
        <div className="space-y-3">
          <div>
            <label className="block text-[10px] font-medium text-gray-400 mb-1">Source</label>
            <select
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value)}
              className="w-full rounded border border-gray-600 bg-gray-700 px-2 py-1 text-xs text-gray-200 focus:border-indigo-500 focus:outline-none"
            >
              {['manual', 'github', 'slack', 'email', 'user-report', 'other'].map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-medium text-gray-400 mb-1">Feedback *</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={5}
              autoFocus
              placeholder="Describe the issue, feature request, or observation..."
              className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-200 focus:border-indigo-500 focus:outline-none resize-y"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending || !content.trim()}
              className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {mutation.isPending ? 'Submitting…' : 'Submit'}
            </button>
            <button
              onClick={onClose}
              className="rounded bg-gray-700 px-4 py-1.5 text-sm font-medium text-gray-300 hover:bg-gray-600"
            >
              Cancel
            </button>
            {mutation.isError && (
              <span className="text-xs text-red-400">Failed to submit</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
