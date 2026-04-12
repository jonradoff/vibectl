import { useState, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { listUnits, addUnit } from '../../api/client'
import type { ProjectSummary } from '../../types'
import ProjectCard from './ProjectCard'
import { useActiveProject } from '../../contexts/ActiveProjectContext'

interface MultiModuleCardProps {
  summary: ProjectSummary
}

const ACTIVE_UNIT_KEY = (id: string) => `vibectl-multimod-active-${id}`

export default function MultiModuleCard({ summary }: MultiModuleCardProps) {
  const { project } = summary
  const { activeProjectId, setActiveProjectId, projectStatuses, closeProject } = useActiveProject()
  const [selectedId, setSelectedId] = useState<string>(() => {
    try {
      return localStorage.getItem(ACTIVE_UNIT_KEY(project.id)) || project.id
    } catch { return project.id }
  })
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showAddUnit, setShowAddUnit] = useState(false)

  const { data: units = [] } = useQuery({
    queryKey: ['units', project.id],
    queryFn: () => listUnits(project.id),
    staleTime: 60_000,
  })

  // Persist selected unit
  useEffect(() => {
    try { localStorage.setItem(ACTIVE_UNIT_KEY(project.id), selectedId) } catch { /* ignore */ }
  }, [selectedId, project.id])

  // Escape exits fullscreen
  useEffect(() => {
    if (!isFullscreen) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsFullscreen(false) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isFullscreen])

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id)
    setActiveProjectId(id)
  }, [setActiveProjectId])

  // Build a synthetic summary for the selected unit
  const selectedSummary: ProjectSummary | null = (() => {
    if (selectedId === project.id) return summary
    const unit = units.find(u => u.id === selectedId)
    if (!unit) return null
    return {
      project: unit,
      openIssueCount: 0,
      issuesByPriority: {},
      issuesByStatus: {},
      issuesByType: {},
    }
  })()

  const isActive = activeProjectId === project.id || units.some(u => u.id === activeProjectId)

  const statusDot = (id: string) => {
    const ps = projectStatuses[id]
    if (!ps) return 'bg-gray-600'
    const connected = ['started', 'running', 'connecting', 'connected', 'reconnected', 'restarted'].includes(ps.terminalStatus)
    if (ps.isError) return 'bg-red-400'
    if (connected && ps.isActive && !ps.isWaiting) return 'bg-amber-400 animate-pulse'
    if (connected) return 'bg-green-400'
    return 'bg-gray-600'
  }

  const cardContent = (
    <div
      className={isFullscreen
        ? 'fixed inset-0 z-50 flex bg-gray-800'
        : `flex h-full rounded-lg border bg-gray-800 overflow-hidden transition-all duration-200 ${
            isActive
              ? 'border-indigo-500 shadow-[0_0_12px_rgba(99,102,241,0.4)] ring-1 ring-indigo-500/50'
              : 'border-gray-700'
          }`
      }
    >
      {/* Unit sidebar */}
      <div className="w-28 shrink-0 border-r border-gray-700 bg-gray-900 flex flex-col">
        <div className="drag-handle px-2 py-2 border-b border-gray-700 cursor-grab select-none">
          <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider truncate">{project.name}</div>
          <div className="text-[9px] font-mono text-gray-600">{project.code}</div>
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {/* Orchestrator */}
          <button
            onClick={() => handleSelect(project.id)}
            className={`w-full text-left px-2 py-1.5 flex items-center gap-1.5 text-xs transition-colors ${
              selectedId === project.id ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot(project.id)}`} />
            <span className="truncate font-medium">Orchestrator</span>
          </button>

          {/* Units */}
          {units.map(unit => (
            <button
              key={unit.id}
              onClick={() => handleSelect(unit.id)}
              className={`w-full text-left px-2 py-1.5 flex items-center gap-1.5 text-xs transition-colors ${
                selectedId === unit.id ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot(unit.id)}`} />
              <span className="truncate">{unit.unitName || unit.name}</span>
            </button>
          ))}
        </div>

        {/* Add unit button */}
        <div className="border-t border-gray-700 px-2 py-1.5">
          <button
            onClick={() => setShowAddUnit(true)}
            className="text-[10px] text-indigo-400 hover:text-indigo-300 font-medium"
          >
            + Add Unit
          </button>
        </div>

        {/* Bottom controls */}
        <div className="border-t border-gray-700 px-2 py-1.5 flex items-center justify-between">
          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="text-gray-500 hover:text-gray-300 transition-colors"
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {isFullscreen ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9V4.5M9 9H4.5M9 9 3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5 5.25 5.25" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
              )}
            </svg>
          </button>
          {!isFullscreen && (
            <button
              onClick={() => closeProject(project.id)}
              className="text-gray-500 hover:text-red-400 transition-colors"
              title="Close window"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Main content — ProjectCard for selected unit/orchestrator */}
      <div className="flex-1 min-w-0">
        {selectedSummary ? (
          <ProjectCard summary={selectedSummary} embedded />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-600 text-sm">
            Select a unit from the sidebar
          </div>
        )}
      </div>

      {/* Add Unit modal */}
      {showAddUnit && (
        <AddUnitModal
          parentId={project.id}
          onClose={() => setShowAddUnit(false)}
        />
      )}
    </div>
  )

  if (isFullscreen) {
    return createPortal(cardContent, document.body)
  }

  return cardContent
}

// ─── Add Unit Modal ──────────────────────────────────────────────────────────

function AddUnitModal({ parentId, onClose }: { parentId: string; onClose: () => void }) {
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [path, setPath] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const queryClient = useQueryClient()

  const handleSubmit = async () => {
    setError('')
    if (!name.trim() || !code.trim() || !path.trim()) {
      setError('Name, code, and path are required.')
      return
    }
    if (!/^[A-Z]{3,5}$/.test(code)) {
      setError('Code must be 3–5 uppercase letters.')
      return
    }
    setBusy(true)
    try {
      await addUnit(parentId, { name: name.trim(), code, path: path.trim(), description: description.trim() })
      queryClient.invalidateQueries({ queryKey: ['units', parentId] })
      queryClient.invalidateQueries({ queryKey: ['globalDashboard'] })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add unit')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-xl bg-gray-800 border border-gray-700 p-5 space-y-3" onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-white">Add Unit</h3>
        <div className="grid grid-cols-2 gap-2">
          <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Unit Name" autoFocus
            className="rounded border border-gray-600 bg-gray-700 px-2 py-1.5 text-sm text-gray-100 focus:border-indigo-500 focus:outline-none" />
          <input type="text" value={code} onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5))} placeholder="CODE" maxLength={5}
            className="rounded border border-gray-600 bg-gray-700 px-2 py-1.5 text-sm font-mono text-gray-100 focus:border-indigo-500 focus:outline-none" />
        </div>
        <input type="text" value={path} onChange={e => setPath(e.target.value)} placeholder="Relative path (e.g. units/combat)"
          className="w-full rounded border border-gray-600 bg-gray-700 px-2 py-1.5 text-sm font-mono text-gray-100 focus:border-indigo-500 focus:outline-none" />
        <input type="text" value={description} onChange={e => setDescription(e.target.value)} placeholder="Description (optional)"
          className="w-full rounded border border-gray-600 bg-gray-700 px-2 py-1.5 text-sm text-gray-100 focus:border-indigo-500 focus:outline-none" />
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="text-xs text-gray-400 hover:text-white px-3 py-1.5 rounded transition-colors">Cancel</button>
          <button onClick={handleSubmit} disabled={busy}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors">
            {busy ? 'Adding...' : 'Add Unit'}
          </button>
        </div>
      </div>
    </div>
  )
}
