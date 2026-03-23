import { useState, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ResponsiveGridLayout } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import { getGlobalDashboard, getBulkStartProdStreamUrl, getBulkRestartProdStreamUrl } from '../api/client'
import ProjectCard from '../components/projects/ProjectCard'
import ProjectForm from '../components/projects/ProjectForm'
import UniversePanel from '../components/dashboard/UniversePanel'
import { useActiveProject } from '../contexts/ActiveProjectContext'
import { useAuth } from '../contexts/AuthContext'
import type { Layout, LayoutItem } from 'react-grid-layout'

const LAYOUT_VERSION = 3 // bump to invalidate saved layouts when grid config changes
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
    const defaultW = Math.max(2, Math.floor(colCount / 3)) // 2 at lg (3/row), 2 at md (2/row), 1 at sm
    layouts[breakpoint] = projectIds.map((id, i) => ({
      i: id,
      x: (i * defaultW) % colCount,
      y: Math.floor((i * defaultW) / colCount) * 3,
      w: defaultW,
      h: 3,
      minW: 2,
      minH: 2,
    }))
  }

  return layouts
}

/**
 * Reconcile saved layouts with the current set of visible project IDs.
 * - Existing items keep their saved position and size.
 * - Removed items are filtered out.
 * - New items are placed in the first available gap at the bottom.
 */
function reconcileLayouts(
  saved: Record<string, LayoutItem[]>,
  visibleIds: Set<string>,
): Record<string, LayoutItem[]> {
  const cols: Record<string, number> = { lg: 6, md: 4, sm: 2 }
  const result: Record<string, LayoutItem[]> = {}

  for (const [breakpoint, savedItems] of Object.entries(saved)) {
    const colCount = cols[breakpoint] ?? 3

    // Keep items that are still visible, preserving their position/size
    const kept = savedItems.filter((l) => visibleIds.has(l.i))
    const keptIds = new Set(kept.map((l) => l.i))

    // Find IDs that need to be added
    const newIds = [...visibleIds].filter((id) => !keptIds.has(id))

    if (newIds.length === 0) {
      result[breakpoint] = kept
      continue
    }

    // Build an occupancy grid to find open slots
    // Find the max y+h among existing items
    let maxBottom = 0
    for (const item of kept) {
      const bottom = item.y + item.h
      if (bottom > maxBottom) maxBottom = bottom
    }

    // Build set of occupied cells
    const occupied = new Set<string>()
    for (const item of kept) {
      for (let row = item.y; row < item.y + item.h; row++) {
        for (let col = item.x; col < item.x + item.w; col++) {
          occupied.add(`${col},${row}`)
        }
      }
    }

    // Place new items: scan rows for a 1-wide, 3-tall opening
    const placed: LayoutItem[] = []
    for (const id of newIds) {
      const defaultW = Math.max(2, Math.floor(colCount / 3)), h = 3, w = defaultW
      let foundX = -1, foundY = -1

      // Search from top, trying to find gaps first, then append at bottom
      for (let row = 0; row <= maxBottom + h; row++) {
        for (let col = 0; col < colCount; col++) {
          let fits = true
          for (let dy = 0; dy < h && fits; dy++) {
            for (let dx = 0; dx < w && fits; dx++) {
              if (occupied.has(`${col + dx},${row + dy}`)) fits = false
            }
          }
          if (fits) {
            foundX = col
            foundY = row
            break
          }
        }
        if (foundX >= 0) break
      }

      if (foundX < 0) {
        // Fallback: place at the very bottom
        foundX = 0
        foundY = maxBottom
      }

      const layout: LayoutItem = { i: id, x: foundX, y: foundY, w, h, minW: 1, minH: 2 }
      placed.push(layout)

      // Mark cells as occupied
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

  const { data: dashboard, isLoading, error } = useQuery({
    queryKey: ['globalDashboard'],
    queryFn: getGlobalDashboard,
  })

  const handleLayoutChange = useCallback((_: Layout, allLayouts: Partial<Record<string, Layout>>) => {
    saveLayouts(allLayouts as Record<string, LayoutItem[]>)
  }, [])

  // Snap width to allowed values after resize completes
  const handleResizeStop = useCallback((layout: Layout) => {
    const allowed = [2, 3, 6]
    let changed = false
    for (const item of layout as LayoutItem[]) {
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
      // Save the snapped layout and force re-render
      const saved = loadLayouts() || {}
      // Apply snap to all breakpoints
      for (const bp of Object.keys(saved)) {
        for (const item of saved[bp] as LayoutItem[]) {
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
        <div className="mb-8 grid grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-lg bg-gray-800" />
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-48 animate-pulse rounded-lg bg-gray-800" />
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-950 p-6">
        <div className="rounded bg-red-900/30 p-4 text-red-400">
          Failed to load dashboard: {(error as Error).message}
        </div>
      </div>
    )
  }

  if (!dashboard) return null

  const { totalProjects, totalOpenIssues, pendingFeedback, projectSummaries } = dashboard

  const visibleSummaries = projectSummaries.filter((s) => !closedProjectIds.has(s.project.id))
  const hiddenSummaries = projectSummaries.filter((s) => closedProjectIds.has(s.project.id))
  const visibleIds = visibleSummaries.map((s) => s.project.id)
  const visibleIdSet = new Set(visibleIds)
  const savedLayouts = loadLayouts()

  // Reconcile: keep existing positions, only add/remove what changed
  const layouts = (() => {
    if (!savedLayouts) return generateDefaultLayouts(visibleIds)

    const savedKeys = new Set(Object.values(savedLayouts)[0]?.map((l) => l.i) ?? [])
    const exactMatch = savedKeys.size === visibleIdSet.size && [...visibleIdSet].every((k) => savedKeys.has(k))
    if (exactMatch) return savedLayouts

    // There's a difference — reconcile to preserve existing positions
    const reconciled = reconcileLayouts(savedLayouts, visibleIdSet)
    saveLayouts(reconciled)
    return reconciled
  })()

  return (
    <div className="min-h-screen bg-gray-950 p-6">
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        {isSuperAdmin && (
          <div className="flex items-center gap-2">
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
          </div>
        )}
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

      {/* Universe visualization panel */}
      <UniversePanel />

      {/* Global stats bar */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg bg-gray-800 p-4">
          <p className="text-sm text-gray-400">Total Projects</p>
          <p className="text-3xl font-bold text-white">{totalProjects}</p>
        </div>
        <div className="rounded-lg bg-gray-800 p-4">
          <p className="text-sm text-gray-400">Open Issues</p>
          <p className="text-3xl font-bold text-white">{totalOpenIssues}</p>
        </div>
        <div className="rounded-lg bg-gray-800 p-4">
          <p className="text-sm text-gray-400">Pending Feedback</p>
          <p className="text-3xl font-bold text-white">{pendingFeedback}</p>
        </div>
      </div>

      {/* Project cards grid */}
      <div ref={gridContainerRef}>
        {projectSummaries.length === 0 ? (
          <div className="rounded-lg border border-gray-700 bg-gray-800 p-12 text-center">
            <p className="text-lg text-gray-400">No projects yet.</p>
            <button
              onClick={() => setShowCreateProject(true)}
              className="mt-3 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
            >
              + Create Your First Project
            </button>
          </div>
        ) : visibleSummaries.length === 0 ? (
          <div className="rounded-lg border border-gray-700 bg-gray-800 p-12 text-center">
            <p className="text-lg text-gray-400">All project windows are closed.</p>
            <p className="mt-1 text-sm text-gray-500">Select a project from the sidebar to open it.</p>
          </div>
        ) : gridWidth > 0 ? (
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
            {visibleSummaries.map((summary) => (
              <div key={summary.project.id} data-project-id={summary.project.id} className="h-full">
                <ProjectCard summary={summary} />
              </div>
            ))}
          </ResponsiveGridLayout>
        ) : null}
      </div>

      {/* Hidden cards: keep chat connections alive but not visible */}
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

export default Dashboard
