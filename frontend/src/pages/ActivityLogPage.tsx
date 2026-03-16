import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listActivityLog, listProjects } from '../api/client'
import type { ActivityLogEntry, Project } from '../types'

const LOG_TYPE_LABELS: Record<string, { label: string; color: string; icon: string }> = {
  backend_start: { label: 'Server Start', color: 'text-blue-400', icon: 'M5.25 14.25h13.5m-13.5 0a3 3 0 0 1-3-3m3 3a3 3 0 1 0 0 6h13.5a3 3 0 1 0 0-6m-16.5-3a3 3 0 0 1 3-3h13.5a3 3 0 0 1 3 3m-19.5 0a4.5 4.5 0 0 1 .9-2.7L5.737 5.1a3.375 3.375 0 0 1 2.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 0 1 .9 2.7m0 0a3 3 0 0 1-3 3m0 3h.008v.008h-.008v-.008Zm0-6h.008v.008h-.008v-.008Zm-3 6h.008v.008h-.008v-.008Zm0-6h.008v.008h-.008v-.008Z' },
  prompt_sent: { label: 'Prompt Sent', color: 'text-indigo-400', icon: 'M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z' },
  file_edit: { label: 'File Edit', color: 'text-amber-400', icon: 'M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z' },
  settings_change: { label: 'Settings', color: 'text-gray-400', icon: 'M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z' },
  issue_created: { label: 'Issue Created', color: 'text-green-400', icon: 'M12 9v6m3-3H9m12 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z' },
  issue_status: { label: 'Issue Status', color: 'text-cyan-400', icon: 'M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5' },
  prompt_created: { label: 'Prompt Created', color: 'text-purple-400', icon: 'M12 4.5v15m7.5-7.5h-15' },
  prompt_edited: { label: 'Prompt Edited', color: 'text-purple-300', icon: 'm16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125' },
  prompt_deleted: { label: 'Prompt Deleted', color: 'text-red-400', icon: 'm14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0' },
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHrs = Math.floor(diffMin / 60)
  if (diffHrs < 24) return `${diffHrs}h ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function ActivityLogPage() {
  const [filterType, setFilterType] = useState('')
  const [filterProjectId, setFilterProjectId] = useState('')
  const [limit] = useState(50)
  const [offset, setOffset] = useState(0)

  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['activity-log', filterProjectId, filterType, limit, offset],
    queryFn: () => listActivityLog({
      projectId: filterProjectId || undefined,
      type: filterType || undefined,
      limit,
      offset,
    }),
    refetchInterval: 10000,
  })

  const entries = data?.entries || []
  const total = data?.total || 0
  const projectMap = new Map(projects.map(p => [p.id, p]))

  const allTypes = Object.keys(LOG_TYPE_LABELS)

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-white">Activity Log</h1>
        <p className="text-sm text-gray-500 mt-1">System activity and event history</p>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-4">
        <select
          value={filterProjectId}
          onChange={e => { setFilterProjectId(e.target.value); setOffset(0) }}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-300"
        >
          <option value="">All Projects</option>
          {projects.map(p => (
            <option key={p.id} value={p.id}>{p.name} ({p.code})</option>
          ))}
        </select>
        <select
          value={filterType}
          onChange={e => { setFilterType(e.target.value); setOffset(0) }}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-300"
        >
          <option value="">All Types</option>
          {allTypes.map(t => (
            <option key={t} value={t}>{LOG_TYPE_LABELS[t]?.label || t}</option>
          ))}
        </select>
        <span className="text-xs text-gray-600 self-center ml-auto">
          {total} total entries
        </span>
      </div>

      {/* Log entries */}
      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded bg-gray-800/50" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <div className="text-center py-12 text-gray-500 text-sm">
          No activity logged yet.
        </div>
      ) : (
        <div className="space-y-1">
          {entries.map((entry: ActivityLogEntry) => (
            <ActivityLogRow
              key={entry.id}
              entry={entry}
              project={entry.projectId ? projectMap.get(entry.projectId) : undefined}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {total > limit && (
        <div className="flex items-center justify-center gap-3 mt-4 pt-4 border-t border-gray-800">
          <button
            onClick={() => setOffset(Math.max(0, offset - limit))}
            disabled={offset === 0}
            className="text-xs text-gray-400 hover:text-white disabled:opacity-30 transition-colors"
          >
            Newer
          </button>
          <span className="text-xs text-gray-600">
            {offset + 1} - {Math.min(offset + limit, total)} of {total}
          </span>
          <button
            onClick={() => setOffset(offset + limit)}
            disabled={offset + limit >= total}
            className="text-xs text-gray-400 hover:text-white disabled:opacity-30 transition-colors"
          >
            Older
          </button>
        </div>
      )}
    </div>
  )
}

function ActivityLogRow({ entry, project }: { entry: ActivityLogEntry; project?: Project }) {
  const [expanded, setExpanded] = useState(false)
  const meta = LOG_TYPE_LABELS[entry.type] || { label: entry.type, color: 'text-gray-400', icon: 'M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z' }
  const fullText = (entry.metadata?.fullText as string) || ''
  const hasMore = !!fullText && fullText !== entry.snippet

  return (
    <div className="flex items-start gap-3 px-3 py-2.5 rounded-lg hover:bg-gray-800/40 transition-colors">
      <svg className={`w-4 h-4 mt-0.5 shrink-0 ${meta.color}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d={meta.icon} />
      </svg>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-medium ${meta.color}`}>{meta.label}</span>
          {project ? (
            <span className="text-[10px] bg-gray-700/50 text-gray-400 px-1.5 py-0.5 rounded font-mono">
              {project.name} ({project.code})
            </span>
          ) : (
            <span className="text-[10px] bg-gray-700/30 text-gray-600 px-1.5 py-0.5 rounded font-mono">
              System
            </span>
          )}
          <span className="text-[10px] text-gray-600 ml-auto shrink-0">{formatTime(entry.timestamp)}</span>
        </div>
        <p className="text-xs text-gray-300 mt-0.5">{entry.message}</p>
        {entry.snippet && (
          <p className={`text-[11px] text-gray-400 font-mono bg-gray-800/50 rounded px-2 py-1 mt-1 whitespace-pre-wrap ${expanded ? '' : 'line-clamp-2'}`}>
            {expanded ? fullText : entry.snippet}
            {hasMore && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="text-[10px] text-indigo-400 hover:text-indigo-300 ml-1 inline"
              >
                [{expanded ? 'less' : 'more'}]
              </button>
            )}
          </p>
        )}
      </div>
    </div>
  )
}
