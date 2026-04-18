import { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useLocation } from 'react-router-dom'
import React from 'react'
import { getUniverseData, listArchivedProjects, unarchiveProject, deleteProject, listUnits, getClaudeUsageSummary, updateClaudeUsageConfig, getSubscriptionUsage, getProductivity, getIntentProductivity, getIntentInsights, backfillIntents, getBackfillCount, listAllTags } from '../../api/client'
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, AreaChart, Area, ResponsiveContainer } from 'recharts'
import type { ProductivityEntry } from '../../api/client'
import type { ProjectUniverseData, Project, ClaudeUsageSummary, ClaudeUsageConfig } from '../../types'
import { useActiveProject } from '../../contexts/ActiveProjectContext'

// ─── Persistence ──────────────────────────────────────────────────────────────

const STATE_KEY = 'vibectl-mission-control-v3'

interface MCState { tab: string; days: number; sortField?: string; sortDir?: string; tagFilter?: string; productivityTag?: string; showInactive?: boolean }

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

function ProjectsTab({ days, sortField, sortDir, onSort, tagFilter, onTagFilter, showInactive }: {
  days: number; sortField: SortField; sortDir: SortDir; onSort: (f: SortField) => void
  tagFilter: string; onTagFilter: (tag: string) => void; showInactive: boolean
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

  const handleRowClick = (projectCode: string) => {
    openProject(projectId)
    setActiveProjectId(projectId)
    if (location.pathname !== '/') navigate('/')
    setTimeout(() => {
      const el = document.querySelector(`[data-project-id="${projectCode}"]`)
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
    if (p.projectType === 'multi') parentNames[p.projectCode] = p.projectName
  }
  const sortName = (p: ProjectUniverseData) =>
    p.parentId ? `${parentNames[p.parentId] ?? ''}\0${p.projectName}` : p.projectName

  // Filter by tag and inactive
  const afterInactive = showInactive ? data : data.filter(p => !p.inactive)
  const filtered = tagFilter
    ? afterInactive.filter(p => (p.tags ?? []).includes(tagFilter))
    : afterInactive

  const sorted = [...filtered].sort((a, b) => {
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
              key={p.projectCode}
              onClick={() => handleRowClick(p.projectCode)}
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
                  const ps = projectStatuses[p.projectCode]
                  if (ps && CONNECTED_STATUSES.has(ps.terminalStatus) && ps.isActive && !ps.isWaiting) {
                    return <span className="ml-2 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-indigo-500/20 text-indigo-300 animate-pulse">working</span>
                  }
                  return null
                })()}
                {(p.tags ?? []).length > 0 && (
                  <span className="ml-1.5 inline-flex gap-0.5">
                    {(p.tags ?? []).map(tag => (
                      <button
                        key={tag}
                        onClick={(e) => { e.stopPropagation(); onTagFilter(tagFilter === tag ? '' : tag) }}
                        className={`rounded-full px-1.5 py-0 text-[9px] font-medium transition-colors ${tagFilter === tag ? 'bg-indigo-500/30 text-indigo-300' : 'bg-gray-700/50 text-gray-500 hover:text-gray-300'}`}
                      >{tag}</button>
                    ))}
                  </span>
                )}
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
                  <div key={p.projectCode} className="flex items-center justify-between text-xs">
                    <span className="text-gray-400 truncate font-mono">{p.projectCode}</span>
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

// ─── Productivity tab (Intent-oriented, high-level) ──────────────────────────

function ProductivityTab({ tagFilter, onTagFilter, days }: { tagFilter: string; onTagFilter: (tag: string) => void; days: number }) {
  const queryClient = useQueryClient()

  const { data: stats = [], isLoading } = useQuery({
    queryKey: ['intentProductivity', days],
    queryFn: () => getIntentProductivity(days),
    refetchInterval: 30_000,
  })

  const { data: _insights } = useQuery({
    queryKey: ['intentInsights', days],
    queryFn: () => getIntentInsights({ days }),
    refetchInterval: 60_000,
  })

  const [backfillStatus, setBackfillStatus] = useState<string | null>(null)
  const backfillTotalRef = useRef(0)

  const { data: backfillCountData } = useQuery({
    queryKey: ['backfillCount'],
    queryFn: getBackfillCount,
    refetchInterval: 30_000,
  })
  const backfillRemaining = backfillCountData?.remaining ?? 0

  const backfillMutation = useMutation({
    mutationFn: backfillIntents,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['intentProductivity'] })
      queryClient.invalidateQueries({ queryKey: ['intentInsights'] })
      queryClient.invalidateQueries({ queryKey: ['backfillCount'] })
      if (backfillTotalRef.current === 0) {
        backfillTotalRef.current = data.processing + data.remaining
      }
      const done = backfillTotalRef.current - data.remaining
      if (data.remaining > 0) {
        setBackfillStatus(`Backfilling ${done} of ${backfillTotalRef.current}...`)
        // Backend is synchronous — safe to continue immediately
        setTimeout(() => backfillMutation.mutate(), 500)
      } else {
        setBackfillStatus(null)
        backfillTotalRef.current = 0
      }
    },
  })

  type ProdSortField = 'project' | 'points' | 'intents' | 'tokens' | 'time'
  const [prodSort, setProdSort] = useState<ProdSortField>('project')
  const [prodSortAsc, setProdSortAsc] = useState(true)
  const handleProdSort = (field: ProdSortField) => {
    if (field === prodSort) setProdSortAsc(!prodSortAsc)
    else { setProdSort(field); setProdSortAsc(field === 'project') }
  }

  // Project tags for filtering (from the productivity stats which have project-level tags)
  type ProdStats = typeof stats[number]
  const filtered = tagFilter
    ? stats.filter((s: ProdStats) => (s.tags ?? []).includes(tagFilter))
    : stats

  // Totals
  const totalPoints = filtered.reduce((s: number, p: ProdStats) => s + p.pointsDelivered, 0)
  const totalIntents = filtered.reduce((s: number, p: ProdStats) => s + p.intentCount, 0)
  const totalTokens = filtered.reduce((s: number, p: ProdStats) => s + p.totalTokensIn + p.totalTokensOut, 0)
  const totalWallClock = filtered.reduce((s: number, p: ProdStats) => s + p.totalWallClock, 0)
  const avgCycleTime = totalIntents > 0 ? Math.round(totalWallClock / totalIntents) : 0

  // Category breakdown across all filtered projects
  const catTotals: Record<string, number> = {}
  filtered.forEach((p: ProdStats) => { for (const [cat, n] of Object.entries(p.byCategory)) catTotals[cat] = (catTotals[cat] || 0) + n })

  const formatDuration = (secs: number) => {
    if (secs < 60) return `${secs}s`
    if (secs < 3600) return `${Math.round(secs / 60)}m`
    return `${(secs / 3600).toFixed(1)}h`
  }
  const formatTokens = (n: number) => n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n)

  const categoryColors: Record<string, string> = {
    UI: 'bg-purple-500/20 text-purple-300', API: 'bg-blue-500/20 text-blue-300',
    infra: 'bg-orange-500/20 text-orange-300', data: 'bg-cyan-500/20 text-cyan-300',
    test: 'bg-green-500/20 text-green-300', docs: 'bg-gray-500/20 text-gray-300',
    bugfix: 'bg-red-500/20 text-red-300', refactor: 'bg-amber-500/20 text-amber-300',
  }

  if (isLoading) {
    return <div className="px-4 py-4 space-y-2">{[...Array(4)].map((_, i) => <div key={i} className="h-8 animate-pulse rounded bg-gray-800" />)}</div>
  }

  return (
    <div className="overflow-auto h-full">
      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-2 px-4 py-3">
        <div className="rounded-lg bg-gray-800/50 border border-gray-700/40 p-2 text-center">
          <div className="text-lg font-bold text-indigo-400">{totalPoints}</div>
          <div className="text-[9px] text-gray-500 uppercase">Points Delivered</div>
        </div>
        <div className="rounded-lg bg-gray-800/50 border border-gray-700/40 p-2 text-center">
          <div className="text-lg font-bold text-emerald-400">{totalIntents}</div>
          <div className="text-[9px] text-gray-500 uppercase">Total Intents</div>
        </div>
        <div className="rounded-lg bg-gray-800/50 border border-gray-700/40 p-2 text-center">
          <div className="text-lg font-bold text-cyan-400">{formatDuration(avgCycleTime)}</div>
          <div className="text-[9px] text-gray-500 uppercase">Avg Cycle Time</div>
        </div>
        <div className="rounded-lg bg-gray-800/50 border border-gray-700/40 p-2 text-center">
          <div className="text-lg font-bold text-gray-400">{formatTokens(totalTokens)}</div>
          <div className="text-[9px] text-gray-500 uppercase">Total Tokens</div>
        </div>
      </div>

      {/* Category breakdown pills */}
      {Object.keys(catTotals).length > 0 && (
        <div className="flex items-center gap-1.5 px-4 py-1 flex-wrap">
          {Object.entries(catTotals).sort(([,a],[,b]) => b - a).map(([cat, count]) => (
            <span key={cat} className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${categoryColors[cat] || 'bg-gray-700/50 text-gray-400'}`}>
              {cat} {count}
            </span>
          ))}
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center gap-2 px-4 py-1.5 border-b border-gray-800/50 flex-wrap">
        <div className="flex-1" />
        {(backfillRemaining > 0 || backfillStatus) && (
          <div className="ml-auto">
            <button
              onClick={() => { setBackfillStatus('Starting...'); backfillMutation.mutate() }}
              disabled={backfillMutation.isPending}
              className="text-[10px] text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
            >
              {backfillStatus || `Backfill (${backfillRemaining})`}
            </button>
          </div>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="px-4 py-6 text-center">
          <p className="text-sm text-gray-600">No productivity data yet.</p>
          <p className="text-[10px] text-gray-700 mt-1">Intents are auto-extracted when chat sessions end. Click Backfill to analyze historical sessions.</p>
        </div>
      ) : (
        <table className="w-full text-xs text-left" style={{ minWidth: '600px' }}>
          <thead className="sticky top-0 bg-gray-900 text-gray-600 uppercase tracking-wider">
            <tr className="border-b border-gray-800">
              {([['project', 'Project', ''], ['points', 'Points', 'text-right'], ['intents', 'Intents', 'text-right'], ['', 'Categories', ''], ['tokens', 'Tokens', 'text-right'], ['time', 'Time', 'text-right']] as const).map(([field, label, align]) => (
                <th
                  key={label}
                  onClick={field ? () => handleProdSort(field as ProdSortField) : undefined}
                  className={`px-3 py-1.5 font-medium ${align} ${field ? 'cursor-pointer select-none hover:text-gray-300 transition-colors' : ''} ${prodSort === field ? 'text-gray-300' : ''}`}
                >
                  {label}
                  {prodSort === field && <span className="ml-1 text-indigo-400">{prodSortAsc ? '\u25B2' : '\u25BC'}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...filtered].sort((a: ProdStats, b: ProdStats) => {
              let cmp = 0
              switch (prodSort) {
                case 'project': cmp = (a.projectName || '').localeCompare(b.projectName || ''); break
                case 'points': cmp = a.pointsDelivered - b.pointsDelivered; break
                case 'intents': cmp = a.intentCount - b.intentCount; break
                case 'tokens': cmp = (a.totalTokensIn + a.totalTokensOut) - (b.totalTokensIn + b.totalTokensOut); break
                case 'time': cmp = a.totalWallClock - b.totalWallClock; break
              }
              return prodSortAsc ? cmp : -cmp
            }).map((p: ProdStats) => (
              <tr key={p.projectCode} className="border-b border-gray-800/60 hover:bg-gray-800/40 transition-colors">
                <td className="px-3 py-2">
                  <span className="font-medium text-gray-300">{p.projectName || 'Unknown'}</span>
                  {p.projectCode && <span className="ml-1.5 text-gray-500 font-mono">({p.projectCode})</span>}
                  {(p.tags ?? []).map(tag => (
                    <button key={tag} onClick={() => onTagFilter(tagFilter === tag ? '' : tag)}
                      className={`ml-1 rounded-full px-1.5 py-0 text-[9px] font-medium ${tagFilter === tag ? 'bg-indigo-500/30 text-indigo-300' : 'bg-gray-700/50 text-gray-500 hover:text-gray-300'}`}
                    >{tag}</button>
                  ))}
                </td>
                <td className="px-3 py-2 text-right font-mono font-medium text-indigo-400">{p.pointsDelivered}</td>
                <td className="px-3 py-2 text-right font-mono text-gray-400">{p.intentCount}</td>
                <td className="px-3 py-2">
                  <div className="flex gap-0.5 flex-wrap">
                    {Object.entries(p.byCategory).sort(([,a],[,b]) => b - a).slice(0, 4).map(([cat, n]) => (
                      <span key={cat} className={`rounded px-1 py-0 text-[9px] font-medium ${categoryColors[cat] || 'bg-gray-700/50 text-gray-400'}`}>{cat} {n}</span>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 text-right font-mono text-gray-500">{formatTokens(p.totalTokensIn + p.totalTokensOut)}</td>
                <td className="px-3 py-2 text-right font-mono text-gray-500">{formatDuration(p.totalWallClock)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-gray-700">
            <tr>
              <td className="px-3 py-2 font-medium text-gray-400">Total ({filtered.length} projects)</td>
              <td className="px-3 py-2 text-right font-mono font-medium text-indigo-400">{totalPoints}</td>
              <td className="px-3 py-2 text-right font-mono text-gray-400">{totalIntents}</td>
              <td className="px-3 py-2"></td>
              <td className="px-3 py-2 text-right font-mono text-gray-500">{formatTokens(totalTokens)}</td>
              <td className="px-3 py-2 text-right font-mono text-gray-500">{formatDuration(totalWallClock)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  )
}

// ─── Code Delta tab (raw data view) ─────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function CodeDeltaTab({ tagFilter, onTagFilter: _onTagFilter, days }: { tagFilter: string; onTagFilter: (tag: string) => void; days: number }) {
  const { openProject, setActiveProjectId } = useActiveProject()
  const navigate = useNavigate()
  const location = useLocation()

  const { data: entries = [], isLoading } = useQuery({
    queryKey: ['productivity', days],
    queryFn: () => getProductivity(days),
    refetchInterval: 30_000,
  })

  const [sortBy, setSortBy] = useState<'lines' | 'bytes' | 'files' | 'prompts' | 'name'>('lines')
  const [sortAsc, setSortAsc] = useState(false)

  const filtered = tagFilter
    ? entries.filter((e: ProductivityEntry) => (e.tags ?? []).includes(tagFilter))
    : entries

  const sorted = [...filtered].sort((a: ProductivityEntry, b: ProductivityEntry) => {
    let cmp = 0
    switch (sortBy) {
      case 'lines': cmp = (a.linesAdded + a.linesRemoved) - (b.linesAdded + b.linesRemoved); break
      case 'bytes': cmp = Math.abs(a.bytesDelta) - Math.abs(b.bytesDelta); break
      case 'files': cmp = a.filesChanged - b.filesChanged; break
      case 'prompts': cmp = a.promptCount - b.promptCount; break
      case 'name': cmp = a.projectName.localeCompare(b.projectName); break
    }
    return sortAsc ? cmp : -cmp
  })

  const handleSort = (field: typeof sortBy) => {
    if (field === sortBy) setSortAsc(!sortAsc)
    else { setSortBy(field); setSortAsc(false) }
  }

  const handleRowClick = (projectCode: string) => {
    openProject(projectId)
    setActiveProjectId(projectId)
    if (location.pathname !== '/') navigate('/')
  }

  const formatNum = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
  const formatBytes = (b: number) => {
    const abs = Math.abs(b)
    if (abs >= 1048576) return `${(b / 1048576).toFixed(1)} MB`
    if (abs >= 1024) return `${(b / 1024).toFixed(1)} KB`
    return `${b} B`
  }

  if (isLoading) {
    return <div className="px-4 py-4 space-y-2">{[...Array(4)].map((_, i) => <div key={i} className="h-8 animate-pulse rounded bg-gray-800" />)}</div>
  }

  if (entries.length === 0) {
    return (
      <div className="px-4 py-6 text-center">
        <p className="text-sm text-gray-600">No productivity data yet.</p>
        <p className="text-[10px] text-gray-700 mt-1">Code deltas are captured after each prompt completion in projects with git repos.</p>
      </div>
    )
  }

  const thClass = 'px-3 py-1.5 font-medium cursor-pointer select-none whitespace-nowrap transition-colors hover:text-gray-300'

  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-xs text-left" style={{ minWidth: '500px' }}>
        <thead className="sticky top-0 bg-gray-900 text-gray-600 uppercase tracking-wider">
          <tr className="border-b border-gray-800">
            <th onClick={() => handleSort('name')} className={thClass}>Project {sortBy === 'name' && <span className="text-indigo-400">{sortAsc ? '▲' : '▼'}</span>}</th>
            <th onClick={() => handleSort('lines')} className={`${thClass} text-right`}>Lines {sortBy === 'lines' && <span className="text-indigo-400">{sortAsc ? '▲' : '▼'}</span>}</th>
            <th onClick={() => handleSort('bytes')} className={`${thClass} text-right`}>Bytes {sortBy === 'bytes' && <span className="text-indigo-400">{sortAsc ? '▲' : '▼'}</span>}</th>
            <th onClick={() => handleSort('files')} className={`${thClass} text-right`}>Files {sortBy === 'files' && <span className="text-indigo-400">{sortAsc ? '▲' : '▼'}</span>}</th>
            <th onClick={() => handleSort('prompts')} className={`${thClass} text-right`}>Prompts {sortBy === 'prompts' && <span className="text-indigo-400">{sortAsc ? '▲' : '▼'}</span>}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((e: ProductivityEntry) => (
            <tr key={e.projectCode} onClick={() => handleRowClick(e.projectCode)} className="border-b border-gray-800/60 hover:bg-gray-800/40 cursor-pointer transition-colors">
              <td className="px-3 py-2 whitespace-nowrap">
                <span className="font-medium text-gray-300">{e.projectName}</span>
                <span className="ml-1.5 text-gray-500 font-mono">({e.projectCode})</span>
                {(e.tags ?? []).map(tag => (
                  <span key={tag} className={`ml-1 rounded-full px-1.5 py-0 text-[9px] font-medium ${tagFilter === tag ? 'bg-indigo-500/30 text-indigo-300' : 'bg-gray-700/50 text-gray-500'}`}>{tag}</span>
                ))}
              </td>
              <td className="px-3 py-2 text-right font-mono">
                <span className="text-green-400">+{formatNum(e.linesAdded)}</span>
                <span className="text-gray-600 mx-0.5">/</span>
                <span className="text-red-400">-{formatNum(e.linesRemoved)}</span>
              </td>
              <td className={`px-3 py-2 text-right font-mono ${e.bytesDelta >= 0 ? 'text-green-400/70' : 'text-red-400/70'}`}>
                {e.bytesDelta >= 0 ? '+' : ''}{formatBytes(e.bytesDelta)}
              </td>
              <td className="px-3 py-2 text-right font-mono text-gray-500">{e.filesChanged}</td>
              <td className="px-3 py-2 text-right font-mono text-gray-500">{e.promptCount}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-gray-700">
          <tr>
            <td className="px-3 py-2 font-medium text-gray-400">Total ({sorted.length} projects)</td>
            <td className="px-3 py-2 text-right font-mono">
              <span className="text-green-400">+{formatNum(sorted.reduce((s: number, e: ProductivityEntry) => s + e.linesAdded, 0))}</span>
              <span className="text-gray-600 mx-0.5">/</span>
              <span className="text-red-400">-{formatNum(sorted.reduce((s: number, e: ProductivityEntry) => s + e.linesRemoved, 0))}</span>
            </td>
            <td className="px-3 py-2 text-right font-mono text-gray-500">{formatBytes(sorted.reduce((s: number, e: ProductivityEntry) => s + e.bytesDelta, 0))}</td>
            <td className="px-3 py-2 text-right font-mono text-gray-500">{sorted.reduce((s: number, e: ProductivityEntry) => s + e.filesChanged, 0)}</td>
            <td className="px-3 py-2 text-right font-mono text-gray-500">{sorted.reduce((s: number, e: ProductivityEntry) => s + e.promptCount, 0)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

// ─── Analytics tab ───────────────────────────────────────────────────────────

const CHART_COLORS = ['#818cf8', '#34d399', '#f59e0b', '#f87171', '#22d3ee', '#a78bfa', '#fb923c', '#94a3b8']
const CATEGORY_COLORS: Record<string, string> = {
  UI: '#a78bfa', API: '#60a5fa', infra: '#fb923c', data: '#22d3ee',
  test: '#34d399', docs: '#94a3b8', bugfix: '#f87171', refactor: '#fbbf24',
}

export const TIME_RANGES = [
  { label: '24h', days: 1 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: 'All', days: 365 },
]

function groupSmallSlices(data: { name: string; value: number }[], threshold = 0.05) {
  const total = data.reduce((s, d) => s + d.value, 0)
  if (total === 0) return data
  const big: typeof data = []
  let otherValue = 0
  for (const d of data) {
    if (d.value / total >= threshold) big.push(d)
    else otherValue += d.value
  }
  if (otherValue > 0) big.push({ name: 'Other', value: otherValue })
  return big
}

const RADIAN = Math.PI / 180
function renderDonutLabel({ cx, cy, midAngle, outerRadius, name, value, percent }: { cx: number; cy: number; midAngle: number; outerRadius: number; name: string; value: number; percent: number }) {
  if (percent < 0.03) return null
  const sin = Math.sin(-RADIAN * midAngle)
  const cos = Math.cos(-RADIAN * midAngle)
  const x1 = cx + (outerRadius + 6) * cos
  const y1 = cy + (outerRadius + 6) * sin
  const x2 = cx + (outerRadius + 22) * cos
  const y2 = cy + (outerRadius + 22) * sin
  const x3 = x2 + (cos >= 0 ? 6 : -6)
  const anchor = cos >= 0 ? 'start' : 'end'
  return (
    <g>
      <path d={`M${x1},${y1}L${x2},${y2}L${x3},${y2}`} stroke="#6b7280" fill="none" strokeWidth={1} />
      <text x={x3 + (cos >= 0 ? 3 : -3)} y={y2} textAnchor={anchor} fill="#d1d5db" fontSize={10} dominantBaseline="central">
        {name} ({value})
      </text>
    </g>
  )
}

function AnalyticsTab({ tagFilter, days: parentDays }: { tagFilter: string; days: number }) {
  const [customFrom, _setCustomFrom] = useState('')
  const useCustom = customFrom !== ''

  const queryParams = useCustom
    ? { since: customFrom, ...(tagFilter ? { tag: tagFilter } : {}) }
    : { days: parentDays, ...(tagFilter ? { tag: tagFilter } : {}) }

  const { data: insights, isLoading } = useQuery({
    queryKey: ['intentInsights', queryParams],
    queryFn: () => getIntentInsights(queryParams),
    refetchInterval: 60_000,
  })

  if (isLoading || !insights) {
    return <div className="px-4 py-4 space-y-2">{[...Array(3)].map((_, i) => <div key={i} className="h-24 animate-pulse rounded bg-gray-800" />)}</div>
  }

  const hasData = insights.totalIntents > 0
  const formatTokens = (n: number) => n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n)

  // 1. Points by category (donut with labels)
  const catDataRaw = Object.entries(insights.tokensByCategory)
    .map(([cat, d]) => ({ name: cat, value: d.totalPoints }))
    .sort((a, b) => b.value - a.value)
  const catData = groupSmallSlices(catDataRaw)

  // 2. Points by project (donut with labels)
  const projDataRaw = Object.entries(insights.byProject || {})
    .filter(([, d]) => d.name && d.points > 0)
    .map(([, d]) => ({ name: d.name || d.code, value: d.points }))
    .sort((a, b) => b.value - a.value)
  const projData = groupSmallSlices(projDataRaw)

  // 3. Points over time by category (stacked area)
  const dailyCat = insights.dailyByCategory || {}
  const allCats = [...new Set(Object.values(dailyCat).flatMap(d => Object.keys(d.categories)))]
  const timeData = Object.entries(dailyCat)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => {
      const row: Record<string, string | number> = { date: date.slice(5) }
      for (const cat of allCats) row[cat] = d.categories[cat] || 0
      return row
    })

  // 4. Tokens per point by category
  const effData = Object.entries(insights.tokensByCategory)
    .filter(([, d]) => d.totalPoints > 0)
    .map(([cat, d]) => ({ name: cat, tokensPerPoint: Math.round(d.totalTokens / d.totalPoints) }))
    .sort((a, b) => b.tokensPerPoint - a.tokensPerPoint)

  // 5. Delivery funnel
  const funnel = insights.funnel || {}
  const funnelTotal = Object.values(funnel).reduce((s, f) => s + f.points, 0)
  const deliveredPts = funnel.delivered?.points || 0
  const deliveryRate = funnelTotal > 0 ? Math.round((deliveredPts / funnelTotal) * 100) : 0

  if (!hasData) {
    return <div className="text-center py-12 text-gray-600 text-sm">No intent data for this time range{tagFilter ? ` and tag "${tagFilter}"` : ''}.</div>
  }

  const donutTooltipStyle = { background: '#1f2937', border: '1px solid #374151', borderRadius: '6px', fontSize: '11px' }

  return (
    <div className="overflow-auto h-full p-4 space-y-4">
      {/* Funnel stats row */}
      <div className="flex gap-3">
        <div className="rounded-lg bg-gray-800/50 border border-gray-700/40 p-2.5 flex-1 text-center">
          <div className="text-xl font-bold text-indigo-400">{deliveredPts}</div>
          <div className="text-[9px] text-gray-500 uppercase">Points Delivered</div>
        </div>
        <div className="rounded-lg bg-gray-800/50 border border-gray-700/40 p-2.5 flex-1 text-center">
          <div className="text-xl font-bold text-emerald-400">{deliveryRate}%</div>
          <div className="text-[9px] text-gray-500 uppercase">Delivery Rate</div>
        </div>
        <div className="rounded-lg bg-gray-800/50 border border-gray-700/40 p-2.5 flex-1 text-center">
          <div className="text-xl font-bold text-gray-400">{insights.totalIntents}</div>
          <div className="text-[9px] text-gray-500 uppercase">Total Intents</div>
        </div>
        {Object.entries(funnel).filter(([s]) => s !== 'delivered').map(([status, data]) => (
          <div key={status} className="rounded-lg bg-gray-800/50 border border-gray-700/40 p-2.5 flex-1 text-center">
            <div className="text-xl font-bold text-amber-400">{data.count}</div>
            <div className="text-[9px] text-gray-500 uppercase">{status}</div>
          </div>
        ))}
      </div>

      {/* Charts grid */}
      <div className="grid grid-cols-2 gap-4">
        {/* Points by category (donut with leader labels) */}
        <div className="rounded-lg bg-gray-800/30 border border-gray-700/30 p-3">
          <h3 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Points by Category</h3>
          {catData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={catData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={40} outerRadius={65} paddingAngle={2}
                  label={((props: any) => renderDonutLabel({ ...props, percent: props.value / catData.reduce((s: number, d: { value: number }) => s + d.value, 0) })) as any}
                  labelLine={false}
                >
                  {catData.map((entry) => (
                    <Cell key={entry.name} fill={CATEGORY_COLORS[entry.name] || '#94a3b8'} />
                  ))}
                </Pie>
                <Tooltip contentStyle={donutTooltipStyle} formatter={((value: number, name: string) => [`${value} pts`, name]) as any} />
              </PieChart>
            </ResponsiveContainer>
          ) : <div className="h-[220px] flex items-center justify-center text-gray-600 text-xs">No data</div>}
        </div>

        {/* Points by project (donut with leader labels) */}
        <div className="rounded-lg bg-gray-800/30 border border-gray-700/30 p-3">
          <h3 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Investment by Project</h3>
          {projData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={projData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={40} outerRadius={65} paddingAngle={2}
                  label={((props: any) => renderDonutLabel({ ...props, percent: props.value / projData.reduce((s: number, d: { value: number }) => s + d.value, 0) })) as any}
                  labelLine={false}
                >
                  {projData.map((_, i) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={donutTooltipStyle} formatter={((value: number, name: string) => [`${value} pts`, name]) as any} />
              </PieChart>
            </ResponsiveContainer>
          ) : <div className="h-[220px] flex items-center justify-center text-gray-600 text-xs">No data</div>}
        </div>

        {/* Tokens per point by category (efficiency) */}
        <div className="rounded-lg bg-gray-800/30 border border-gray-700/30 p-3">
          <h3 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Tokens per Point by Category</h3>
          {effData.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={effData} layout="vertical" margin={{ left: 50, right: 10, top: 5, bottom: 5 }}>
                <XAxis type="number" tick={{ fontSize: 10, fill: '#6b7280' }} tickFormatter={formatTokens} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#9ca3af' }} width={50} />
                <Tooltip contentStyle={donutTooltipStyle} formatter={((value: number) => [formatTokens(value), 'tokens/pt']) as any} />
                <Bar dataKey="tokensPerPoint" radius={[0, 4, 4, 0]}>
                  {effData.map((entry) => (
                    <Cell key={entry.name} fill={CATEGORY_COLORS[entry.name] || '#94a3b8'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : <div className="h-[180px] flex items-center justify-center text-gray-600 text-xs">No data</div>}
        </div>

        {/* Points over time (stacked area) */}
        <div className="rounded-lg bg-gray-800/30 border border-gray-700/30 p-3">
          <h3 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Points Over Time</h3>
          {timeData.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={timeData} margin={{ left: 0, right: 10, top: 5, bottom: 5 }}>
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#6b7280' }} />
                <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} />
                <Tooltip contentStyle={donutTooltipStyle} />
                {allCats.map((cat, i) => (
                  <Area key={cat} type="monotone" dataKey={cat} stackId="1" fill={CATEGORY_COLORS[cat] || CHART_COLORS[i % CHART_COLORS.length]} stroke={CATEGORY_COLORS[cat] || CHART_COLORS[i % CHART_COLORS.length]} fillOpacity={0.6} />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          ) : <div className="h-[180px] flex items-center justify-center text-gray-600 text-xs">No data</div>}
        </div>
      </div>
    </div>
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
  if (error) return <div className="mx-4 mt-3 mb-2 text-[10px] text-red-400/60">Subscription usage unavailable: {(error as Error).message}</div>
  if (!usage) return null

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

type Tab = 'projects' | 'archived' | 'usage' | 'productivity' | 'analytics'

const PERIOD_OPTIONS: { label: string; days: number }[] = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '60d', days: 60 },
  { label: '90d', days: 90 },
  { label: '365d', days: 365 },
]

export default function MissionControl() {
  const [state, setState] = useState(loadState)

  // Global tag filter — shared across Projects, Productivity, and Analytics tabs
  const { data: allProjectTags = [] } = useQuery({
    queryKey: ['allProjectTags'],
    queryFn: listAllTags,
    refetchInterval: 30_000,
  })

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
    { key: 'productivity', label: 'Productivity' },
    { key: 'analytics', label: 'Analytics' },
    { key: 'usage', label: 'Usage' },
    { key: 'archived', label: 'Archived' },
  ]

  return (
    <div className="bg-gray-900 border border-gray-700/60 rounded-lg overflow-hidden h-full flex flex-col">
      {/* Header — drag handle for grid repositioning */}
      <div className="drag-handle flex items-center gap-1 px-4 py-2 border-b border-gray-700/60 shrink-0 cursor-grab select-none flex-wrap">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider mr-2">Mission Control</span>
        {tabs.map(t => (
          <button
            key={t.key}
            onMouseDown={e => e.stopPropagation()}
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
        <div className="flex items-center gap-1 ml-auto" onMouseDown={e => e.stopPropagation()}>
          {allProjectTags.length > 0 && (
            <>
              <button
                onClick={() => updateState({ tagFilter: '' })}
                className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer ${!state.tagFilter ? 'bg-indigo-600/30 text-indigo-300' : 'text-gray-500 hover:text-gray-300'}`}
              >All</button>
              {allProjectTags.map((tag: string) => (
                <button
                  key={tag}
                  onClick={() => updateState({ tagFilter: state.tagFilter === tag ? '' : tag })}
                  className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer ${state.tagFilter === tag ? 'bg-indigo-600/30 text-indigo-300' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'}`}
                >{tag}</button>
              ))}
              {['projects', 'productivity', 'analytics'].includes(state.tab) && (
                <span className="text-gray-700 mx-0.5">|</span>
              )}
            </>
          )}
          <button
            onClick={() => updateState({ showInactive: !state.showInactive })}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer ${state.showInactive ? 'bg-gray-600/30 text-gray-300' : 'text-gray-600 hover:text-gray-400'}`}
          >{state.showInactive ? 'Hiding inactive' : 'Show inactive'}</button>
          <span className="text-gray-700 mx-0.5">|</span>
          {['projects', 'productivity', 'analytics'].includes(state.tab) && PERIOD_OPTIONS.map(({ label, days }) => (
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
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {state.tab === 'projects' && <ProjectsTab days={state.days} sortField={sortField} sortDir={sortDir} onSort={handleSort} tagFilter={state.tagFilter || ''} onTagFilter={(tag) => updateState({ tagFilter: tag })} showInactive={!!state.showInactive} />}
        {state.tab === 'productivity' && <ProductivityTab tagFilter={state.tagFilter || ''} onTagFilter={(tag) => updateState({ tagFilter: tag })} days={state.days} />}
        {state.tab === 'analytics' && <AnalyticsTab tagFilter={state.tagFilter || ''} days={state.days} />}
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
