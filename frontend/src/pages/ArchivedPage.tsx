import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listArchivedProjects, unarchiveProject, deleteProject } from '../api/client'
import type { Project } from '../types'

function ArchivedPage() {
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
      <div className="min-h-screen bg-gray-950 p-6">
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg bg-gray-800" />
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-950 p-6">
        <div className="rounded bg-red-900/30 p-4 text-red-400">
          Failed to load archived projects: {(error as Error).message}
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-950 p-6">
      <h1 className="text-2xl font-bold text-white mb-6">Archived Projects</h1>

      {(!projects || projects.length === 0) ? (
        <div className="rounded-lg border border-gray-700 bg-gray-800 p-12 text-center">
          <p className="text-lg text-gray-400">No archived projects.</p>
          <p className="mt-1 text-sm text-gray-500">Projects you archive from the dashboard will appear here.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {projects.map((project) => (
            <div
              key={project.id}
              className="flex items-center justify-between rounded-lg border border-gray-700 bg-gray-800 px-5 py-4"
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-white">{project.name}</span>
                  <span className="rounded bg-gray-700 px-1.5 py-0.5 text-[10px] font-mono text-gray-400">
                    {project.code}
                  </span>
                </div>
                {project.description && (
                  <p className="mt-1 text-xs text-gray-500 line-clamp-1">{project.description}</p>
                )}
                <p className="mt-1 text-[10px] text-gray-600">
                  Archived {new Date(project.updatedAt).toLocaleDateString()}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => unarchiveMutation.mutate(project.id)}
                  disabled={unarchiveMutation.isPending}
                  className="rounded bg-indigo-600/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  Restore
                </button>
                <button
                  onClick={() => setConfirmDelete(project)}
                  className="rounded border border-red-800/50 bg-red-900/30 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-900/50 transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Permanent delete confirmation modal */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-md rounded-xl bg-gray-800 shadow-2xl border border-gray-700">
            <div className="px-6 pt-6 pb-4">
              <h3 className="text-sm font-semibold text-white mb-1">Permanently delete project?</h3>
              <p className="text-xs text-gray-400 mb-3">
                This will permanently delete{' '}
                <span className="font-medium text-gray-200">{confirmDelete.name}</span>{' '}
                and <span className="font-medium text-red-400">all of its issues</span>. This cannot be undone.
              </p>
              <div className="rounded-lg bg-red-950/40 border border-red-900/50 px-4 py-3 text-xs text-red-300 space-y-1">
                <p className="font-medium">The following will be permanently removed:</p>
                <ul className="list-disc list-inside text-red-400 space-y-0.5 mt-1">
                  <li>Project and all its settings</li>
                  <li>All issues (open, closed, and archived)</li>
                </ul>
              </div>
              {deleteMutation.isError && (
                <p className="mt-3 text-xs text-red-400">
                  {deleteMutation.error instanceof Error ? deleteMutation.error.message : 'Failed to delete'}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 px-6 pb-5">
              <button
                onClick={() => { setConfirmDelete(null); deleteMutation.reset() }}
                disabled={deleteMutation.isPending}
                className="rounded-lg px-4 py-2 text-xs text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteMutation.mutate(confirmDelete.id)}
                disabled={deleteMutation.isPending}
                className="rounded-lg bg-red-700 hover:bg-red-600 px-4 py-2 text-xs font-medium text-white transition-colors disabled:opacity-75"
              >
                {deleteMutation.isPending ? 'Deleting…' : 'Delete permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ArchivedPage
