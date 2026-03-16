import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listAllPrompts, createPrompt, createGlobalPrompt, updatePrompt, deletePrompt, listProjects } from '../api/client'
import type { Prompt, Project } from '../types'

export default function PromptsPage() {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<Prompt | null>(null)
  const [creating, setCreating] = useState(false)
  const [formName, setFormName] = useState('')
  const [formBody, setFormBody] = useState('')
  const [formProjectId, setFormProjectId] = useState('*') // default to global
  const [filterProjectId, setFilterProjectId] = useState('')

  const { data: prompts = [], isLoading } = useQuery({
    queryKey: ['prompts'],
    queryFn: listAllPrompts,
  })

  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
  })

  const projectMap = new Map<string, Project>()
  for (const p of projects) projectMap.set(p.id, p)

  const createMut = useMutation({
    mutationFn: () => {
      if (formProjectId === '*') {
        return createGlobalPrompt({ name: formName, body: formBody })
      }
      return createPrompt(formProjectId, { name: formName, body: formBody })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['prompts'] })
      resetForm()
    },
  })

  const updateMut = useMutation({
    mutationFn: () => updatePrompt(editing!.id, { name: formName, body: formBody }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['prompts'] })
      resetForm()
    },
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => deletePrompt(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['prompts'] }),
  })

  const resetForm = () => {
    setEditing(null)
    setCreating(false)
    setFormName('')
    setFormBody('')
    setFormProjectId('*')
  }

  const startEdit = (p: Prompt) => {
    setEditing(p)
    setCreating(false)
    setFormName(p.name)
    setFormBody(p.body)
    setFormProjectId(p.global ? '*' : (p.projectId || '*'))
  }

  const startCreate = () => {
    setEditing(null)
    setCreating(true)
    setFormName('')
    setFormBody('')
    setFormProjectId('*')
  }

  const filtered = filterProjectId === 'global'
    ? prompts.filter(p => p.global)
    : filterProjectId
      ? prompts.filter(p => p.projectId === filterProjectId || p.global)
      : prompts

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">Saved Prompts</h1>
          <p className="text-sm text-gray-500 mt-1">Create and manage reusable prompts for Claude Code sessions</p>
        </div>
        <button
          onClick={startCreate}
          className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors"
        >
          New Prompt
        </button>
      </div>

      {/* Filter by project */}
      <div className="mb-4">
        <select
          value={filterProjectId}
          onChange={e => setFilterProjectId(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-300"
        >
          <option value="">All</option>
          <option value="global">Global Only</option>
          {projects.map(p => (
            <option key={p.id} value={p.id}>{p.name} ({p.code})</option>
          ))}
        </select>
      </div>

      {/* Create / Edit form */}
      {(creating || editing) && (
        <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4 mb-6">
          <h2 className="text-sm font-semibold text-white mb-3">
            {editing ? 'Edit Prompt' : 'New Prompt'}
          </h2>
          <div className="space-y-3">
            <div className="flex gap-3">
              <input
                type="text"
                value={formName}
                onChange={e => setFormName(e.target.value)}
                placeholder="Prompt name..."
                className="flex-1 bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
              />
              {!editing && (
                <select
                  value={formProjectId}
                  onChange={e => setFormProjectId(e.target.value)}
                  className="bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-gray-300"
                >
                  <option value="*">All Projects (*)</option>
                  {projects.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              )}
            </div>
            <textarea
              value={formBody}
              onChange={e => setFormBody(e.target.value)}
              placeholder="Prompt body text..."
              rows={8}
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-white placeholder-gray-500 font-mono focus:outline-none focus:border-indigo-500 resize-y"
            />
            <div className="flex gap-2">
              <button
                onClick={() => editing ? updateMut.mutate() : createMut.mutate()}
                disabled={!formName.trim() || !formBody.trim() || createMut.isPending || updateMut.isPending}
                className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40 transition-colors"
              >
                {(createMut.isPending || updateMut.isPending) ? 'Saving...' : editing ? 'Update' : 'Create'}
              </button>
              <button
                onClick={resetForm}
                className="rounded bg-gray-700 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-gray-600 transition-colors"
              >
                Cancel
              </button>
            </div>
            {(createMut.isError || updateMut.isError) && (
              <p className="text-xs text-red-400">
                {(createMut.error || updateMut.error) instanceof Error
                  ? (createMut.error || updateMut.error)?.message
                  : 'Operation failed'}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Prompt list */}
      {isLoading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg bg-gray-800/50" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <p className="text-sm">No saved prompts yet.</p>
          <p className="text-xs mt-1">Create a prompt to reuse in your Claude Code chat sessions.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(prompt => {
            const project = prompt.projectId ? projectMap.get(prompt.projectId) : null
            return (
              <div
                key={prompt.id}
                className="bg-gray-800/40 border border-gray-700/50 rounded-lg p-4 hover:border-gray-600/50 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-sm font-medium text-white truncate">{prompt.name}</h3>
                      {prompt.global ? (
                        <span className="text-[10px] bg-indigo-600/30 text-indigo-300 px-1.5 py-0.5 rounded font-mono">
                          *
                        </span>
                      ) : project ? (
                        <span className="text-[10px] bg-gray-700 text-gray-400 px-1.5 py-0.5 rounded font-mono">
                          {project.code}
                        </span>
                      ) : null}
                    </div>
                    <p className="text-xs text-gray-500 font-mono line-clamp-2 whitespace-pre-wrap">{prompt.body}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => startEdit(prompt)}
                      className="p-1.5 text-gray-500 hover:text-gray-300 transition-colors rounded hover:bg-gray-700/50"
                      title="Edit"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
                      </svg>
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Delete prompt "${prompt.name}"?`)) {
                          deleteMut.mutate(prompt.id)
                        }
                      }}
                      className="p-1.5 text-gray-500 hover:text-red-400 transition-colors rounded hover:bg-gray-700/50"
                      title="Delete"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
