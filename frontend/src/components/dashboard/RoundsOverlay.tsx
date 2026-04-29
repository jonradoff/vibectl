import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getRoundContext, recordRound, upsertProjectNote, snoozeProject, updateProject } from '../../api/client'
import { useActiveProject } from '../../contexts/ActiveProjectContext'
import type { RoundProjectContext, RoundAction } from '../../types'

const healthColors: Record<string, string> = {
  up: 'bg-green-500', degraded: 'bg-amber-500', down: 'bg-red-500', unknown: 'bg-gray-600', none: 'bg-gray-700',
}

const categoryColors: Record<string, string> = {
  UI: 'text-purple-400', API: 'text-blue-400', infra: 'text-orange-400', data: 'text-cyan-400',
  test: 'text-green-400', docs: 'text-gray-400', bugfix: 'text-red-400', refactor: 'text-amber-400',
}

function timeAgo(iso?: string): string {
  if (!iso) return 'never'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

interface RoundsOverlayProps {
  onClose: () => void
}

export default function RoundsOverlay({ onClose }: RoundsOverlayProps) {
  const queryClient = useQueryClient()
  const { openProject, setActiveProjectId } = useActiveProject()
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const [currentIndex, setCurrentIndex] = useState(0)
  const [actions, setActions] = useState<RoundAction[]>([])
  const [inputText, setInputText] = useState('')
  const [inputMode, setInputMode] = useState<'prompt' | 'note'>('prompt')
  const [showSnooze, setShowSnooze] = useState(false)
  const [startedAt] = useState(() => new Date().toISOString())
  const [completed, setCompleted] = useState(false)
  const [snoozedThisRound, setSnoozedThisRound] = useState<Set<string>>(new Set())
  const [editingStatus, setEditingStatus] = useState(false)
  const [statusText, setStatusText] = useState('')

  const { data: allProjects = [], isLoading } = useQuery({
    queryKey: ['roundContext'],
    queryFn: getRoundContext,
    staleTime: 30_000,
  })

  // Filter and sort projects for the round
  const projects = allProjects
    .filter(p => !p.paused && !p.inactive)
    .filter(p => !snoozedThisRound.has(p.projectCode))
    .filter(p => !p.snoozedUntil || new Date(p.snoozedUntil) <= new Date())
    .sort((a, b) => {
      // Actionable items first
      const aScore = (a.pendingFeedbackCount > 0 ? 10 : 0) + (a.openIssueCount > 0 ? 5 : 0) + (a.currentHealth === 'down' ? 20 : 0) + (a.acceptedUnsubmitted > 0 ? 8 : 0)
      const bScore = (b.pendingFeedbackCount > 0 ? 10 : 0) + (b.openIssueCount > 0 ? 5 : 0) + (b.currentHealth === 'down' ? 20 : 0) + (b.acceptedUnsubmitted > 0 ? 8 : 0)
      if (aScore !== bScore) return bScore - aScore
      // Then by most recent activity
      const aTime = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0
      const bTime = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0
      return bTime - aTime
    })

  const current = projects[currentIndex] as RoundProjectContext | undefined

  const noteMutation = useMutation({
    mutationFn: ({ code, text }: { code: string; text: string }) => upsertProjectNote(code, text),
  })

  const snoozeMutation = useMutation({
    mutationFn: ({ id, until, reason }: { id: string; until: string; reason?: string }) => snoozeProject(id, until, reason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['roundContext'] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })

  const statusMutation = useMutation({
    mutationFn: ({ id, statusNote }: { id: string; statusNote: string }) =>
      updateProject(id, { statusNote } as Record<string, unknown>),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['roundContext'] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['globalDashboard'] })
    },
  })

  const recordMutation = useMutation({
    mutationFn: () => recordRound({
      projectsVisited: currentIndex,
      projectsTotal: projects.length,
      actions,
      startedAt,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['roundContext'] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['globalDashboard'] })
    },
  })

  const advance = useCallback((action: RoundAction) => {
    setActions(prev => [...prev, action])
    setInputText('')
    setInputMode('prompt')
    setShowSnooze(false)
    setEditingStatus(false)
    const nextIdx = currentIndex + 1
    if (nextIdx >= projects.length) {
      setCompleted(true)
      recordMutation.mutate()
    } else {
      setCurrentIndex(nextIdx)
    }
  }, [currentIndex, projects.length, recordMutation])

  const handleSendPrompt = useCallback(() => {
    if (!current || !inputText.trim()) return
    // Set the project card to terminal tab and dispatch prompt
    localStorage.setItem(`vibectl-card-tab-${current.projectId}`, 'terminal')
    openProject(current.projectId)
    setActiveProjectId(current.projectId)
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('vibectl:send-to-project', {
        detail: { projectCode: current.projectId, text: inputText.trim() },
      }))
    }, 300)
    advance({ projectCode: current.projectCode, action: 'prompt' })
  }, [current, inputText, openProject, setActiveProjectId, advance])

  const handleSaveNote = useCallback(() => {
    if (!current || !inputText.trim()) return
    noteMutation.mutate({ code: current.projectCode, text: inputText.trim() })
    advance({ projectCode: current.projectCode, action: 'note' })
  }, [current, inputText, noteMutation, advance])

  const handleSnooze = useCallback((days: number) => {
    if (!current) return
    const until = new Date()
    until.setDate(until.getDate() + days)
    setSnoozedThisRound(prev => new Set(prev).add(current.projectCode))
    snoozeMutation.mutate({ id: current.projectId, until: until.toISOString(), reason: `Snoozed for ${days} day${days > 1 ? 's' : ''}` })
    advance({ projectCode: current.projectCode, action: 'snooze' })
  }, [current, snoozeMutation, advance])

  const handleSkip = useCallback(() => {
    if (!current) return
    advance({ projectCode: current.projectCode, action: 'skip' })
  }, [current, advance])

  const handleExit = useCallback(() => {
    if (currentIndex > 0 && !completed) {
      recordMutation.mutate()
    }
    onClose()
  }, [currentIndex, completed, recordMutation, onClose])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't capture when typing in textarea
      const isTyping = document.activeElement === inputRef.current

      if (e.key === 'Escape') {
        if (showSnooze) {
          setShowSnooze(false)
        } else {
          handleExit()
        }
        return
      }

      if (completed) return

      if (e.key === 'Enter' && !e.shiftKey && isTyping && inputText.trim()) {
        e.preventDefault()
        if (inputMode === 'note') handleSaveNote()
        else handleSendPrompt()
        return
      }

      if (isTyping) return

      if (e.key === 's' || e.key === 'ArrowRight') {
        handleSkip()
      } else if (e.key === 'n') {
        setInputMode('note')
        inputRef.current?.focus()
      } else if (e.key === 'z') {
        setShowSnooze(prev => !prev)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [inputText, inputMode, showSnooze, completed, handleSkip, handleSendPrompt, handleSaveNote, handleExit])

  // Auto-focus input on project change
  useEffect(() => {
    if (!completed && !isLoading) {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [currentIndex, completed, isLoading])

  if (isLoading) {
    return createPortal(
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80">
        <div className="text-gray-400 text-sm">Loading round context...</div>
      </div>,
      document.body,
    )
  }

  if (projects.length === 0) {
    return createPortal(
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80">
        <div className="bg-gray-900 border border-gray-700 rounded-xl p-8 max-w-sm text-center">
          <p className="text-gray-300 mb-4">No active projects to review.</p>
          <button onClick={onClose} className="px-4 py-2 bg-gray-700 text-gray-300 rounded hover:bg-gray-600 text-sm">Close</button>
        </div>
      </div>,
      document.body,
    )
  }

  // Round completion summary
  if (completed) {
    const promptCount = actions.filter(a => a.action === 'prompt').length
    const noteCount = actions.filter(a => a.action === 'note').length
    const snoozeCount = actions.filter(a => a.action === 'snooze').length
    const skipCount = actions.filter(a => a.action === 'skip').length

    return createPortal(
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80">
        <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-md w-full">
          <h2 className="text-lg font-bold text-white mb-4">Round Complete</h2>
          <p className="text-sm text-gray-400 mb-4">
            Visited {actions.length} of {projects.length} projects
          </p>
          <div className="grid grid-cols-2 gap-3 mb-6">
            {promptCount > 0 && (
              <div className="rounded bg-indigo-900/30 border border-indigo-700/30 p-3 text-center">
                <div className="text-lg font-bold text-indigo-400">{promptCount}</div>
                <div className="text-[10px] text-gray-500">Prompts sent</div>
              </div>
            )}
            {noteCount > 0 && (
              <div className="rounded bg-cyan-900/30 border border-cyan-700/30 p-3 text-center">
                <div className="text-lg font-bold text-cyan-400">{noteCount}</div>
                <div className="text-[10px] text-gray-500">Notes saved</div>
              </div>
            )}
            {snoozeCount > 0 && (
              <div className="rounded bg-amber-900/30 border border-amber-700/30 p-3 text-center">
                <div className="text-lg font-bold text-amber-400">{snoozeCount}</div>
                <div className="text-[10px] text-gray-500">Snoozed</div>
              </div>
            )}
            {skipCount > 0 && (
              <div className="rounded bg-gray-800 border border-gray-700/30 p-3 text-center">
                <div className="text-lg font-bold text-gray-400">{skipCount}</div>
                <div className="text-[10px] text-gray-500">Skipped</div>
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="w-full px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-500 text-sm font-medium"
          >
            Back to Dashboard
          </button>
        </div>
      </div>,
      document.body,
    )
  }

  // Main step-through view
  const p = current!
  const hasP0P1 = (p.issuesByPriority?.P0 || 0) + (p.issuesByPriority?.P1 || 0) > 0

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80">
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl max-w-2xl w-full max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header with progress */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700/50">
          <div className="flex items-center gap-3">
            {/* Progress dots */}
            <div className="flex gap-1">
              {projects.map((_, i) => (
                <div
                  key={i}
                  className={`w-2 h-2 rounded-full transition-colors ${
                    i < currentIndex ? 'bg-indigo-500' : i === currentIndex ? 'bg-white' : 'bg-gray-700'
                  }`}
                />
              ))}
            </div>
            <span className="text-xs text-gray-500">
              Project {currentIndex + 1} of {projects.length}
            </span>
          </div>
          <button onClick={handleExit} className="text-gray-500 hover:text-gray-300 text-sm">&times; Exit</button>
        </div>

        {/* Project context card */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Project header */}
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-white">{p.projectName}</h2>
              <span className="text-xs text-gray-500 font-mono">{p.projectCode}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className={`w-2.5 h-2.5 rounded-full ${healthColors[p.currentHealth] || 'bg-gray-700'}`} title={p.currentHealth} />
              <span className="text-[10px] text-gray-500">{p.currentHealth}</span>
            </div>
          </div>

          {/* Status note */}
          {editingStatus ? (
            <div className="flex gap-2">
              <input
                type="text"
                value={statusText}
                onChange={e => setStatusText(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    statusMutation.mutate({ id: p.projectId, statusNote: statusText })
                    setEditingStatus(false)
                  } else if (e.key === 'Escape') {
                    setEditingStatus(false)
                  }
                }}
                placeholder="Set project status (e.g., Blocked until WebSDK publishes)..."
                autoFocus
                className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-indigo-500"
              />
              <button
                onClick={() => { statusMutation.mutate({ id: p.projectId, statusNote: statusText }); setEditingStatus(false) }}
                className="px-2 py-1.5 bg-indigo-600 text-white text-xs rounded hover:bg-indigo-500"
              >Save</button>
              <button
                onClick={() => setEditingStatus(false)}
                className="px-2 py-1.5 text-gray-500 text-xs hover:text-gray-300"
              >Cancel</button>
            </div>
          ) : p.statusNote ? (
            <button
              onClick={() => { setStatusText(p.statusNote); setEditingStatus(true) }}
              className={`w-full text-left rounded px-3 py-2 text-xs hover:opacity-80 transition-opacity ${
                /blocked|waiting|stuck/i.test(p.statusNote)
                  ? 'bg-amber-900/30 border border-amber-700/40 text-amber-200'
                  : 'bg-gray-800 border border-gray-700/40 text-gray-300'
              }`}
            >
              {p.statusNote}
              <span className="ml-2 text-[9px] text-gray-600">(click to edit)</span>
            </button>
          ) : (
            <button
              onClick={() => { setStatusText(''); setEditingStatus(true) }}
              className="text-[10px] text-gray-600 hover:text-gray-400 transition-colors"
            >
              + Set project status
            </button>
          )}

          {/* Goals */}
          {p.goals && p.goals.length > 0 && (
            <div className="text-xs text-gray-400">
              <span className="text-gray-600">Goals: </span>
              {p.goals.join(' · ')}
            </div>
          )}

          {/* Alert badges */}
          <div className="flex flex-wrap gap-2">
            {p.openIssueCount > 0 && (
              <div className={`rounded px-2.5 py-1.5 text-xs ${hasP0P1 ? 'bg-red-900/30 border border-red-700/40 text-red-300' : 'bg-gray-800 border border-gray-700/40 text-gray-300'}`}>
                {p.openIssueCount} open issue{p.openIssueCount !== 1 ? 's' : ''}
                {hasP0P1 && <span className="ml-1 text-red-400 font-medium">({(p.issuesByPriority?.P0 || 0) + (p.issuesByPriority?.P1 || 0)} critical)</span>}
              </div>
            )}
            {p.pendingFeedbackCount > 0 && (
              <div className="rounded bg-amber-900/30 border border-amber-700/40 px-2.5 py-1.5 text-xs text-amber-300">
                {p.pendingFeedbackCount} pending feedback
              </div>
            )}
            {p.acceptedUnsubmitted > 0 && (
              <div className="rounded bg-green-900/30 border border-green-700/40 px-2.5 py-1.5 text-xs text-green-300">
                {p.acceptedUnsubmitted} ready for prompt
              </div>
            )}
            {p.currentHealth === 'down' && (
              <div className="rounded bg-red-900/30 border border-red-700/40 px-2.5 py-1.5 text-xs text-red-300">
                Health: down
              </div>
            )}
            {p.currentHealth === 'degraded' && (
              <div className="rounded bg-amber-900/30 border border-amber-700/40 px-2.5 py-1.5 text-xs text-amber-300">
                Health: degraded
              </div>
            )}
          </div>

          {/* Recent intents */}
          {p.recentIntents.length > 0 && (
            <div>
              <label className="text-[10px] text-gray-600 uppercase tracking-wider">Last worked on</label>
              <div className="mt-1 space-y-1">
                {p.recentIntents.map((intent, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className={categoryColors[intent.category] || 'text-gray-400'}>{intent.category}</span>
                    <span className="text-gray-300 truncate">{intent.title}</span>
                    <span className="text-gray-600 ml-auto shrink-0">{intent.status} · {timeAgo(intent.completedAt)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Last session + activity */}
          <div className="flex gap-4 text-[10px] text-gray-600">
            {p.lastSessionAt && (
              <span>Last session: {timeAgo(p.lastSessionAt)} ({p.lastSessionMsgs || 0} messages)</span>
            )}
            <span>Last prompt: {timeAgo(p.lastPromptAt)}</span>
            <span>Last activity: {timeAgo(p.lastActivityAt)}</span>
          </div>

          {/* Note from last round */}
          {p.note && (
            <div className="rounded bg-cyan-900/20 border border-cyan-700/30 p-3">
              <label className="text-[10px] text-cyan-600 uppercase tracking-wider">Note from last round</label>
              <p className="mt-1 text-xs text-cyan-200 whitespace-pre-wrap">{p.note.text}</p>
            </div>
          )}
        </div>

        {/* Input area */}
        <div className="px-5 py-3 border-t border-gray-700/50 space-y-2">
          <div className="flex items-center gap-2 mb-1">
            <button
              onClick={() => setInputMode('prompt')}
              className={`text-[10px] font-medium px-2 py-0.5 rounded transition-colors ${inputMode === 'prompt' ? 'bg-indigo-600/30 text-indigo-300' : 'text-gray-500 hover:text-gray-300'}`}
            >Prompt</button>
            <button
              onClick={() => setInputMode('note')}
              className={`text-[10px] font-medium px-2 py-0.5 rounded transition-colors ${inputMode === 'note' ? 'bg-cyan-600/30 text-cyan-300' : 'text-gray-500 hover:text-gray-300'}`}
            >Note</button>
          </div>
          <textarea
            ref={inputRef}
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            placeholder={inputMode === 'note' ? 'Save a note for next round...' : "What's next? Type a prompt for Claude Code..."}
            rows={2}
            className="w-full resize-none rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:border-indigo-500 focus:outline-none"
          />

          {/* Snooze picker */}
          {showSnooze && (
            <div className="flex gap-2">
              {[
                { label: '1 day', days: 1 },
                { label: '3 days', days: 3 },
                { label: '1 week', days: 7 },
                { label: '2 weeks', days: 14 },
              ].map(opt => (
                <button
                  key={opt.days}
                  onClick={() => handleSnooze(opt.days)}
                  className="px-3 py-1.5 bg-amber-900/30 border border-amber-700/40 text-amber-300 text-xs rounded hover:bg-amber-900/50 transition-colors"
                >
                  {opt.label}
                </button>
              ))}
              <button
                onClick={() => setShowSnooze(false)}
                className="px-2 py-1.5 text-xs text-gray-500 hover:text-gray-300"
              >Cancel</button>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleSendPrompt}
              disabled={!inputText.trim() || inputMode !== 'prompt'}
              className="px-3 py-1.5 bg-indigo-600 text-white text-xs font-medium rounded hover:bg-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Send Prompt
            </button>
            <button
              onClick={handleSaveNote}
              disabled={!inputText.trim() || inputMode !== 'note'}
              className="px-3 py-1.5 bg-cyan-700/50 text-cyan-200 text-xs rounded hover:bg-cyan-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Save Note
            </button>
            <button
              onClick={() => setShowSnooze(!showSnooze)}
              className="px-3 py-1.5 bg-amber-900/30 text-amber-300 text-xs rounded hover:bg-amber-900/50 transition-colors"
            >
              Snooze
            </button>
            <button
              onClick={handleSkip}
              className="px-3 py-1.5 bg-gray-700/50 text-gray-400 text-xs rounded hover:bg-gray-700 transition-colors ml-auto"
            >
              Skip &rarr;
            </button>
          </div>

          {/* Keyboard hints */}
          <div className="text-[9px] text-gray-600 text-center">
            <kbd className="text-gray-500">Enter</kbd> send/save &middot;{' '}
            <kbd className="text-gray-500">s</kbd> skip &middot;{' '}
            <kbd className="text-gray-500">n</kbd> note &middot;{' '}
            <kbd className="text-gray-500">z</kbd> snooze &middot;{' '}
            <kbd className="text-gray-500">Esc</kbd> exit
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
