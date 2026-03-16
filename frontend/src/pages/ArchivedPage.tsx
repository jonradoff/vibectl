import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listArchivedProjects, unarchiveProject } from '../api/client'

function ArchivedPage() {
  const queryClient = useQueryClient()
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
              <button
                onClick={() => unarchiveMutation.mutate(project.id)}
                disabled={unarchiveMutation.isPending}
                className="rounded bg-indigo-600/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                Restore
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default ArchivedPage
