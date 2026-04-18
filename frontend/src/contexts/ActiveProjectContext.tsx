import { createContext, useContext, useState, useCallback } from 'react'
import type { ReactNode } from 'react'

export interface ProjectStatus {
  terminalStatus: string
  isActive: boolean
  isWaiting?: boolean
  isError?: boolean
  healthUp?: boolean   // all endpoints up
  healthDown?: boolean // all endpoints down
  healthHasResults?: boolean
}

const CLOSED_PROJECTS_KEY = 'vibectl-closed-projects'

function loadClosedProjects(): Set<string> {
  try {
    const raw = localStorage.getItem(CLOSED_PROJECTS_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

function saveClosedProjects(ids: Set<string>) {
  localStorage.setItem(CLOSED_PROJECTS_KEY, JSON.stringify([...ids]))
}

interface ActiveProjectContextValue {
  activeProjectId: string | null
  setActiveProjectId: (id: string | null) => void
  projectStatuses: Record<string, ProjectStatus>
  updateProjectStatus: (projectCode: string, status: ProjectStatus) => void
  closedProjectIds: Set<string>
  closeProject: (id: string) => void
  openProject: (id: string) => void
}

const ActiveProjectContext = createContext<ActiveProjectContextValue>({
  activeProjectId: null,
  setActiveProjectId: () => {},
  projectStatuses: {},
  updateProjectStatus: () => {},
  closedProjectIds: new Set(),
  closeProject: () => {},
  openProject: () => {},
})

export function ActiveProjectProvider({ children }: { children: ReactNode }) {
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [projectStatuses, setProjectStatuses] = useState<Record<string, ProjectStatus>>({})
  const [closedProjectIds, setClosedProjectIds] = useState<Set<string>>(loadClosedProjects)

  const updateProjectStatus = useCallback((projectCode: string, status: ProjectStatus) => {
    setProjectStatuses((prev) => {
      const existing = prev[projectCode]
      if (
        existing &&
        existing.terminalStatus === status.terminalStatus &&
        existing.isActive === status.isActive &&
        existing.isWaiting === status.isWaiting &&
        existing.isError === status.isError &&
        existing.healthUp === status.healthUp &&
        existing.healthDown === status.healthDown &&
        existing.healthHasResults === status.healthHasResults
      ) {
        return prev
      }
      return { ...prev, [projectCode]: status }
    })
  }, [])

  const closeProject = useCallback((id: string) => {
    setClosedProjectIds((prev) => {
      const next = new Set(prev)
      next.add(id)
      saveClosedProjects(next)
      return next
    })
    setActiveProjectId((prev) => (prev === id ? null : prev))
  }, [])

  const openProject = useCallback((id: string) => {
    setClosedProjectIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      saveClosedProjects(next)
      return next
    })
  }, [])

  return (
    <ActiveProjectContext.Provider
      value={{
        activeProjectId,
        setActiveProjectId,
        projectStatuses,
        updateProjectStatus,
        closedProjectIds,
        closeProject,
        openProject,
      }}
    >
      {children}
    </ActiveProjectContext.Provider>
  )
}

export function useActiveProject() {
  return useContext(ActiveProjectContext)
}
