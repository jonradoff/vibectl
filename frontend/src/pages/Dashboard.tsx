import { useState, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ResponsiveGridLayout } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import { getGlobalDashboard, getBulkStartProdStreamUrl, getBulkRestartProdStreamUrl, getViewMode, setViewMode, getDelegationStatus } from '../api/client'
import ProjectCard from '../components/projects/ProjectCard'
import ProjectForm from '../components/projects/ProjectForm'
import MissionControl from '../components/dashboard/MissionControl'
import StaleProjectsModal from '../components/modals/StaleProjectsModal'
import ChatView from '../components/chat/ChatView'
import { useActiveProject } from '../contexts/ActiveProjectContext'
import { useAuth } from '../contexts/AuthContext'
import type { Layout, LayoutItem } from 'react-grid-layout'

// Permanent grid slots
const MC_KEY = '__mission_control__'
const WS_KEY = '__workspace__'
const LAYOUT_VERSION = 6 // bumped: claude usage moved into Mission Control tab
const LAYOUT_KEY = `vibectl-dashboard-layouts-v${LAYOUT_VERSION}`

function loadLayouts(): Record<string, LayoutItem[]> | undefined {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    return raw ? JSON.parse(raw) : undefined
  } catch {
    return undefined
  }
}

function saveLayouts(layouts: Record<string, LayoutItem[]>) {
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(layouts))
}

function generateDefaultLayouts(projectIds: string[]): Record<string, LayoutItem[]> {
  const cols: Record<string, number> = { lg: 6, md: 4, sm: 2 }
  const layouts: Record<string, LayoutItem[]> = {}

  for (const [breakpoint, colCount] of Object.entries(cols)) {
    const defaultW = Math.max(2, Math.floor(colCount / 3))
    // MC spans full width at the top
    const mcItem: LayoutItem = { i: MC_KEY, x: 0, y: 0, w: colCount, h: 3, minW: 2, minH: 2 }
    // Workspace card: 2-wide next to MC row or below it
    const wsItem: LayoutItem = { i: WS_KEY, x: 0, y: 3, w: defaultW, h: 3, minW: 2, minH: 2 }
    const projectItems: LayoutItem[] = projectIds.map((id, i) => ({
      i: id,
      x: ((i + 1) * defaultW) % colCount, // offset by 1 to account for workspace
      y: 3 + Math.floor(((i + 1) * defaultW) / colCount) * 3,
      w: defaultW,
      h: 3,
      minW: 2,
      minH: 2,
    }))
    layouts[breakpoint] = [mcItem, wsItem, ...projectItems]
  }

  return layouts
}

/**
 * Reconcile saved layouts with the current set of all grid IDs (MC + visible projects).
 * MC is always kept/added; project items are added/removed as needed.
 */
function reconcileLayouts(
  saved: Record<string, LayoutItem[]>,
  allIds: Set<string>, // includes MC_KEY
): Record<string, LayoutItem[]> {
  const cols: Record<string, number> = { lg: 6, md: 4, sm: 2 }
  const result: Record<string, LayoutItem[]> = {}

  for (const [breakpoint, savedItems] of Object.entries(saved)) {
    const colCount = cols[breakpoint] ?? 3

    const kept = savedItems.filter((l) => allIds.has(l.i))
    const keptIds = new Set(kept.map((l) => l.i))
    const newIds = [...allIds].filter((id) => !keptIds.has(id))

    if (newIds.length === 0) {
      result[breakpoint] = kept
      continue
    }

    let maxBottom = 0
    for (const item of kept) {
      const bottom = item.y + item.h
      if (bottom > maxBottom) maxBottom = bottom
    }

    const occupied = new Set<string>()
    for (const item of kept) {
      for (let row = item.y; row < item.y + item.h; row++) {
        for (let col = item.x; col < item.x + item.w; col++) {
          occupied.add(`${col},${row}`)
        }
      }
    }

    const placed: LayoutItem[] = []
    for (const id of newIds) {
      // MC always gets placed full-width at y=0 when new
      if (id === MC_KEY) {
        placed.push({ i: MC_KEY, x: 0, y: 0, w: colCount, h: 3, minW: 2, minH: 2 })
        continue
      }
      // Workspace gets default placement when new
      if (id === WS_KEY) {
        const defaultW = Math.max(2, Math.floor(colCount / 3))
        placed.push({ i: WS_KEY, x: 0, y: maxBottom, w: defaultW, h: 3, minW: 2, minH: 2 })
        continue
      }

      const defaultW = Math.max(2, Math.floor(colCount / 3)), h = 3, w = defaultW
      let foundX = -1, foundY = -1

      for (let row = 0; row <= maxBottom + h; row++) {
        for (let col = 0; col < colCount; col++) {
          let fits = true
          for (let dy = 0; dy < h && fits; dy++) {
            for (let dx = 0; dx < w && fits; dx++) {
              if (occupied.has(`${col + dx},${row + dy}`)) fits = false
            }
          }
          if (fits) { foundX = col; foundY = row; break }
        }
        if (foundX >= 0) break
      }

      if (foundX < 0) { foundX = 0; foundY = maxBottom }

      const layout: LayoutItem = { i: id, x: foundX, y: foundY, w, h, minW: 1, minH: 2 }
      placed.push(layout)

      for (let row = foundY; row < foundY + h; row++) {
        for (let col = foundX; col < foundX + w; col++) {
          occupied.add(`${col},${row}`)
        }
      }
      const newBottom = foundY + h
      if (newBottom > maxBottom) maxBottom = newBottom
    }

    result[breakpoint] = [...kept, ...placed]
  }

  return result
}

function useWidth(ref: React.RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const check = () => {
      if (ref.current) {
        const w = ref.current.offsetWidth
        if (w > 0) setWidth(w)
      }
    }
    check()
    const ro = new ResizeObserver(check)
    if (ref.current) ro.observe(ref.current)
    return () => ro.disconnect()
  })
  return width
}

function Dashboard() {
  const [showCreateProject, setShowCreateProject] = useState(false)
  const [layoutKey, setLayoutKey] = useState(0)
  const [bulkModal, setBulkModal] = useState<{ title: string; url: string } | null>(null)
  const queryClient = useQueryClient()
  const gridContainerRef = useRef<HTMLDivElement>(null)
  const gridWidth = useWidth(gridContainerRef)
  const { closedProjectIds } = useActiveProject()
  const { currentUser } = useAuth()
  const isSuperAdmin = currentUser?.globalRole === 'super_admin'

  const workspaceDir = currentUser?.workspaceDir || ''

  const { data: dashboard, isLoading, error } = useQuery({
    queryKey: ['globalDashboard'],
    queryFn: getGlobalDashboard,
  })

  useEffect(() => {
    if (error && (error as Error).message?.toLowerCase().includes('authentication')) {
      window.dispatchEvent(new CustomEvent('vibectl:unauthorized'))
    }
  }, [error])

  const handleLayoutChange = useCallback((_: Layout, allLayouts: Partial<Record<string, Layout>>) => {
    saveLayouts(allLayouts as Record<string, LayoutItem[]>)
  }, [])

  // Snap project card widths to allowed values after resize; MC is exempt
  const handleResizeStop = useCallback((layout: Layout) => {
    const allowed = [2, 3, 6]
    let changed = false
    for (const item of layout as LayoutItem[]) {
      if (item.i === MC_KEY || item.i === WS_KEY) continue
      const closest = allowed.reduce((prev, curr) =>
        Math.abs(curr - item.w) < Math.abs(prev - item.w) ? curr : prev
      )
      if (item.w !== closest) {
        item.w = closest
        if (item.x + closest > 6) item.x = 6 - closest
        changed = true
      }
    }
    if (changed) {
      const saved = loadLayouts() || {}
      for (const bp of Object.keys(saved)) {
        for (const item of saved[bp] as LayoutItem[]) {
          if (item.i === MC_KEY || item.i === WS_KEY) continue
          const closest = allowed.reduce((prev, curr) =>
            Math.abs(curr - item.w) < Math.abs(prev - item.w) ? curr : prev
          )
          item.w = closest
          if (item.x + closest > 6) item.x = 6 - closest
        }
      }
      saveLayouts(saved)
      setLayoutKey(k => k + 1)
    }
  }, [])

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-950 p-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-48 animate-pulse rounded-lg bg-gray-800" />
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    const isAuthError = (error as Error).message?.toLowerCase().includes('authentication') ||
      (error as Error).message?.toLowerCase().includes('unauthorized')
    return (
      <div className="min-h-screen bg-gray-950 p-6 flex items-center justify-center">
        <div className="rounded bg-red-900/30 p-6 text-red-400 text-center max-w-sm">
          <p className="font-medium mb-2">
            {isAuthError ? 'Session expired' : 'Failed to load dashboard'}
          </p>
          <p className="text-sm text-red-400/70 mb-4">
            {isAuthError ? 'Please sign in again.' : (error as Error).message}
          </p>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('vibectl:unauthorized'))}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-sm font-medium"
          >
            Sign in again
          </button>
        </div>
      </div>
    )
  }

  if (!dashboard) return null

  const { projectSummaries } = dashboard

  const visibleSummaries = projectSummaries.filter((s) => !closedProjectIds.has(s.project.id))
  const hiddenSummaries = projectSummaries.filter((s) => closedProjectIds.has(s.project.id))
  const visibleIds = visibleSummaries.map((s) => s.project.id)
  // MC and Workspace are always in the grid
  const allIds = new Set([MC_KEY, WS_KEY, ...visibleIds])
  const savedLayouts = loadLayouts()

  const layouts = (() => {
    if (!savedLayouts) return generateDefaultLayouts(visibleIds)
    const savedKeys = new Set(Object.values(savedLayouts)[0]?.map((l) => l.i) ?? [])
    const exactMatch = savedKeys.size === allIds.size && [...allIds].every((k) => savedKeys.has(k))
    if (exactMatch) return savedLayouts
    const reconciled = reconcileLayouts(savedLayouts, allIds)
    saveLayouts(reconciled)
    return reconciled
  })()

  return (
    <div className="min-h-screen bg-gray-950 p-6">
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        <div className="flex items-center gap-2">
          <DelegationViewToggle />
          {isSuperAdmin && (
            <>
            <button
              onClick={() => setBulkModal({ title: 'Start All Production', url: getBulkStartProdStreamUrl() })}
              className="rounded-lg bg-green-700 hover:bg-green-600 px-3 py-2 text-xs font-medium text-white transition-colors"
            >
              Start All Prod
            </button>
            <button
              onClick={() => setBulkModal({ title: 'Restart All Production', url: getBulkRestartProdStreamUrl() })}
              className="rounded-lg bg-amber-700 hover:bg-amber-600 px-3 py-2 text-xs font-medium text-white transition-colors"
            >
              Restart All Prod
            </button>
            <button
              onClick={() => setShowCreateProject(true)}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
            >
              + New Project
            </button>
            </>
          )}
        </div>
      </div>

      {bulkModal && createPortal(
        <BulkStreamModal title={bulkModal.title} url={bulkModal.url} onClose={() => setBulkModal(null)} />,
        document.body
      )}

      {isSuperAdmin && (
        <ProjectForm
          open={showCreateProject}
          onClose={() => setShowCreateProject(false)}
          onCreated={() => queryClient.invalidateQueries({ queryKey: ['globalDashboard'] })}
        />
      )}

      {/* Unified grid: MC + project cards can be freely arranged */}
      <div ref={gridContainerRef}>
        {gridWidth > 0 && (
          <ResponsiveGridLayout
            key={layoutKey}
            className="layout"
            layouts={layouts}
            breakpoints={{ lg: 1200, md: 768, sm: 0 }}
            cols={{ lg: 6, md: 4, sm: 2 }}
            rowHeight={120}
            width={gridWidth}
            dragConfig={{ handle: '.drag-handle' }}
            onLayoutChange={handleLayoutChange}
            onResizeStop={handleResizeStop}
          >
            <div key={MC_KEY} className="h-full">
              <MissionControl />
            </div>
            <div key={WS_KEY} className="h-full">
              <WorkspaceCard workspaceDir={workspaceDir} />
            </div>
            {visibleSummaries.map((summary) => (
              <div key={summary.project.id} data-project-id={summary.project.id} className="h-full">
                <ProjectCard summary={summary} />
              </div>
            ))}
          </ResponsiveGridLayout>
        )}
      </div>

      {/* Hidden cards: keep chat connections alive */}
      <div className="hidden">
        {hiddenSummaries.map((summary) => (
          <ProjectCard key={summary.project.id} summary={summary} />
        ))}
      </div>
    </div>
  )
}

type BulkProjectEntry = { name: string; lines: string[]; status: 'running' | 'done' | 'error' | 'pending' };

function BulkStreamModal({ title, url, onClose }: { title: string; url: string; onClose: () => void }) {
  const [projects, setProjects] = useState<BulkProjectEntry[]>([])
  const [done, setDone] = useState(false)
  const [connectionError, setConnectionError] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [projects])

  useEffect(() => {
    const es = new EventSource(url)
    es.onmessage = (e) => {
      const line = e.data as string
      if (line === 'DONE') {
        es.close()
        setDone(true)
      } else if (line.startsWith('PROJECT:')) {
        const name = line.slice(8)
        setProjects(prev => [...prev, { name, lines: [], status: 'running' }])
      } else if (line.startsWith('PROJECT_DONE:')) {
        const name = line.slice(13)
        setProjects(prev => prev.map(p => p.name === name ? { ...p, status: 'done' } : p))
      } else if (line.startsWith('PROJECT_ERROR:')) {
        const name = line.slice(14)
        setProjects(prev => prev.map(p => p.name === name ? { ...p, status: 'error' } : p))
      } else if (line.startsWith('ERROR:')) {
        setConnectionError(line.slice(6).trim())
        es.close()
        setDone(true)
      } else {
        setProjects(prev => {
          if (prev.length === 0) return prev
          const updated = [...prev]
          updated[updated.length - 1] = { ...updated[updated.length - 1], lines: [...updated[updated.length - 1].lines, line] }
          return updated
        })
      }
    }
    es.onerror = () => {
      es.close()
      setConnectionError('Connection lost')
      setDone(true)
    }
    return () => es.close()
  }, [url])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
      <div className="w-full max-w-lg rounded-xl bg-gray-900 border border-gray-700 shadow-2xl flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          {done && (
            <button onClick={onClose} className="rounded-lg bg-gray-700 hover:bg-gray-600 px-3 py-1 text-xs font-medium text-gray-300 transition-colors">
              Close
            </button>
          )}
        </div>

        <div ref={logRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3 min-h-0">
          {!done && projects.length === 0 && !connectionError && (
            <div className="flex items-center gap-2 text-xs text-indigo-300">
              <div className="w-3 h-3 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
              Starting…
            </div>
          )}
          {projects.map((proj) => (
            <div key={proj.name}>
              <div className="flex items-center gap-2 mb-1">
                {proj.status === 'running' && <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse shrink-0" />}
                {proj.status === 'done' && <span className="w-2 h-2 rounded-full bg-green-400 shrink-0" />}
                {proj.status === 'error' && <span className="w-2 h-2 rounded-full bg-red-400 shrink-0" />}
                <span className="text-xs font-semibold text-white">{proj.name}</span>
                {proj.status === 'done' && <span className="text-[10px] text-green-400">✓</span>}
                {proj.status === 'error' && <span className="text-[10px] text-red-400">✗ failed</span>}
              </div>
              {proj.lines.length > 0 && (
                <pre className="text-[10px] text-gray-400 bg-gray-950 border border-gray-800 rounded p-2 overflow-x-auto max-h-32 whitespace-pre-wrap break-all">
                  {proj.lines.join('\n')}
                </pre>
              )}
            </div>
          ))}
          {connectionError && (
            <p className="text-xs text-red-400">{connectionError}</p>
          )}
          {done && !connectionError && (
            <p className="text-xs text-green-400 font-medium pt-1">✓ All done</p>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Workspace Card ───────────────────────────────────────────────────────────

function WorkspaceCard({ workspaceDir }: { workspaceDir: string }) {
  const [showSettings, setShowSettings] = useState(false)
  const [dirInput, setDirInput] = useState(workspaceDir)
  const [saving, setSaving] = useState(false)
  const { refreshUser } = useAuth()

  // Sync input when prop changes
  useEffect(() => { setDirInput(workspaceDir) }, [workspaceDir])

  const handleSave = async () => {
    setSaving(true)
    try {
      const { updateSelfProfile } = await import('../api/client')
      await updateSelfProfile({ workspaceDir: dirInput.trim() || undefined })
      await refreshUser()
      setShowSettings(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col h-full rounded-lg border border-cyan-700/40 bg-gray-800 overflow-hidden">
      {/* Header */}
      <div className="drag-handle flex items-center justify-between px-3 py-2 bg-gray-900 border-b border-cyan-700/40 shrink-0 cursor-grab select-none">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold bg-cyan-600/20 text-cyan-300 uppercase tracking-wider">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
            </svg>
            Workspace
          </span>
          {workspaceDir && (
            <span className="text-[10px] font-mono text-gray-500 truncate max-w-[200px]">{workspaceDir}</span>
          )}
        </div>
        <button
          onMouseDown={e => e.stopPropagation()}
          onClick={() => setShowSettings(v => !v)}
          className="text-gray-500 hover:text-gray-300 transition-colors"
          title="Workspace settings"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
          </svg>
        </button>
      </div>

      {/* Inline settings */}
      {showSettings && (
        <div className="px-3 py-2 border-b border-cyan-700/40 bg-gray-900/80 space-y-2" onMouseDown={e => e.stopPropagation()}>
          <label className="block text-[10px] text-gray-400 uppercase tracking-wider">Working directory</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={dirInput}
              onChange={e => setDirInput(e.target.value)}
              placeholder="/Users/you"
              className="flex-1 rounded border border-gray-600 bg-gray-700 px-2 py-1 text-xs font-mono text-gray-100 focus:border-cyan-500 focus:outline-none"
            />
            <button
              onClick={handleSave}
              disabled={saving}
              className="rounded bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 px-2.5 py-1 text-[10px] font-medium text-white transition-colors"
            >
              {saving ? '...' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 min-h-0">
        {workspaceDir ? (
          <ChatView
            projectId="__workspace__"
            projectCode="WKSP"
            localPath={workspaceDir}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-600 text-sm px-4 text-center">
            <div>
              <p className="mb-1">Click the gear icon to set your workspace directory</p>
              <p className="text-[10px] text-gray-700">The root path where your projects live</p>
            </div>
          </div>
        )}
      </div>
      <StaleProjectsModal />
    </div>
  )
}

function DelegationViewToggle() {
  const [viewMode, setMode] = useState(getViewMode())
  const { data: delegation } = useQuery({
    queryKey: ['delegationStatus'],
    queryFn: getDelegationStatus,
    refetchInterval: 30_000,
    retry: 1,
  })

  // Re-read on change events
  useEffect(() => {
    const handler = () => setMode(getViewMode())
    window.addEventListener('vibectl:viewmode-changed', handler)
    return () => window.removeEventListener('vibectl:viewmode-changed', handler)
  }, [])

  if (!delegation?.enabled) return null

  const toggle = () => {
    const next = viewMode === 'local' ? 'auto' : 'local'
    setViewMode(next)
    setMode(next)
    // Force refetch all queries
    window.location.reload()
  }

  return (
    <button
      onClick={toggle}
      className={`rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
        viewMode === 'local'
          ? 'bg-amber-700 hover:bg-amber-600 text-white'
          : 'bg-cyan-700 hover:bg-cyan-600 text-white'
      }`}
      title={viewMode === 'local' ? 'Viewing local data — click to switch to remote' : 'Viewing remote data — click to switch to local'}
    >
      {viewMode === 'local' ? 'Local View' : 'Remote View'}
    </button>
  )
}

export default Dashboard
