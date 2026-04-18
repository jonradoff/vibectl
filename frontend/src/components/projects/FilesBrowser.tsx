import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listDirectory, readFile, writeFile, generateVibectlMd } from '../../api/client'
import type { FileEntry } from '../../api/client'

import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import go from 'highlight.js/lib/languages/go'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import markdown from 'highlight.js/lib/languages/markdown'
import diff from 'highlight.js/lib/languages/diff'

// Register languages (some may already be registered from ChatView, but safe to re-register)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('tsx', typescript)
hljs.registerLanguage('jsx', javascript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('go', go)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('css', css)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)
hljs.registerLanguage('diff', diff)

const PINNED_KEY_PREFIX = 'vibectl-pinned-files-'
const DEFAULT_PINNED = ['CLAUDE.md', 'VIBECTL.md', 'README.md']
const PINNED_INITIALIZED_PREFIX = 'vibectl-pinned-init-'

function loadPinnedFiles(projectCode: string): Set<string> {
  try {
    const raw = localStorage.getItem(PINNED_KEY_PREFIX + projectId)
    if (raw) {
      const saved = new Set<string>(JSON.parse(raw))
      // On first load after feature addition, merge defaults
      if (!localStorage.getItem(PINNED_INITIALIZED_PREFIX + projectId)) {
        for (const d of DEFAULT_PINNED) saved.add(d)
        localStorage.setItem(PINNED_INITIALIZED_PREFIX + projectCode, '1')
        localStorage.setItem(PINNED_KEY_PREFIX + projectCode, JSON.stringify([...saved]))
      }
      return saved
    }
    // No saved data — use defaults and mark initialized
    localStorage.setItem(PINNED_INITIALIZED_PREFIX + projectCode, '1')
    return new Set(DEFAULT_PINNED)
  } catch {
    return new Set(DEFAULT_PINNED)
  }
}

function savePinnedFiles(projectCode: string, pinned: Set<string>) {
  localStorage.setItem(PINNED_KEY_PREFIX + projectCode, JSON.stringify([...pinned]))
}

interface FilesBrowserProps {
  projectCode: string
  localPath?: string
  githubUrl?: string
  onClone?: () => void
}

type SortField = 'name' | 'modTime' | 'size'
type SortDir = 'asc' | 'desc'

function sortEntries(entries: FileEntry[], field: SortField, dir: SortDir): FileEntry[] {
  const sorted = [...entries]
  sorted.sort((a, b) => {
    // Directories always come first
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1

    let cmp = 0
    switch (field) {
      case 'name':
        cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase())
        break
      case 'modTime':
        cmp = (a.modTime || '').localeCompare(b.modTime || '')
        break
      case 'size':
        cmp = (a.size || 0) - (b.size || 0)
        break
    }
    return dir === 'asc' ? cmp : -cmp
  })
  return sorted
}

function formatModTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays === 0) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
  if (diffDays < 7) {
    return `${diffDays}d ago`
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function FilesBrowser({ projectCode, localPath, githubUrl, onClone }: FilesBrowserProps) {
  const [currentPath, setCurrentPath] = useState('.')
  const [editingFile, setEditingFile] = useState<string | null>(null)
  const [pinnedFiles, setPinnedFiles] = useState(() => loadPinnedFiles(projectId))
  const [sortField, setSortField] = useState<SortField>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  const hasLocalPath = !!localPath

  const { data: entries, isLoading, error } = useQuery({
    queryKey: ['files', projectCode, currentPath],
    queryFn: () => listDirectory(projectCode, currentPath),
    enabled: hasLocalPath,
    retry: 1,
  })

  // Always fetch root entries so pinned files are available regardless of current path
  const { data: rootEntries } = useQuery({
    queryKey: ['files', projectCode, '.'],
    queryFn: () => listDirectory(projectCode, '.'),
    enabled: hasLocalPath,
    retry: 1,
  })

  if (!hasLocalPath) {
    return (
      <div className="flex items-center justify-center h-full p-4 text-center text-gray-500 text-xs">
        <div>
          <p className="mb-1">No local path configured.</p>
          <p>Set a local path in <span className="text-indigo-400 font-medium">Settings</span> to browse files.</p>
        </div>
      </div>
    )
  }

  const togglePin = useCallback((path: string) => {
    setPinnedFiles(prev => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      savePinnedFiles(projectCode, next)
      return next
    })
  }, [projectId])

  const navigateUp = useCallback(() => {
    if (currentPath === '.') return
    const parts = currentPath.split('/')
    parts.pop()
    setCurrentPath(parts.length === 0 ? '.' : parts.join('/'))
  }, [currentPath])

  const [createPrompt, setCreatePrompt] = useState<{ name: string; path: string } | null>(null)

  const navigateTo = useCallback((entry: FileEntry) => {
    if (entry.isDir) {
      setCurrentPath(entry.path)
      return
    }
    // Check if file exists in root listing
    const existsInListing = rootEntries?.some(e => e.name === entry.name || e.path === entry.path)
    if (!existsInListing && pinnedFiles.has(entry.name)) {
      // Pinned file that doesn't exist on disk — prompt to create
      setCreatePrompt({ name: entry.name, path: entry.path })
    } else {
      setEditingFile(entry.path)
    }
  }, [rootEntries, pinnedFiles])

  const handleSort = useCallback((field: SortField) => {
    setSortField(prev => {
      if (prev === field) {
        setSortDir(d => d === 'asc' ? 'desc' : 'asc')
        return field
      }
      setSortDir(field === 'modTime' ? 'desc' : 'asc')
      return field
    })
  }, [])

  // Build pinned entries for the pinned section at top
  const pinnedEntries: FileEntry[] = []
  const pinnedNamesFound = new Set<string>()
  if (rootEntries) {
    for (const e of rootEntries) {
      if (pinnedFiles.has(e.name) || pinnedFiles.has(e.path)) {
        pinnedEntries.push(e)
        pinnedNamesFound.add(e.name)
      }
    }
  }
  // Show pinned files that weren't found in listing (API not loaded yet, or file doesn't exist)
  for (const name of pinnedFiles) {
    if (!pinnedNamesFound.has(name)) {
      pinnedEntries.push({ name, path: name, isDir: false })
    }
  }

  // All directory entries (pinned files STILL appear here too, with a pin indicator)
  const allEntries = entries ? sortEntries(entries, sortField, sortDir) : []

  const breadcrumbs = currentPath === '.' ? [] : currentPath.split('/')
  const rootLabel = localPath || 'Project Root'

  const SortHeader = ({ field, label, className }: { field: SortField; label: string; className?: string }) => (
    <button
      onClick={() => handleSort(field)}
      className={`flex items-center gap-0.5 hover:text-gray-300 transition-colors ${className || ''}`}
    >
      <span>{label}</span>
      {sortField === field && (
        <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
          {sortDir === 'asc'
            ? <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
            : <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          }
        </svg>
      )}
    </button>
  )

  return (
    <div className="flex flex-col h-full">
      {/* Breadcrumb nav */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-gray-700/50 shrink-0 text-[11px] font-mono text-gray-500 bg-gray-900/50 min-w-0">
        <svg className="w-3.5 h-3.5 text-gray-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
        </svg>
        <button onClick={() => setCurrentPath('.')} className="hover:text-white transition-colors truncate" title={localPath || 'Project Root'}>
          {rootLabel}
        </button>
        {breadcrumbs.map((part, i) => (
          <span key={i} className="flex items-center gap-1 shrink-0">
            <span className="text-gray-600">/</span>
            <button
              onClick={() => setCurrentPath(breadcrumbs.slice(0, i + 1).join('/'))}
              className="hover:text-white transition-colors"
            >
              {part}
            </button>
          </span>
        ))}
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {/* Pinned files — quick access at top */}
        {pinnedEntries.length > 0 && (
          <>
            <div className="px-3 pt-1.5 pb-0.5 bg-gray-800/30">
              <span className="text-[9px] uppercase tracking-wider text-amber-500/60 font-medium">Pinned</span>
            </div>
            {pinnedEntries.map(entry => (
              <FileRow
                key={'pin-' + entry.path}
                entry={entry}
                isPinned={true}
                onNavigate={navigateTo}
                onTogglePin={togglePin}
                showModTime={false}
              />
            ))}
            <div className="mx-3 border-b border-gray-700/30 my-0.5" />
          </>
        )}

        {/* Column headers */}
        <div className="flex items-center px-3 py-1 border-b border-gray-700/30 text-[10px] text-gray-500 font-medium uppercase tracking-wider bg-gray-800/20 select-none">
          <div className="w-4 shrink-0 mr-2" /> {/* icon spacer */}
          <SortHeader field="name" label="Name" className="flex-1 min-w-0" />
          <SortHeader field="modTime" label="Modified" className="w-20 text-right justify-end" />
          <SortHeader field="size" label="Size" className="w-14 text-right justify-end" />
          <div className="w-6 shrink-0" /> {/* pin button spacer */}
        </div>

        {isLoading && (
          <div className="p-3 space-y-1">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-6 animate-pulse rounded bg-gray-700/50" />
            ))}
          </div>
        )}

        {error && !isLoading && (
          <div className="px-3 py-4 text-center text-xs text-red-400/80">
            <p>Failed to load files. The server may need to be rebuilt.</p>
            <p className="text-gray-600 mt-1">{error instanceof Error ? error.message : 'Unknown error'}</p>
          </div>
        )}

        {/* Up directory */}
        {currentPath !== '.' && (
          <button
            onClick={navigateUp}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-700/40 border-b border-gray-800/50 transition-colors"
          >
            <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" />
            </svg>
            <span className="text-xs text-gray-400">..</span>
          </button>
        )}

        {/* All directory entries (including pinned, with pin indicator) */}
        {allEntries.map(entry => (
          <FileRow
            key={entry.path}
            entry={entry}
            isPinned={pinnedFiles.has(entry.name) || pinnedFiles.has(entry.path)}
            onNavigate={navigateTo}
            onTogglePin={togglePin}
            showModTime={true}
          />
        ))}

        {entries && entries.length === 0 && currentPath === '.' && (
          <div className="flex flex-col items-center justify-center h-32 gap-3 text-center px-4">
            <p className="text-xs text-gray-500">This directory is empty.</p>
            {githubUrl && onClone && (
              <>
                <p className="text-[11px] text-gray-600 font-mono">{githubUrl}</p>
                <button
                  onClick={onClone}
                  className="rounded bg-indigo-600 hover:bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white transition-colors"
                >
                  Clone from GitHub
                </button>
              </>
            )}
          </div>
        )}
        {entries && entries.length === 0 && currentPath !== '.' && (
          <div className="flex items-center justify-center h-32 text-gray-500 text-xs">
            Empty directory
          </div>
        )}
      </div>

      {/* File editor modal — portaled to body to escape transform containment */}
      {editingFile && createPortal(
        <FileEditorModal
          projectId={projectCode}
          filePath={editingFile}
          onClose={() => setEditingFile(null)}
        />,
        document.body
      )}

      {/* Create file prompt — portaled to body */}
      {createPrompt && createPortal(
        <CreateFilePrompt
          projectId={projectCode}
          fileName={createPrompt.name}
          filePath={createPrompt.path}
          onCreated={(path) => {
            setCreatePrompt(null)
            setEditingFile(path)
          }}
          onCancel={() => setCreatePrompt(null)}
        />,
        document.body
      )}
    </div>
  )
}

function CreateFilePrompt({
  projectCode,
  fileName,
  filePath,
  onCreated,
  onCancel,
}: {
  projectCode: string
  fileName: string
  filePath: string
  onCreated: (path: string) => void
  onCancel: () => void
}) {
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isVibectlMd = fileName.toLowerCase() === 'vibectl.md'

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onCancel])

  const handleCreate = async () => {
    setCreating(true)
    setError(null)
    try {
      if (isVibectlMd) {
        // Generate VIBECTL.md via the dedicated endpoint
        await generateVibectlMd(projectId)
      } else {
        // Create an empty file
        await writeFile(projectCode, filePath, '')
      }
      queryClient.invalidateQueries({ queryKey: ['files', projectId] })
      onCreated(filePath)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create file')
      setCreating(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70" onClick={onCancel}>
      <div
        className="bg-gray-900 rounded-lg border border-gray-700 w-full max-w-md mx-4 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-indigo-600/20 flex items-center justify-center shrink-0">
            <svg className="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">File not found</h3>
            <p className="text-xs text-gray-400 font-mono">{fileName}</p>
          </div>
        </div>

        <p className="text-sm text-gray-300 mb-4">
          {isVibectlMd
            ? 'This file doesn\u2019t exist yet. Would you like to generate it? It will be populated with your project\u2019s current status, deployment info, and decisions.'
            : `This file doesn\u2019t exist yet. Would you like to create it?`
          }
        </p>

        {error && (
          <div className="rounded bg-red-900/30 px-3 py-2 text-xs text-red-400 mb-4">{error}</div>
        )}

        <div className="flex items-center gap-3">
          <button
            onClick={handleCreate}
            disabled={creating}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
          >
            {creating
              ? (isVibectlMd ? 'Generating...' : 'Creating...')
              : (isVibectlMd ? 'Generate' : 'Create')
            }
          </button>
          <button
            onClick={onCancel}
            className="rounded bg-gray-700 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-gray-600 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

function FileRow({
  entry,
  isPinned,
  onNavigate,
  onTogglePin,
  showModTime = false,
}: {
  entry: FileEntry
  isPinned: boolean
  onNavigate: (e: FileEntry) => void
  onTogglePin: (path: string) => void
  showModTime?: boolean
}) {
  return (
    <div className="group flex items-center hover:bg-gray-700/40 transition-colors">
      <button
        onClick={() => onNavigate(entry)}
        className="flex-1 flex items-center px-3 py-1.5 text-left min-w-0 gap-2"
      >
        {/* Icon */}
        {entry.isDir ? (
          <svg className="w-4 h-4 text-indigo-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
          </svg>
        ) : (
          <svg className="w-4 h-4 text-gray-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
          </svg>
        )}
        {/* Name + pin indicator */}
        <span className={`text-xs truncate flex-1 min-w-0 ${entry.isDir ? 'text-indigo-300' : 'text-gray-300'}`}>
          {isPinned && (
            <svg className="w-2.5 h-2.5 text-amber-400 inline mr-1 -mt-0.5" fill="currentColor" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z" />
            </svg>
          )}
          {entry.name}
        </span>
        {/* Modified time */}
        {showModTime && !entry.isDir && (
          <span className="w-20 text-right text-[10px] text-gray-600 font-mono shrink-0" title={entry.modTime || ''}>
            {formatModTime(entry.modTime)}
          </span>
        )}
        {/* Size */}
        {!entry.isDir && entry.size !== undefined && (
          <span className="w-14 text-right text-[10px] text-gray-600 font-mono shrink-0">
            {formatFileSize(entry.size)}
          </span>
        )}
      </button>
      {!entry.isDir && (
        <button
          onClick={(e) => { e.stopPropagation(); onTogglePin(entry.name) }}
          className={`px-2 py-1 shrink-0 transition-colors ${
            isPinned
              ? 'text-amber-400 hover:text-amber-300'
              : 'text-gray-700 hover:text-gray-400 opacity-0 group-hover:opacity-100'
          }`}
          title={isPinned ? 'Unpin' : 'Pin to top'}
        >
          <svg className="w-3 h-3" fill={isPinned ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z" />
          </svg>
        </button>
      )}
    </div>
  )
}

function FileEditorModal({ projectCode, filePath, onClose }: { projectCode: string; filePath: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [content, setContent] = useState('')
  const [isDirty, setIsDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const [showUnsavedPrompt, setShowUnsavedPrompt] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const { data: fileData, isLoading, error } = useQuery({
    queryKey: ['fileContent', projectCode, filePath],
    queryFn: () => readFile(projectCode, filePath),
    retry: false,
  })

  useEffect(() => {
    if (fileData) {
      setContent(fileData.content)
      setIsDirty(false)
    }
  }, [fileData])

  const tryClose = useCallback(() => {
    if (isDirty) {
      setShowUnsavedPrompt(true)
    } else {
      onClose()
    }
  }, [isDirty, onClose])

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (showUnsavedPrompt) return // let the unsaved prompt handle its own escape
      if (e.key === 'Escape') tryClose()
    }
    const handleSave = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        if (isDirty) saveMutation.mutate()
      }
    }
    window.addEventListener('keydown', handleEscape)
    window.addEventListener('keydown', handleSave)
    return () => {
      window.removeEventListener('keydown', handleEscape)
      window.removeEventListener('keydown', handleSave)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, tryClose, showUnsavedPrompt])

  const saveMutation = useMutation({
    mutationFn: () => writeFile(projectCode, filePath, content),
    onSuccess: () => {
      setIsDirty(false)
      setSaved(true)
      queryClient.invalidateQueries({ queryKey: ['fileContent', projectCode, filePath] })
      queryClient.invalidateQueries({ queryKey: ['files', projectId] })
      setTimeout(() => setSaved(false), 2000)
    },
  })

  const fileName = filePath.split('/').pop() || filePath
  const ext = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() || '' : ''
  const lang = extToLang(ext)


  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70" onClick={tryClose}>
      <div
        className="bg-gray-900 rounded-lg border border-gray-700 w-full max-w-6xl mx-4 flex flex-col h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-700 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-sm font-mono text-gray-300 truncate">{filePath}</span>
            {isDirty && <span className="text-[10px] text-amber-400 font-medium shrink-0">Modified</span>}
            {saved && <span className="text-[10px] text-green-400 font-medium shrink-0">Saved</span>}
            {lang && <span className="text-[10px] text-gray-600 font-mono shrink-0">{lang}</span>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => saveMutation.mutate()}
              disabled={!isDirty || saveMutation.isPending}
              className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-30 transition-colors"
            >
              {saveMutation.isPending ? 'Saving...' : 'Save'}
            </button>
            <span className="text-[10px] text-gray-600">Cmd+S</span>
            <button onClick={tryClose} className="text-gray-500 hover:text-gray-300 transition-colors ml-2">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Unsaved changes dialog */}
        {showUnsavedPrompt && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 rounded-lg">
            <div className="bg-gray-800 border border-gray-600 rounded-lg p-5 max-w-sm mx-4 shadow-xl">
              <h3 className="text-sm font-semibold text-white mb-2">Unsaved Changes</h3>
              <p className="text-xs text-gray-400 mb-4">You have unsaved changes. What would you like to do?</p>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    saveMutation.mutate(undefined, {
                      onSuccess: () => onClose(),
                    })
                    setShowUnsavedPrompt(false)
                  }}
                  className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 transition-colors"
                >
                  Save
                </button>
                <button
                  onClick={() => { setShowUnsavedPrompt(false); onClose() }}
                  className="rounded bg-red-600/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 transition-colors"
                >
                  Discard
                </button>
                <button
                  onClick={() => setShowUnsavedPrompt(false)}
                  className="rounded bg-gray-700 px-3 py-1.5 text-xs font-medium text-gray-300 hover:bg-gray-600 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Editor */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {isLoading && (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">Loading...</div>
          )}
          {error && !isLoading && (
            <div className="flex items-center justify-center h-full text-red-400 text-sm">
              {error instanceof Error ? error.message : 'Failed to load file'}
            </div>
          )}
          {fileData && (
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => { setContent(e.target.value); setIsDirty(true) }}
              spellCheck={false}
              className="w-full h-full p-4 font-mono text-[13px] leading-relaxed bg-gray-950 text-gray-200 resize-none focus:outline-none overflow-auto border-none"
            />
          )}
        </div>

        {/* Footer */}
        {saveMutation.isError && (
          <div className="px-4 py-2 border-t border-gray-700 text-xs text-red-400">
            Save failed: {saveMutation.error instanceof Error ? saveMutation.error.message : 'Unknown error'}
          </div>
        )}
      </div>
    </div>
  )
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}

function extToLang(ext: string): string | null {
  const map: Record<string, string> = {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', go: 'go', sh: 'bash', bash: 'bash', zsh: 'bash',
    json: 'json', css: 'css', html: 'html', xml: 'xml',
    yaml: 'yaml', yml: 'yaml', md: 'markdown', diff: 'diff',
    makefile: 'bash', dockerfile: 'bash', toml: 'yaml', env: 'bash',
    sql: 'sql', rs: 'rust', java: 'java', rb: 'ruby', php: 'php',
    mod: 'go', sum: 'plaintext',
  }
  return map[ext] || null
}

