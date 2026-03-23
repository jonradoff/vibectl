import { useState, useRef, useEffect, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getUniverseData } from '../../api/client'
import type { ProjectUniverseData } from '../../types'

// ─── Persistence ────────────────────────────────────────────────────────────

const UNIVERSE_STATE_KEY = 'vibectl-universe-state-v1'

interface UniverseState {
  activeTab: number
  panelHeight: number
}

function loadState(): UniverseState {
  try {
    const raw = localStorage.getItem(UNIVERSE_STATE_KEY)
    if (raw) return JSON.parse(raw) as UniverseState
  } catch { /* ignore */ }
  return { activeTab: 0, panelHeight: 260 }
}

function saveState(s: UniverseState) {
  localStorage.setItem(UNIVERSE_STATE_KEY, JSON.stringify(s))
}

// ─── Health colour helpers ───────────────────────────────────────────────────

const healthColor: Record<string, string> = {
  up: '#22c55e',
  degraded: '#f59e0b',
  down: '#ef4444',
  unknown: '#374151',
  none: '#1f2937',
}

const healthBg: Record<string, string> = {
  up: 'bg-green-500',
  degraded: 'bg-amber-500',
  down: 'bg-red-500',
  unknown: 'bg-gray-600',
  none: 'bg-gray-700',
}

// ─── Sparkline SVG ───────────────────────────────────────────────────────────

function Sparkline({
  values,
  width = 80,
  height = 24,
  color = '#6366f1',
}: {
  values: number[]
  width?: number
  height?: number
  color?: string
}) {
  if (!values.length) return <span className="text-gray-600 text-xs">—</span>
  const max = Math.max(...values, 1)
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width
    const y = height - (v / max) * height
    return `${x},${y}`
  })
  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

// ─── Health pixel row ────────────────────────────────────────────────────────

function HealthPixels({ days }: { days: string[] }) {
  return (
    <div className="flex gap-px items-center">
      {days.map((d, i) => (
        <div
          key={i}
          title={d}
          style={{ backgroundColor: healthColor[d] ?? healthColor.unknown }}
          className="w-2 h-4 rounded-sm"
        />
      ))}
    </div>
  )
}

// ─── Tab 1: Sparkline Table ──────────────────────────────────────────────────

function SparklineTable({ data }: { data: ProjectUniverseData[] }) {
  if (!data.length) return <EmptyState />
  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-xs text-left">
        <thead>
          <tr className="border-b border-gray-700 text-gray-500 uppercase tracking-wider">
            <th className="pb-2 pr-4 font-medium">Project</th>
            <th className="pb-2 pr-6 font-medium">Activity (90d)</th>
            <th className="pb-2 pr-4 font-medium">Health (7d)</th>
            <th className="pb-2 pr-4 font-medium text-right">Issues</th>
            <th className="pb-2 pr-4 font-medium text-right">Feedback</th>
            <th className="pb-2 pr-4 font-medium text-right">Deploys</th>
            <th className="pb-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {data.map((p) => (
            <tr key={p.projectId} className="border-b border-gray-800 hover:bg-gray-800/30">
              <td className="py-2 pr-4">
                <span className="font-mono text-gray-300 font-medium">{p.projectCode}</span>
                <span className="ml-2 text-gray-500 truncate max-w-[120px] inline-block align-bottom">
                  {p.projectName}
                </span>
              </td>
              <td className="py-2 pr-6">
                <Sparkline values={p.activityByDay} width={90} height={22} color="#818cf8" />
              </td>
              <td className="py-2 pr-4">
                <HealthPixels days={p.healthByDay} />
              </td>
              <td className="py-2 pr-4 text-right font-mono">
                <span className={p.openIssueCount > 0 ? 'text-amber-400' : 'text-gray-500'}>
                  {p.openIssueCount}
                </span>
              </td>
              <td className="py-2 pr-4 text-right font-mono">
                <span className={p.pendingFeedbackCount > 0 ? 'text-yellow-400' : 'text-gray-500'}>
                  {p.pendingFeedbackCount}
                </span>
              </td>
              <td className="py-2 pr-4 text-right font-mono text-gray-400">
                {p.deployCount}
              </td>
              <td className="py-2">
                <span className={`inline-block w-2.5 h-2.5 rounded-full ${healthBg[p.currentHealth] ?? 'bg-gray-600'}`} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Tab 2: Minard Bands ─────────────────────────────────────────────────────
// One horizontal band per project. Width = time (90 days), thickness encodes
// activity volume, fill colour encodes health status.

function MinardBands({ data }: { data: ProjectUniverseData[] }) {
  if (!data.length) return <EmptyState />

  const maxActivity = Math.max(...data.flatMap((p) => p.activityByDay), 1)

  return (
    <div className="space-y-1 overflow-auto h-full pr-2">
      {data.map((p) => {
        const days = p.activityByDay
        const totalBands = days.length || 90

        return (
          <div key={p.projectId} className="flex items-center gap-3">
            {/* Label */}
            <div className="w-16 text-right flex-shrink-0">
              <span className="text-xs font-mono text-gray-400">{p.projectCode}</span>
            </div>

            {/* Band */}
            <div className="flex-1 flex items-end" style={{ height: 28 }}>
              {days.map((count, i) => {
                const heightPct = Math.max(0.08, count / maxActivity)
                const barH = Math.round(heightPct * 28)
                // Get health color for this day if available
                const healthIdx = Math.round((i / totalBands) * (p.healthByDay.length - 1))
                const hStatus = p.healthByDay[healthIdx] ?? 'unknown'
                const col = healthColor[hStatus] ?? healthColor.unknown
                return (
                  <div
                    key={i}
                    style={{
                      height: barH,
                      backgroundColor: count > 0 ? col : '#1f2937',
                      opacity: count > 0 ? 0.7 + (count / maxActivity) * 0.3 : 0.3,
                      flex: 1,
                    }}
                    title={`Day ${i + 1}: ${count} events`}
                  />
                )
              })}
            </div>

            {/* Tail info */}
            <div className="flex-shrink-0 flex items-center gap-2">
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 ${healthBg[p.currentHealth] ?? 'bg-gray-600'}`}
              />
              <span className="text-xs font-mono text-gray-500 w-4 text-right">
                {p.openIssueCount > 0 ? p.openIssueCount : ''}
              </span>
            </div>
          </div>
        )
      })}

      {/* Time axis */}
      <div className="flex items-center gap-3 pt-1">
        <div className="w-16" />
        <div className="flex-1 flex justify-between text-gray-600 text-xs font-mono">
          <span>90d ago</span>
          <span>today</span>
        </div>
        <div className="w-12" />
      </div>
    </div>
  )
}

// ─── Tab 3: Annotated Timeline ───────────────────────────────────────────────
// Shared x-axis (90 days), one lane per project, event ticks for activity spikes.

function AnnotatedTimeline({ data }: { data: ProjectUniverseData[] }) {
  if (!data.length) return <EmptyState />

  const LANE_H = 28
  const maxActivity = Math.max(...data.flatMap((p) => p.activityByDay), 1)
  const DAYS = 90

  return (
    <div className="overflow-auto h-full">
      {/* Axis labels */}
      <div className="flex mb-1 pl-20 pr-4 text-xs text-gray-600 font-mono justify-between">
        <span>90d ago</span>
        <span>60d</span>
        <span>30d</span>
        <span>today</span>
      </div>

      <div className="space-y-px">
        {data.map((p) => {
          const days = p.activityByDay
          const activityThreshold = maxActivity * 0.35

          return (
            <div key={p.projectId} className="flex items-center gap-3" style={{ height: LANE_H }}>
              <div className="w-16 text-right flex-shrink-0">
                <span className="text-xs font-mono text-gray-400">{p.projectCode}</span>
              </div>

              {/* SVG lane */}
              <div className="flex-1 relative">
                <svg width="100%" height={LANE_H} preserveAspectRatio="none">
                  {/* Background grid lines at 30d intervals */}
                  {[30, 60].map((d) => (
                    <line
                      key={d}
                      x1={`${((DAYS - d) / DAYS) * 100}%`}
                      x2={`${((DAYS - d) / DAYS) * 100}%`}
                      y1={0}
                      y2={LANE_H}
                      stroke="#374151"
                      strokeWidth={0.5}
                      strokeDasharray="2,2"
                    />
                  ))}

                  {/* Baseline */}
                  <line x1="0" x2="100%" y1={LANE_H - 2} y2={LANE_H - 2} stroke="#374151" strokeWidth={0.5} />

                  {/* Activity bars */}
                  {days.map((count, i) => {
                    if (count === 0) return null
                    const xPct = (i / (DAYS - 1)) * 100
                    const barH = Math.max(2, (count / maxActivity) * (LANE_H - 4))
                    const isSpike = count > activityThreshold
                    return (
                      <rect
                        key={i}
                        x={`${xPct}%`}
                        y={LANE_H - 2 - barH}
                        width="1.2%"
                        height={barH}
                        fill={isSpike ? '#818cf8' : '#4b5563'}
                        opacity={isSpike ? 0.9 : 0.5}
                      />
                    )
                  })}
                </svg>
              </div>

              {/* Health dot */}
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${healthBg[p.currentHealth] ?? 'bg-gray-600'}`} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Tab 4: Mission Control ──────────────────────────────────────────────────
// Dense card grid. Full-bleed dark aesthetic. Maximum data density.

function MissionControl({ data }: { data: ProjectUniverseData[] }) {
  if (!data.length) return <EmptyState />

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2 overflow-auto h-full pr-1">
      {data.map((p) => {
        const actMax = Math.max(...p.activityByDay, 1)
        const actRecent = p.activityByDay.slice(-14)
        const isActive = actRecent.some((v) => v > 0)

        return (
          <div
            key={p.projectId}
            className="bg-gray-900 border border-gray-700/60 rounded p-2.5 flex flex-col gap-1.5 hover:border-gray-500/60 transition-colors"
          >
            {/* Header row */}
            <div className="flex items-center justify-between gap-1">
              <span className="font-mono text-xs font-bold text-white tracking-wide truncate">
                {p.projectCode}
              </span>
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 ${healthBg[p.currentHealth] ?? 'bg-gray-600'}`}
              />
            </div>

            {/* Micro sparkline */}
            <Sparkline
              values={p.activityByDay.slice(-30)}
              width={72}
              height={18}
              color={isActive ? '#818cf8' : '#374151'}
            />

            {/* Health pixel strip */}
            <div className="flex gap-px">
              {p.healthByDay.map((d, i) => (
                <div
                  key={i}
                  style={{ backgroundColor: healthColor[d] ?? healthColor.unknown }}
                  className="h-1 rounded-sm flex-1"
                />
              ))}
            </div>

            {/* Stats row */}
            <div className="flex justify-between text-xs font-mono text-gray-500 pt-0.5">
              <span title="Open issues" className={p.openIssueCount > 0 ? 'text-amber-400' : ''}>
                {p.openIssueCount}i
              </span>
              <span title="Pending feedback" className={p.pendingFeedbackCount > 0 ? 'text-yellow-400' : ''}>
                {p.pendingFeedbackCount}f
              </span>
              <span title={`${p.deployCount} deploys / 30d`}>
                {p.deployCount}d
              </span>
              <span
                title="Activity this week"
                className={isActive ? 'text-indigo-400' : 'text-gray-700'}
              >
                {p.activityByDay.slice(-7).reduce((a, b) => a + b, 0)}
                <span className="text-gray-600">/7d</span>
              </span>
            </div>

            {/* Activity bar (full width) */}
            <div className="w-full h-0.5 bg-gray-800 rounded overflow-hidden">
              <div
                className="h-full bg-indigo-500 transition-all"
                style={{
                  width: `${Math.min(100, (p.activityByDay.slice(-7).reduce((a, b) => a + b, 0) / Math.max(actMax * 7, 1)) * 100)}%`,
                }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Empty state ─────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex items-center justify-center h-full text-gray-600 text-sm">
      No project data yet
    </div>
  )
}

// ─── Main panel ──────────────────────────────────────────────────────────────

const TABS = [
  { label: 'Sparkline Table', shortLabel: 'Table' },
  { label: 'Minard Bands', shortLabel: 'Bands' },
  { label: 'Annotated Timeline', shortLabel: 'Timeline' },
  { label: 'Mission Control', shortLabel: 'Control' },
]

const MIN_HEIGHT = 160
const MAX_HEIGHT = 600

export default function UniversePanel() {
  const [state, setState] = useState<UniverseState>(loadState)
  const { activeTab, panelHeight } = state
  const draggingRef = useRef(false)
  const startYRef = useRef(0)
  const startHRef = useRef(0)
  const panelRef = useRef<HTMLDivElement>(null)

  const setActiveTab = useCallback((tab: number) => {
    setState((s) => {
      const next = { ...s, activeTab: tab }
      saveState(next)
      return next
    })
  }, [])

  const setPanelHeight = useCallback((h: number) => {
    setState((s) => {
      const next = { ...s, panelHeight: Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, h)) }
      saveState(next)
      return next
    })
  }, [])

  const { data = [], isLoading } = useQuery({
    queryKey: ['universeData'],
    queryFn: getUniverseData,
    staleTime: 60_000,
    refetchInterval: 120_000,
  })

  // Drag-to-resize handle
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return
      const delta = e.clientY - startYRef.current
      setPanelHeight(startHRef.current + delta)
    }
    const onUp = () => {
      draggingRef.current = false
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [setPanelHeight])

  const onDragStart = (e: React.MouseEvent) => {
    draggingRef.current = true
    startYRef.current = e.clientY
    startHRef.current = panelHeight
    e.preventDefault()
  }

  return (
    <div ref={panelRef} className="mb-6 bg-gray-900 border border-gray-700/60 rounded-lg overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center justify-between border-b border-gray-700/60 px-3 bg-gray-900">
        <div className="flex">
          {TABS.map((tab, i) => (
            <button
              key={i}
              onClick={() => setActiveTab(i)}
              className={`px-3 py-2.5 text-xs font-medium border-b-2 transition-colors ${
                activeTab === i
                  ? 'border-indigo-500 text-white'
                  : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}
            >
              <span className="hidden sm:inline">{tab.label}</span>
              <span className="sm:hidden">{tab.shortLabel}</span>
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-600 pr-1 select-none">Universe</span>
      </div>

      {/* Content */}
      <div
        style={{ height: panelHeight }}
        className="px-4 py-3 overflow-hidden"
      >
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="flex gap-1">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="w-1 h-8 bg-gray-700 rounded animate-pulse" style={{ animationDelay: `${i * 0.1}s` }} />
              ))}
            </div>
          </div>
        ) : (
          <>
            {activeTab === 0 && <SparklineTable data={data} />}
            {activeTab === 1 && <MinardBands data={data} />}
            {activeTab === 2 && <AnnotatedTimeline data={data} />}
            {activeTab === 3 && <MissionControl data={data} />}
          </>
        )}
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={onDragStart}
        className="h-2 cursor-row-resize flex items-center justify-center bg-gray-900 border-t border-gray-700/40 hover:bg-gray-800 transition-colors group"
        title="Drag to resize"
      >
        <div className="w-8 h-0.5 rounded-full bg-gray-700 group-hover:bg-gray-500 transition-colors" />
      </div>
    </div>
  )
}
