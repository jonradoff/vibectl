import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listPlugins, listAvailablePlugins, listPluginMarketplaces, addPluginMarketplace, enablePlugin, disablePlugin, installPlugin, uninstallPlugin } from '../../api/client'
import type { InstalledPlugin, AvailablePlugin } from '../../types'

interface Props {
  onClose: () => void
  onRestart: () => void // triggers /reload to restart Claude Code
}

export default function PluginManagerModal({ onClose, onRestart }: Props) {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'installed' | 'browse' | 'marketplaces'>('installed')
  const [needsRestart, setNeedsRestart] = useState(false)
  const [search, setSearch] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [newMktId, setNewMktId] = useState('')
  const [newMktRepo, setNewMktRepo] = useState('')

  const { data: installed = [], isLoading: installedLoading } = useQuery({
    queryKey: ['plugins'],
    queryFn: listPlugins,
  })

  const { data: available = [], isLoading: availableLoading } = useQuery({
    queryKey: ['availablePlugins'],
    queryFn: listAvailablePlugins,
    enabled: tab === 'browse',
  })

  const { data: marketplaces = [] } = useQuery({
    queryKey: ['pluginMarketplaces'],
    queryFn: listPluginMarketplaces,
    enabled: tab === 'marketplaces',
  })

  const installedIds = new Set(installed.map(p => p.id))

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['plugins'] })
    queryClient.invalidateQueries({ queryKey: ['pluginCommands'] })
    queryClient.invalidateQueries({ queryKey: ['availablePlugins'] })
  }

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      enabled ? enablePlugin(id) : disablePlugin(id),
    onSuccess: () => { invalidateAll(); setNeedsRestart(true) },
  })

  const installMutation = useMutation({
    mutationFn: ({ marketplace, name }: { marketplace: string; name: string }) =>
      installPlugin(marketplace, name),
    onSuccess: () => { invalidateAll(); setNeedsRestart(true) },
  })

  const uninstallMutation = useMutation({
    mutationFn: (id: string) => uninstallPlugin(id),
    onSuccess: () => { invalidateAll(); setNeedsRestart(true) },
  })

  const addMktMutation = useMutation({
    mutationFn: () => addPluginMarketplace(newMktId, newMktRepo),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pluginMarketplaces'] })
      setNewMktId('')
      setNewMktRepo('')
    },
  })

  const filteredAvailable = search
    ? available.filter((p: AvailablePlugin) => p.name.toLowerCase().includes(search.toLowerCase()))
    : available

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl max-w-3xl w-full max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700/50 shrink-0">
          <h2 className="text-sm font-bold text-white">Plugin Manager</h2>
          <div className="flex items-center gap-3">
            {needsRestart && (
              <button
                onClick={() => { onRestart(); onClose() }}
                className="px-3 py-1 bg-amber-600 text-white text-xs font-medium rounded hover:bg-amber-500 animate-pulse"
              >
                Restart Claude Code
              </button>
            )}
            <button onClick={onClose} className="text-gray-500 hover:text-gray-300">&times;</button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-5 py-2 border-b border-gray-700/50 shrink-0">
          {(['installed', 'browse', 'marketplaces'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                tab === t ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {t === 'installed' ? `Installed (${installed.length})` : t === 'browse' ? 'Browse' : 'Marketplaces'}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {tab === 'installed' && (
            <div className="p-4">
              {installedLoading ? (
                <div className="text-center py-8 text-gray-500 text-sm">Loading plugins...</div>
              ) : installed.length === 0 ? (
                <div className="text-center py-8 text-gray-600">
                  <p className="text-sm">No plugins installed</p>
                  <p className="text-xs mt-1">Browse the marketplace to find plugins</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {installed.map((p: InstalledPlugin) => (
                    <div key={p.id} className="rounded border border-gray-700/50 bg-gray-800/50 overflow-hidden">
                      <div className="flex items-center gap-3 px-4 py-2.5">
                        {/* Toggle */}
                        <button
                          onClick={() => toggleMutation.mutate({ id: p.id, enabled: !p.enabled })}
                          className={`w-8 h-4 rounded-full transition-colors relative shrink-0 ${p.enabled ? 'bg-green-600' : 'bg-gray-600'}`}
                        >
                          <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${p.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                        </button>
                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-gray-200">{p.name}</span>
                            <span className="text-[10px] text-gray-600 font-mono">v{p.version}</span>
                            {p.author && <span className="text-[10px] text-gray-500">by {p.author}</span>}
                          </div>
                          {p.description && <p className="text-[11px] text-gray-500 truncate">{p.description}</p>}
                        </div>
                        {/* Expand / Uninstall */}
                        <button
                          onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
                          className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
                        >{expandedId === p.id ? 'Less' : 'More'}</button>
                      </div>
                      {expandedId === p.id && (
                        <div className="px-4 py-2 border-t border-gray-700/30 space-y-2">
                          {p.commands.length > 0 && (
                            <div>
                              <span className="text-[10px] text-gray-600 uppercase">Commands</span>
                              <div className="flex flex-wrap gap-1 mt-0.5">
                                {p.commands.map(c => (
                                  <span key={c.name} className="rounded bg-indigo-900/30 px-1.5 py-0.5 text-[10px] text-indigo-300 font-mono">/{c.name}</span>
                                ))}
                              </div>
                            </div>
                          )}
                          {p.skills.length > 0 && (
                            <div>
                              <span className="text-[10px] text-gray-600 uppercase">Skills</span>
                              <div className="flex flex-wrap gap-1 mt-0.5">
                                {p.skills.map(s => (
                                  <span key={s.name} className="rounded bg-cyan-900/30 px-1.5 py-0.5 text-[10px] text-cyan-300">{s.name}</span>
                                ))}
                              </div>
                            </div>
                          )}
                          {p.keywords && p.keywords.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {p.keywords.map(k => (
                                <span key={k} className="rounded bg-gray-700/50 px-1.5 py-0.5 text-[9px] text-gray-500">{k}</span>
                              ))}
                            </div>
                          )}
                          <button
                            onClick={() => { if (confirm(`Uninstall ${p.name}?`)) uninstallMutation.mutate(p.id) }}
                            disabled={uninstallMutation.isPending}
                            className="text-[10px] text-red-400 hover:text-red-300 transition-colors"
                          >Uninstall</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'browse' && (
            <div className="p-4 space-y-3">
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search plugins..."
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-indigo-500"
              />
              {availableLoading ? (
                <div className="text-center py-8 text-gray-500 text-sm">Loading marketplace...</div>
              ) : (
                <div className="space-y-1 max-h-[50vh] overflow-y-auto">
                  {filteredAvailable.slice(0, 100).map((p: AvailablePlugin) => (
                    <div key={p.id} className="flex items-center gap-3 px-3 py-2 rounded bg-gray-800/30 hover:bg-gray-800/60 transition-colors">
                      <div className="flex-1 min-w-0">
                        <span className="text-xs font-medium text-gray-300">{p.name}</span>
                        {p.marketplace && <span className="ml-1.5 text-[9px] text-gray-600">{p.marketplace}</span>}
                      </div>
                      <span className="text-[10px] text-gray-600 shrink-0">{p.uniqueInstalls.toLocaleString()} installs</span>
                      {installedIds.has(p.id) ? (
                        <span className="text-[10px] text-green-500 shrink-0">Installed</span>
                      ) : (
                        <button
                          onClick={() => {
                            const parts = p.id.split('@')
                            installMutation.mutate({ marketplace: parts[1] || '', name: parts[0] })
                          }}
                          disabled={installMutation.isPending}
                          className="px-2 py-0.5 bg-indigo-600 text-white text-[10px] rounded hover:bg-indigo-500 disabled:opacity-50 shrink-0"
                        >Install</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'marketplaces' && (
            <div className="p-4 space-y-3">
              {marketplaces.length === 0 ? (
                <div className="text-center py-4 text-gray-600 text-sm">No marketplaces registered</div>
              ) : (
                <div className="space-y-1.5">
                  {marketplaces.map(m => (
                    <div key={m.id} className="flex items-center gap-3 px-3 py-2 rounded bg-gray-800/30">
                      <span className="text-xs font-medium text-gray-300">{m.id}</span>
                      <span className="text-[10px] text-gray-500">{m.source}: {m.repo}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="border-t border-gray-700/50 pt-3">
                <p className="text-[10px] text-gray-500 mb-2">Add a marketplace from a GitHub repo:</p>
                <div className="flex gap-2">
                  <input
                    value={newMktId}
                    onChange={e => setNewMktId(e.target.value)}
                    placeholder="marketplace-id"
                    className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-indigo-500"
                  />
                  <input
                    value={newMktRepo}
                    onChange={e => setNewMktRepo(e.target.value)}
                    placeholder="owner/repo"
                    className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    onClick={() => addMktMutation.mutate()}
                    disabled={!newMktId.trim() || !newMktRepo.trim() || addMktMutation.isPending}
                    className="px-3 py-1.5 bg-indigo-600 text-white text-xs rounded hover:bg-indigo-500 disabled:opacity-50"
                  >Add</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
