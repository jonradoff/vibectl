import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getAdapterStatus, getRecommendedPlugins, refreshAdapters } from '../../api/client'
import type { RecommendedPlugin } from '../../types'

export default function AdaptersSection() {
  const queryClient = useQueryClient()

  const { data: status } = useQuery({
    queryKey: ['adapterStatus'],
    queryFn: getAdapterStatus,
    staleTime: 60_000,
  })

  const { data: recommended = [] } = useQuery({
    queryKey: ['recommendedPlugins'],
    queryFn: getRecommendedPlugins,
    staleTime: 60_000,
  })

  const refreshMutation = useMutation({
    mutationFn: refreshAdapters,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['adapterStatus'] })
      queryClient.invalidateQueries({ queryKey: ['recommendedPlugins'] })
    },
  })

  const detectedCount = status?.adapters?.length ?? 0

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-white">Integrations</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Third-party Claude Code plugins that enhance VibeCtl with additional data
          </p>
        </div>
        <button
          onClick={() => refreshMutation.mutate()}
          disabled={refreshMutation.isPending}
          className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 bg-gray-700 hover:bg-gray-600 rounded transition-colors disabled:opacity-50"
        >
          {refreshMutation.isPending ? 'Scanning...' : 'Rescan'}
        </button>
      </div>

      {/* Detected adapters summary */}
      {detectedCount > 0 ? (
        <div className="mb-4 rounded bg-green-900/20 border border-green-700/30 px-4 py-2.5 text-xs text-green-300">
          {detectedCount} integration{detectedCount !== 1 ? 's' : ''} active: {status?.adapters?.join(', ')}
        </div>
      ) : (
        <div className="mb-4 rounded bg-gray-700/30 border border-gray-600/30 px-4 py-2.5 text-xs text-gray-500">
          No integrations detected. Install a recommended plugin below to get started.
        </div>
      )}

      {/* Recommended plugins */}
      <div className="space-y-3">
        {recommended.map((plugin: RecommendedPlugin) => (
          <div
            key={plugin.id}
            className={`rounded-lg border p-4 ${
              plugin.installed && plugin.enabled
                ? 'border-green-700/40 bg-green-900/10'
                : plugin.installed
                ? 'border-amber-700/40 bg-amber-900/10'
                : 'border-gray-700/40 bg-gray-800/50'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-white">{plugin.name}</span>
                  {plugin.installed && plugin.enabled && (
                    <span className="rounded bg-green-800/50 px-1.5 py-0.5 text-[10px] text-green-400 font-medium">Active</span>
                  )}
                  {plugin.installed && !plugin.enabled && (
                    <span className="rounded bg-amber-800/50 px-1.5 py-0.5 text-[10px] text-amber-400 font-medium">Installed (disabled)</span>
                  )}
                  {!plugin.installed && (
                    <span className="rounded bg-gray-700/50 px-1.5 py-0.5 text-[10px] text-gray-500 font-medium">Not installed</span>
                  )}
                </div>
                <p className="text-xs text-gray-400 mt-1">{plugin.description}</p>

                {/* Features list */}
                <div className="mt-2">
                  <span className="text-[10px] text-gray-600 uppercase tracking-wider">VibeCtl features when active:</span>
                  <ul className="mt-1 space-y-0.5">
                    {plugin.features.map((f, i) => (
                      <li key={i} className="flex items-center gap-1.5 text-[11px]">
                        <span className={plugin.installed && plugin.enabled ? 'text-green-500' : 'text-gray-600'}>
                          {plugin.installed && plugin.enabled ? '✓' : '○'}
                        </span>
                        <span className={plugin.installed && plugin.enabled ? 'text-gray-300' : 'text-gray-500'}>
                          {f}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Action */}
              <div className="shrink-0">
                {!plugin.installed ? (
                  <div className="text-right">
                    <a
                      href={plugin.installUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block px-3 py-1.5 bg-indigo-600 text-white text-xs font-medium rounded hover:bg-indigo-500 transition-colors"
                    >
                      View on GitHub
                    </a>
                    <p className="text-[10px] text-gray-600 mt-1">
                      Install via: <code className="text-gray-500">/plugins</code> in Claude Code
                    </p>
                  </div>
                ) : plugin.installed && plugin.enabled ? (
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full bg-green-500" />
                    <span className="text-[10px] text-green-400">Connected</span>
                  </div>
                ) : (
                  <div className="text-right">
                    <p className="text-[10px] text-amber-400">Enable in Claude Code settings</p>
                    <p className="text-[10px] text-gray-600 mt-0.5">
                      or type <code className="text-gray-500">/plugins</code>
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
