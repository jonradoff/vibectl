import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listStaleProjects, setProjectInactive } from '../../api/client'
import type { Project } from '../../types'

const STALE_CHECK_KEY = 'vibectl-stale-check-shown'
const STALE_SNOOZE_KEY = 'vibectl-stale-snooze-until'

function shouldShowModal(): boolean {
  // Show on first visit after feature is implemented
  const shown = localStorage.getItem(STALE_CHECK_KEY)
  if (!shown) return true

  // Check snooze
  const snoozeUntil = localStorage.getItem(STALE_SNOOZE_KEY)
  if (snoozeUntil === 'never') return false
  if (snoozeUntil) {
    const until = new Date(snoozeUntil)
    if (until > new Date()) return false
  }

  // Check if enough time has passed since last shown
  const lastShown = new Date(shown)
  const daysSince = (Date.now() - lastShown.getTime()) / (1000 * 60 * 60 * 24)
  return daysSince >= 7
}

export default function StaleProjectsModal() {
  const [visible, setVisible] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showSnooze, setShowSnooze] = useState(false)
  const queryClient = useQueryClient()

  const { data: staleProjects = [] } = useQuery({
    queryKey: ['staleProjects'],
    queryFn: () => listStaleProjects(7),
    enabled: visible,
  })

  useEffect(() => {
    if (shouldShowModal()) {
      // Delay slightly so the dashboard loads first
      const timer = setTimeout(() => setVisible(true), 1500)
      return () => clearTimeout(timer)
    }
  }, [])

  const inactiveMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await setProjectInactive(id)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['globalDashboard'] })
      queryClient.invalidateQueries({ queryKey: ['universeData'] })
      localStorage.setItem(STALE_CHECK_KEY, new Date().toISOString())
      setVisible(false)
    },
  })

  const handleSaveInactive = () => {
    if (selected.size > 0) {
      inactiveMutation.mutate([...selected])
    }
  }

  const handleSkip = () => {
    setShowSnooze(true)
  }

  const handleSnooze = (option: string) => {
    if (option === 'never') {
      localStorage.setItem(STALE_SNOOZE_KEY, 'never')
    } else {
      const days = parseInt(option)
      const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
      localStorage.setItem(STALE_SNOOZE_KEY, until.toISOString())
    }
    localStorage.setItem(STALE_CHECK_KEY, new Date().toISOString())
    setVisible(false)
  }

  const toggleProject = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  if (!visible || staleProjects.length === 0) {
    // If modal was supposed to show but no stale projects, mark as checked
    if (visible && staleProjects.length === 0) {
      localStorage.setItem(STALE_CHECK_KEY, new Date().toISOString())
      setVisible(false)
    }
    return null
  }

  if (showSnooze) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-6 max-w-sm w-full">
          <h2 className="text-sm font-semibold text-white mb-3">Remind me again in...</h2>
          <div className="space-y-2">
            {[
              { label: '1 day', value: '1' },
              { label: '7 days', value: '7' },
              { label: 'Never', value: 'never' },
            ].map(opt => (
              <button
                key={opt.value}
                onClick={() => handleSnooze(opt.value)}
                className="w-full text-left px-4 py-2.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm transition-colors"
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-6 max-w-lg w-full max-h-[80vh] flex flex-col">
        <h2 className="text-sm font-semibold text-white mb-1">Inactive Project Review</h2>
        <p className="text-xs text-gray-400 mb-4">
          These projects haven't had any prompts in over a week. Mark them as inactive to declutter your dashboard.
        </p>

        <div className="flex-1 overflow-y-auto space-y-1 mb-4">
          {staleProjects.map((project: Project) => (
            <label
              key={project.id}
              className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-800/50 cursor-pointer transition-colors"
            >
              <input
                type="checkbox"
                checked={selected.has(project.id)}
                onChange={() => toggleProject(project.id)}
                className="rounded border-gray-600 bg-gray-800 text-indigo-500 focus:ring-indigo-500"
              />
              <div className="flex-1 min-w-0">
                <span className="text-sm text-gray-200 font-medium">{project.name}</span>
                <span className="ml-2 text-xs text-gray-500 font-mono">({project.code})</span>
              </div>
            </label>
          ))}
        </div>

        <div className="flex gap-2 justify-end">
          <button
            onClick={handleSkip}
            className="px-4 py-2 text-xs font-medium text-gray-400 hover:text-gray-200 transition-colors"
          >
            Skip
          </button>
          <button
            onClick={handleSaveInactive}
            disabled={selected.size === 0 || inactiveMutation.isPending}
            className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium transition-colors"
          >
            {inactiveMutation.isPending ? 'Saving...' : `Save Inactive (${selected.size})`}
          </button>
        </div>
      </div>
    </div>
  )
}
