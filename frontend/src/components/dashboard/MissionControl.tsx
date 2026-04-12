import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useLocation } from 'react-router-dom'
import { getUniverseData, listArchivedProjects, unarchiveProject, deleteProject, listUnits, getClaudeUsageSummary, updateClaudeUsageConfig, getSubscriptionUsage } from '../../api/client'
import type { SubscriptionUsage } from '../../api/client'
import type { ProjectUniverseData, Project, ClaudeUsageSummary, ClaudeUsageConfig } from '../../types'
import { useActiveProject } from '../../contexts/ActiveProjectContext'

// ─── Persistence ──────────────────────────────────────────────────────────────

const STATE_KEY = 'vibectl-mission-control-v3'

interface MCState { tab: string; days: number; sortField?: string; sortDir?: string }

function loadState(): MCState {
  try {
    const raw = localStorage.getItem(STATE_KEY)
    return raw ? JSON.parse(raw) : { tab: 'projects', days: 30 }
  } catch {
    return { tab: 'projects', days: 30 }
  }
}

function saveState(s: MCState) { localStorage.setItem(STATE_KEY, JSON.stringify(s)) }

// ─── Health helpers ────────────────────────────────────────────────────────────

const healthColor: Record<string, string> = {
  up: '#22c55e', degraded: '#f59e0b', down: '#ef4444', unknown: '#374151', none: '#1f2937',
}
const healthBg: Record<string, string> = {
  up: 'bg-green-500', degraded: 'bg-amber-500', down: 'bg-red-500', unknown: 'bg-gray-600', none: 'bg-gray-700',
}
const healthPriority: Record<string, number> = {
  up: 4, degraded: 3, down: 2, unknown: 1, none: 0,
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Sparkline({ values, height = 22 }: { values: number[]; height?: number }) {
  if (!values.length || values.every((v) => v === 0)) {
    return <span className="text-gray-700 text-xs font-mono">—</span>
  }
  const max = Math.max(...values, 1)
  const pts = values.map((v, i) => {
    const x = (i / Math.max(values.length - 1, 1)) * 100
    const y = height - (v / max) * height
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" height={height} className="w-full overflow-visible">
      <polyline points={pts.join(' ')} fill="none" stroke="#818cf8" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function HealthPixels({ days }: { days: string[] }) {
  return (
    <div className="flex gap-px items-center">
      {days.map((d, i) => (
        <div key={i} title={d} style={{ backgroundColor: healthColor[d] ?? healthColor.unknown }} className="w-2 h-4 rounded-sm" />
      ))}
    </div>
  )
}

// ─── Time helpers ─────────────────────────────────────────────────────────────

function formatTimeAgo(iso?: string): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

// ─── Sort types ───────────────────────────────────────────────────────────────

type SortField = 'name' | 'activity' | 'health' | 'issues' | 'feedback' | 'prompts' | 'lastPrompt' | 'status'
type SortDir = 'asc' | 'desc'

const DEFAULT_DIR: Record<SortField, SortDir> = {
  name: 'asc', activity: 'desc', health: 'desc', issues: 'desc',
  feedback: 'desc', prompts: 'desc', lastPrompt: 'asc', status: 'desc',
}

function SortTh({
  field, label, current, dir, align = 'left', compact, onClick,
}: {
  field: SortField; label: React.ReactNode; current: SortField; dir: SortDir
  align?: 'left' | 'right'; compact?: boolean; onClick: (f: SortField) => void
}) {
  const active = field === current
  return (
    <th
      onClick={() => onClick(field)}
      className={`${compact ? 'px-2' : 'px-4'} py-2 font-medium cursor-pointer select-none whitespace-nowrap transition-colors hover:text-gray-300 ${active ? 'text-gray-300' : ''} ${align === 'right' ? 'text-right' : ''}`}
    >
      {label}
      {active && <span className="ml-1 text-indigo-400">{dir === 'asc' ? '▲' : '▼'}</span>}
    </th>
  )
}

// ─── Projects tab ─────────────────────────────────────────────────────────────

const CONNECTED_STATUSES = new Set(['started', 'running', 'connecting', 'connected', 'reconnected', 'restarted'])

function ProjectsTab({ days, sortField, sortDir, onSort }: {
  days: number; sortField: SortField; sortDir: SortDir; onSort: (f: SortField) => void
}) {
  const { openProject, setActiveProjectId, projectStatuses } = useActiveProject()
  const navigate = useNavigate()
  const location = useLocation()

  const { data = [], isLoading } = useQuery({
    queryKey: ['universeData', days],
    queryFn: () => getUniverseData(days),
    staleTime: 60_000,
    refetchInterval: 120_000,
  })

  const handleSort = onSort

  const handleRowClick = (projectId: string) => {
    openProject(projectId)
    setActiveProjectId(projectId)
    if (location.pathname !== '/') navigate('/')
    setTimeout(() => {
      const el = document.querySelector(`[data-project-id="${projectId}"]`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 100)
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-1 px-4 py-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="w-1 h-8 bg-gray-800 rounded animate-pulse" style={{ animationDelay: `${i * 0.1}s` }} />
        ))}
      </div>
    )
  }

  if (data.length === 0) {
    return <div className="px-4 py-6 text-center text-gray-600 text-sm">No projects yet</div>
  }

  // Build parent name lookup for modules
  const parentNames: Record<string, string> = {}
  for (const p of data) {
    if (p.projectType === 'multi') parentNames[p.projectId] = p.projectName
  }
  const sortName = (p: ProjectUniverseData) =>
    p.parentId ? `${parentNames[p.parentId] ?? ''}\0${p.projectName}` : p.projectName

  const sorted = [...data].sort((a, b) => {
    let cmp = 0
    switch (sortField) {
      case 'name':
        cmp = sortName(a).localeCompare(sortName(b), undefined, { sensitivity: 'base' })
        break
      case 'activity':
        cmp = a.activityByDay.reduce((s, v) => s + v, 0) - b.activityByDay.reduce((s, v) => s + v, 0)
        break
      case 'health':
      case 'status':
        cmp = (healthPriority[a.currentHealth] ?? 0) - (healthPriority[b.currentHealth] ?? 0)
        break
      case 'issues':
        cmp = a.openIssueCount - b.openIssueCount
        break
      case 'feedback':
        cmp = a.pendingFeedbackCount - b.pendingFeedbackCount
        break
      case 'prompts':
        cmp = a.promptCount - b.promptCount
        break
      case 'lastPrompt':
        cmp = (a.lastPromptAt ?? '').localeCompare(b.lastPromptAt ?? '')
        break
    }
    return sortDir === 'asc' ? cmp : -cmp
  })

  const thProps = { current: sortField, dir: sortDir, onClick: handleSort }

  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-xs text-left" style={{ minWidth: '640px' }}>
        <thead className="sticky top-0 bg-gray-900 text-gray-600 uppercase tracking-wider">
          <tr className="border-b border-gray-800">
            <SortTh field="name"     label="Project"             {...thProps} />
            <SortTh field="status"   label="●" compact             {...thProps} />
            <SortTh field="activity" label={`Activity (${days}d)`} {...thProps} />
            <SortTh field="health"   label="Health (24h)"        {...thProps} />
            <SortTh field="issues"   label="Issues"              align="right" {...thProps} />
            <SortTh field="feedback" label="Feedback"            align="right" {...thProps} />
            <SortTh field="prompts"  label="Prompts"             align="right" {...thProps} />
            <SortTh field="lastPrompt" label="Last Prompt"        align="right" {...thProps} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((p: ProjectUniverseData) => (
            <tr
              key={p.projectId}
              onClick={() => handleRowClick(p.projectId)}
              className="border-b border-gray-800/60 hover:bg-gray-800/40 cursor-pointer transition-colors"
            >
              <td className="px-4 py-2.5 whitespace-nowrap">
                {p.parentId && parentNames[p.parentId] && (
                  <span className="inline-flex items-center gap-1 mr-1.5 text-[10px] font-semibold text-purple-300/70">
                    <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 7.125C2.25 6.504 2.754 6 3.375 6h6c.621 0 1.125.504 1.125 1.125v3.75c0 .621-.504 1.125-1.125 1.125h-6a1.125 1.125 0 0 1-1.125-1.125v-3.75ZM14.25 8.625c0-.621.504-1.125 1.125-1.125h5.25c.621 0 1.125.504 1.125 1.125v8.25c0 .621-.504 1.125-1.125 1.125h-5.25a1.125 1.125 0 0 1-1.125-1.125v-8.25ZM3.75 16.125c0-.621.504-1.125 1.125-1.125h5.25c.621 0 1.125.504 1.125 1.125v2.25c0 .621-.504 1.125-1.125 1.125h-5.25a1.125 1.125 0 0 1-1.125-1.125v-2.25Z" />
                    </svg>
                    {parentNames[p.parentId]}
                    <span className="text-gray-600">/</span>
                  </span>
                )}
                <span className="font-medium text-gray-300">{p.projectName}</span>
                <span className="ml-1.5 text-gray-500 font-mono">({p.projectCode})</span>
                {p.projectType === 'multi' && (
                  <span className="ml-1.5 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-purple-500/20 text-purple-300">orchestrator</span>
                )}
                {(() => {
                  const ps = projectStatuses[p.projectId]
                  if (ps && CONNECTED_STATUSES.has(ps.terminalStatus) && ps.isActive && !ps.isWaiting) {
                    return <span className="ml-2 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-indigo-500/20 text-indigo-300 animate-pulse">working</span>
                  }
                  return null
                })()}
              </td>
              <td className="px-2 py-2.5">
                <span className={`inline-block w-2.5 h-2.5 rounded-full ${healthBg[p.currentHealth] ?? 'bg-gray-600'}`} />
              </td>
              <td className="px-4 py-2.5">
                <Sparkline values={p.activityByDay} height={22} />
              </td>
              <td className="px-4 py-2.5">
                <HealthPixels days={p.healthByDay} />
              </td>
              <td className="px-4 py-2.5 text-right font-mono">
                <span className={p.openIssueCount > 0 ? 'text-amber-400' : 'text-gray-600'}>{p.openIssueCount}</span>
              </td>
              <td className="px-4 py-2.5 text-right font-mono">
                <span className={p.pendingFeedbackCount > 0 ? 'text-yellow-400' : 'text-gray-600'}>{p.pendingFeedbackCount}</span>
              </td>
              <td className="px-4 py-2.5 text-right font-mono text-gray-500">{p.promptCount}</td>
              <td className="px-4 py-2.5 text-right font-mono text-gray-500 whitespace-nowrap">{formatTimeAgo(p.lastPromptAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Archived tab ─────────────────────────────────────────────────────────────

function ArchivedTab() {
  const queryClient = useQueryClient()
  const [confirmDelete, setConfirmDelete] = useState<Project | null>(null)

  const { data: projects, isLoading, error } = useQuery({
    queryKey: ['archivedProjects'],
    queryFn: listArchivedProjects,
  })

  const unarchiveMutation = useMutation({
    mutationFn: (id: string) => unarchiveProject(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['archivedProjects'] })
      queryClient.invalidateQueries({ queryKey: ['globalDashboard'] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteProject(id),
    onSuccess: () => {
      setConfirmDelete(null)
      queryClient.invalidateQueries({ queryKey: ['archivedProjects'] })
    },
  })

  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        {[...Array(3)].map((_, i) => <div key={i} className="h-10 animate-pulse rounded bg-gray-800" />)}
      </div>
    )
  }

  if (error) {
    return <div className="px-4 py-4 text-xs text-red-400">Failed to load: {(error as Error).message}</div>
  }

  if (!projects || projects.length === 0) {
    return <div className="px-4 py-6 text-center text-gray-600 text-sm">No archived projects.</div>
  }

  return (
    <>
      <div className="overflow-auto h-full">
        <div className="divide-y divide-gray-800/60" style={{ minWidth: '480px' }}>
          {projects.map((project) => (
            <div key={project.id} className="flex items-center justify-between px-4 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-gray-300">{project.name}</span>
                  <span className="text-[10px] font-mono text-gray-500">({project.code})</span>
                </div>
                {project.description && <p className="text-[10px] text-gray-600 truncate">{project.description}</p>}
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-4">
                <button
                  onClick={() => unarchiveMutation.mutate(project.id)}
                  disabled={unarchiveMutation.isPending}
                  className="rounded bg-indigo-600/70 px-2.5 py-1 text-[10px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
                >
                  Restore
                </button>
                <button
                  onClick={() => setConfirmDelete(project)}
                  className="rounded border border-red-800/50 bg-red-900/20 px-2.5 py-1 text-[10px] font-medium text-red-400 hover:bg-red-900/40 transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {confirmDelete && (
        <DeleteConfirmModal
          project={confirmDelete}
          isPending={deleteMutation.isPending}
          error={deleteMutation.isError ? (deleteMutation.error instanceof Error ? deleteMutation.error.message : 'Failed to delete') : undefined}
          onCancel={() => { setConfirmDelete(null); deleteMutation.reset() }}
          onConfirm={() => deleteMutation.mutate(confirmDelete.id)}
        />
      )}
    </>
  )
}

// ─── Usage helpers ────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function timeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now()
  if (diff <= 0) return 'now'
  const hrs = Math.floor(diff / 3_600_000)
  const mins = Math.floor((diff % 3_600_000) / 60_000)
  if (hrs >= 24) {
    const days = Math.floor(hrs / 24)
    return `${days}d ${hrs % 24}h`
  }
  return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`
}

function usageColorClass(pct: number, thr: number): string {
  if (pct >= 90) return 'text-red-400'
  if (pct >= thr) return 'text-amber-400'
  return 'text-green-400'
}

function barColorClass(pct: number, thr: number): string {
  if (pct >= 90) return 'bg-red-500'
  if (pct >= thr) return 'bg-amber-500'
  return 'bg-green-500'
}

function barBgClass(pct: number, thr: number): string {
  if (pct >= 90) return 'bg-red-500/10'
  if (pct >= thr) return 'bg-amber-500/10'
  return 'bg-green-500/10'
}

function DailyBars({ days }: { days: { date: string; totalTokens: number }[] }) {
  const max = Math.max(...days.map(d => d.totalTokens), 1)
  return (
    <div className="flex items-end gap-px h-8">
      {days.map((d, i) => {
        const h = Math.max(2, (d.totalTokens / max) * 100)
        const dayName = new Date(d.date + 'T00:00:00Z').toLocaleDateString('en', { weekday: 'short' })
        return (
          <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
            <div className="w-full rounded-sm bg-indigo-500/60" style={{ height: `${h}%` }} title={`${dayName}: ${formatTokens(d.totalTokens)}`} />
            <span className="text-[8px] text-gray-600">{dayName.charAt(0)}</span>
          </div>
        )
      })}
    </div>
  )
}

// ─── Usage detail modal ──────────────────────────────────────────────────────

function UsageDetailModal({ summary, onClose, onConfigSave }: {
  summary: ClaudeUsageSummary
  onClose: () => void
  onConfigSave: (cfg: ClaudeUsageConfig) => void
}) {
  const [showConfig, setShowConfig] = useState(false)
  const [label, setLabel] = useState(summary.loginLabel || '')
  const [limit, setLimit] = useState(summary.weeklyTokenLimit > 0 ? String(summary.weeklyTokenLimit) : '')
  const [threshold, setThreshold] = useState(String(summary.alertThreshold || 70))

  const handleSave = () => {
    onConfigSave({
      tokenHash: summary.tokenHash,
      loginLabel: label.trim(),
      weeklyTokenLimit: parseInt(limit) || 0,
      alertThreshold: parseInt(threshold) || 70,
    })
    setShowConfig(false)
  }

  const pct = summary.usagePercent
  const thr = summary.alertThreshold || 70

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl bg-gray-900 border border-gray-700 shadow-2xl flex flex-col max-h-[85vh]" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div>
            <h3 className="text-sm font-semibold text-white">
              Claude Usage {summary.loginLabel ? `\u2014 ${summary.loginLabel}` : ''}
            </h3>
            <p className="text-[10px] text-gray-500 mt-0.5 font-mono">ID: {summary.tokenHash.substring(0, 12)}...</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowConfig(v => !v)} className="rounded-lg bg-gray-700 hover:bg-gray-600 px-2.5 py-1 text-[10px] font-medium text-gray-300 transition-colors">
              {showConfig ? 'Cancel' : 'Configure'}
            </button>
            <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors text-lg leading-none">x</button>
          </div>
        </div>

        {/* Config section */}
        {showConfig && (
          <div className="px-5 py-3 border-b border-gray-800 bg-gray-800/50 space-y-2">
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Label</label>
                <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Jon's Max"
                  className="w-full rounded border border-gray-600 bg-gray-700 px-2 py-1 text-xs text-gray-100 focus:border-indigo-500 focus:outline-none" />
              </div>
              <div>
                <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Weekly limit</label>
                <input value={limit} onChange={e => setLimit(e.target.value)} placeholder="50000000"
                  className="w-full rounded border border-gray-600 bg-gray-700 px-2 py-1 text-xs font-mono text-gray-100 focus:border-indigo-500 focus:outline-none" />
              </div>
              <div>
                <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Alert %</label>
                <input value={threshold} onChange={e => setThreshold(e.target.value)} placeholder="70"
                  className="w-full rounded border border-gray-600 bg-gray-700 px-2 py-1 text-xs font-mono text-gray-100 focus:border-indigo-500 focus:outline-none" />
              </div>
            </div>
            <div className="flex justify-end">
              <button onClick={handleSave} className="rounded bg-indigo-600 hover:bg-indigo-500 px-3 py-1 text-[10px] font-medium text-white transition-colors">Save</button>
            </div>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 min-h-0">
          {/* Overall progress */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-gray-400">Weekly usage</span>
              <span className={`text-xs font-mono font-semibold ${usageColorClass(pct, thr)}`}>
                {summary.weeklyTokenLimit > 0
                  ? `${pct.toFixed(1)}% \u2014 ${formatTokens(summary.totalTokens)} / ${formatTokens(summary.weeklyTokenLimit)}`
                  : `${formatTokens(summary.totalTokens)} tokens`}
              </span>
            </div>
            {summary.weeklyTokenLimit > 0 && (
              <div className={`h-3 rounded-full ${barBgClass(pct, thr)} overflow-hidden`}>
                <div className={`h-full rounded-full transition-all duration-500 ${barColorClass(pct, thr)}`} style={{ width: `${Math.min(pct, 100)}%` }} />
              </div>
            )}
            <div className="flex justify-between mt-1">
              <span className="text-[10px] text-gray-600">Resets in {timeUntil(summary.weekResetsAt)}</span>
              <span className="text-[10px] text-gray-600">Week started {new Date(summary.weekStartedAt).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
            </div>
          </div>

          {/* Token breakdown */}
          <div className="grid grid-cols-2 gap-3">
            {[
              ['Input', summary.totalInputTokens],
              ['Output', summary.totalOutputTokens],
              ['Cache read', summary.totalCacheRead],
              ['Cache creation', summary.totalCacheCreation],
            ].map(([label, val]) => (
              <div key={label as string} className="rounded-lg border border-gray-800 bg-gray-800/30 px-3 py-2">
                <span className="text-[10px] text-gray-500 uppercase tracking-wider">{label as string}</span>
                <p className="text-sm font-mono text-gray-200 mt-0.5">{formatTokens(val as number)}</p>
              </div>
            ))}
          </div>

          {/* Daily bars */}
          {summary.dailyUsage?.length > 0 && (
            <div>
              <h4 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">This week</h4>
              <DailyBars days={summary.dailyUsage} />
            </div>
          )}

          {/* By model */}
          {summary.byModel?.length > 0 && (
            <div>
              <h4 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">By model</h4>
              <div className="space-y-1.5">
                {summary.byModel.map(m => (
                  <div key={m.model} className="flex items-center justify-between text-xs">
                    <span className="font-mono text-gray-400 truncate">{m.model || 'unknown'}</span>
                    <span className="font-mono text-gray-300 shrink-0 ml-2">{formatTokens(m.totalTokens)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* By project */}
          {summary.byProject?.length > 0 && (
            <div>
              <h4 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">By project</h4>
              <div className="space-y-1.5">
                {summary.byProject.sort((a, b) => b.totalTokens - a.totalTokens).map(p => (
                  <div key={p.projectId} className="flex items-center justify-between text-xs">
                    <span className="text-gray-400 truncate font-mono">{p.projectId}</span>
                    <span className="font-mono text-gray-300 shrink-0 ml-2">{formatTokens(p.totalTokens)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* No limit hint */}
          {summary.weeklyTokenLimit === 0 && (
            <div className="rounded-lg border border-amber-700/30 bg-amber-900/10 px-3 py-2">
              <p className="text-xs text-amber-300">No weekly limit configured. Click <span className="font-medium">Configure</span> to set your plan's weekly token cap.</p>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

// ─── Usage tab ───────────────────────────────────────────────────────────────

function SubscriptionUsageCard() {
  const { data: usage, isLoading, error } = useQuery({
    queryKey: ['subscriptionUsage'],
    queryFn: getSubscriptionUsage,
    refetchInterval: 300_000, // 5 min — endpoint is rate-limited
    staleTime: 120_000,
    retry: 1,
  })

  if (isLoading) return <div className="h-16 animate-pulse rounded bg-gray-800 mx-4 mt-3 mb-2" />
  if (error || !usage) return null

  const formatReset = (iso: string) => {
    const d = new Date(iso)
    const now = new Date()
    const diffMs = d.getTime() - now.getTime()
    if (diffMs <= 0) return 'now'
    const diffHrs = Math.floor(diffMs / 3600000)
    const diffMin = Math.floor((diffMs % 3600000) / 60000)
    if (diffHrs > 24) return `${Math.floor(diffHrs / 24)}d ${diffHrs % 24}h`
    if (diffHrs > 0) return `${diffHrs}h ${diffMin}m`
    return `${diffMin}m`
  }

  const barColor = (pct: number) =>
    pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-cyan-500'

  const buckets = [
    { label: 'Session (5h)', data: usage.fiveHour },
    { label: 'Weekly (7d)', data: usage.sevenDay },
    ...(usage.sevenDaySonnet ? [{ label: 'Sonnet', data: usage.sevenDaySonnet }] : []),
    ...(usage.sevenDayOpus ? [{ label: 'Opus', data: usage.sevenDayOpus }] : []),
  ].filter(b => b.data)

  return (
    <div className="mx-4 mt-3 mb-2 rounded-lg border border-gray-700/50 bg-gray-800/40 p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Subscription</span>
        <span className="text-[10px] text-cyan-400 font-medium">{usage.subscriptionType}</span>
      </div>
      <div className="space-y-1.5">
        {buckets.map(({ label, data }) => (
          <div key={label} className="flex items-center gap-2">
            <span className="text-[10px] text-gray-500 w-16 shrink-0">{label}</span>
            <div className="flex-1 bg-gray-700/50 rounded-full h-2 overflow-hidden">
              <div className={`h-full rounded-full transition-all ${barColor(data!.utilization)}`} style={{ width: `${Math.min(data!.utilization, 100)}%` }} />
            </div>
            <span className={`text-[10px] font-mono w-8 text-right ${data!.utilization >= 90 ? 'text-red-400' : data!.utilization >= 70 ? 'text-amber-400' : 'text-gray-400'}`}>
              {data!.utilization}%
            </span>
            <span className="text-[9px] text-gray-600 w-12 text-right">{formatReset(data!.resetsAt)}</span>
          </div>
        ))}
      </div>
      {usage.extraUsage?.isEnabled && (
        <div className="mt-1.5 text-[9px] text-gray-600">
          Extra usage: ${usage.extraUsage.usedCredits.toFixed(2)}{usage.extraUsage.monthlyLimit ? ` / $${usage.extraUsage.monthlyLimit}` : ''}
        </div>
      )}
    </div>
  )
}

function UsageTab() {
  const [selectedHash, setSelectedHash] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const { data: summaries = [], isLoading } = useQuery({
    queryKey: ['claudeUsage'],
    queryFn: getClaudeUsageSummary,
    refetchInterval: 30_000,
    staleTime: 15_000,
  })

  const configMutation = useMutation({
    mutationFn: updateClaudeUsageConfig,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['claudeUsage'] }),
  })

  const selected = summaries.find(s => s.tokenHash === selectedHash)

  if (isLoading) {
    return (
      <div className="px-4 py-4 space-y-2">
        {[...Array(2)].map((_, i) => <div key={i} className="h-10 animate-pulse rounded bg-gray-800" />)}
      </div>
    )
  }

  if (summaries.length === 0) {
    return (
      <div className="px-4 py-6 text-center">
        <p className="text-sm text-gray-600">No usage data yet.</p>
        <p className="text-[10px] text-gray-700 mt-1">Usage tracking begins when Claude Code sessions run.</p>
      </div>
    )
  }

  return (
    <div className="overflow-auto h-full">
      <SubscriptionUsageCard />
      <table className="w-full text-xs text-left" style={{ minWidth: '480px' }}>
        <thead className="sticky top-0 bg-gray-900 text-gray-600 uppercase tracking-wider">
          <tr className="border-b border-gray-800">
            <th className="px-4 py-2 font-medium">Login</th>
            <th className="px-4 py-2 font-medium">Usage</th>
            <th className="px-4 py-2 font-medium text-right">Tokens</th>
            <th className="px-4 py-2 font-medium text-right">Resets</th>
          </tr>
        </thead>
        <tbody>
          {summaries.map(s => {
            const pct = s.usagePercent
            const thr = s.alertThreshold || 70
            const hasLimit = s.weeklyTokenLimit > 0
            return (
              <tr
                key={s.tokenHash}
                onClick={() => setSelectedHash(s.tokenHash)}
                className="border-b border-gray-800/60 hover:bg-gray-800/40 cursor-pointer transition-colors"
              >
                <td className="px-4 py-2.5 whitespace-nowrap">
                  <span className="font-medium text-gray-300">{s.loginLabel || `Login ${s.tokenHash.substring(0, 8)}`}</span>
                </td>
                <td className="px-4 py-2.5" style={{ minWidth: '140px' }}>
                  {hasLimit ? (
                    <div className="flex items-center gap-2">
                      <div className={`flex-1 h-1.5 rounded-full ${barBgClass(pct, thr)} overflow-hidden`}>
                        <div className={`h-full rounded-full ${barColorClass(pct, thr)} transition-all duration-500`} style={{ width: `${Math.min(pct, 100)}%` }} />
                      </div>
                      <span className={`text-[10px] font-mono font-semibold shrink-0 ${usageColorClass(pct, thr)} ${pct >= thr ? 'animate-pulse' : ''}`}>
                        {pct.toFixed(0)}%
                      </span>
                    </div>
                  ) : (
                    <span className="text-[10px] text-gray-600 font-mono">no limit set</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-gray-400">
                  {formatTokens(s.totalTokens)}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-gray-500 whitespace-nowrap">
                  {timeUntil(s.weekResetsAt)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {selected && (
        <UsageDetailModal
          summary={selected}
          onClose={() => setSelectedHash(null)}
          onConfigSave={cfg => configMutation.mutate(cfg)}
        />
      )}
    </div>
  )
}

// ─── Main component ────────────────────────────────────────────────────────────

type Tab = 'projects' | 'archived' | 'usage'

const PERIOD_OPTIONS: { label: string; days: number }[] = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '60d', days: 60 },
  { label: '90d', days: 90 },
  { label: '365d', days: 365 },
]

export default function MissionControl() {
  const [state, setState] = useState(loadState)

  // Subscription usage alert — badge on Usage tab when any bucket >= 75%
  const { data: subUsage } = useQuery({
    queryKey: ['subscriptionUsage'],
    queryFn: getSubscriptionUsage,
    refetchInterval: 300_000,
    staleTime: 120_000,
    retry: 1,
  })
  const usageAlertLevel = (() => {
    if (!subUsage) return 0
    const pcts = [subUsage.fiveHour, subUsage.sevenDay, subUsage.sevenDaySonnet, subUsage.sevenDayOpus]
      .filter((b): b is NonNullable<typeof b> => b != null)
      .map(b => b.utilization)
    const maxPct = Math.max(0, ...pcts)
    if (maxPct >= 90) return 2 // red
    if (maxPct >= 75) return 1 // amber
    return 0
  })()

  const sortField = (state.sortField as SortField) || 'name'
  const sortDir = (state.sortDir as SortDir) || 'asc'

  const updateState = (patch: Partial<MCState>) => {
    setState(prev => {
      const next = { ...prev, ...patch }
      saveState(next)
      return next
    })
  }

  const handleSort = (field: SortField) => {
    if (field === sortField) {
      updateState({ sortDir: sortDir === 'asc' ? 'desc' : 'asc' })
    } else {
      updateState({ sortField: field, sortDir: DEFAULT_DIR[field] })
    }
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'projects', label: 'Projects' },
    { key: 'usage', label: 'Usage' },
    { key: 'archived', label: 'Archived' },
  ]

  return (
    <div className="bg-gray-900 border border-gray-700/60 rounded-lg overflow-hidden h-full flex flex-col">
      {/* Header — drag handle for grid repositioning */}
      <div className="drag-handle flex items-center justify-between px-4 py-2 border-b border-gray-700/60 shrink-0 cursor-grab select-none">
        <div className="flex items-center gap-1">
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider mr-3">Mission Control</span>
          {tabs.map(t => (
            <button
              key={t.key}
              onMouseDown={e => e.stopPropagation()} // prevent drag when clicking tabs
              onClick={() => updateState({ tab: t.key })}
              className={`px-2.5 py-0.5 rounded text-xs font-medium transition-colors cursor-pointer ${
                state.tab === t.key ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {t.label}
              {t.key === 'usage' && usageAlertLevel > 0 && (
                <span className={`ml-1 inline-block w-2 h-2 rounded-full ${usageAlertLevel >= 2 ? 'bg-red-500 animate-pulse' : 'bg-amber-500'}`} />
              )}
            </button>
          ))}
        </div>

        {state.tab === 'projects' && (
          <div className="flex items-center gap-0.5" onMouseDown={e => e.stopPropagation()}>
            {PERIOD_OPTIONS.map(({ label, days }) => (
              <button
                key={days}
                onClick={() => updateState({ days })}
                className={`px-2 py-0.5 rounded text-xs font-mono transition-colors cursor-pointer ${
                  state.days === days ? 'bg-indigo-700/60 text-indigo-200' : 'text-gray-600 hover:text-gray-400'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {state.tab === 'projects' && <ProjectsTab days={state.days} sortField={sortField} sortDir={sortDir} onSort={handleSort} />}
        {state.tab === 'usage' && <UsageTab />}
        {state.tab === 'archived' && <ArchivedTab />}
      </div>
    </div>
  )
}

// ─── Delete confirmation with dependent units advisory ───────────────────────

function DeleteConfirmModal({ project, isPending, error, onCancel, onConfirm }: {
  project: Project; isPending: boolean; error?: string; onCancel: () => void; onConfirm: () => void
}) {
  const isMulti = project.projectType === 'multi'
  const { data: units = [] } = useQuery({
    queryKey: ['units', project.id],
    queryFn: () => listUnits(project.id),
    enabled: isMulti,
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-md rounded-xl bg-gray-800 shadow-2xl border border-gray-700">
        <div className="px-6 pt-6 pb-4">
          <h3 className="text-sm font-semibold text-white mb-1">Permanently delete project?</h3>
          <p className="text-xs text-gray-400 mb-3">
            This will permanently delete <span className="font-medium text-gray-200">{project.name}</span> and{' '}
            <span className="font-medium text-red-400">all of its issues</span>. This cannot be undone.
          </p>
          {isMulti && units.length > 0 && (
            <div className="rounded-lg border border-amber-700/50 bg-amber-900/10 px-3 py-2 mb-3">
              <p className="text-xs text-amber-300 font-medium mb-1">This is a multi-module orchestrator with {units.length} dependent module{units.length > 1 ? 's' : ''}:</p>
              <ul className="text-[10px] text-amber-200/70 space-y-0.5">
                {units.map(u => (
                  <li key={u.id}>{u.unitName || u.name} ({u.code})</li>
                ))}
              </ul>
              <p className="text-[10px] text-amber-200/50 mt-1.5">
                Deleting this project does not delete the modules. You will need to delete each module individually if desired.
              </p>
            </div>
          )}
          {error && (
            <p className="mt-3 text-xs text-red-400">{error}</p>
          )}
        </div>
        <div className="flex justify-end gap-2 px-6 pb-5">
          <button
            onClick={onCancel}
            disabled={isPending}
            className="rounded-lg px-4 py-2 text-xs text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isPending}
            className="rounded-lg bg-red-700 hover:bg-red-600 px-4 py-2 text-xs font-medium text-white transition-colors disabled:opacity-75"
          >
            {isPending ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </div>
  )
}
