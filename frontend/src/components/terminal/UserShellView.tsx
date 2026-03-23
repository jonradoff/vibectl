import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { getStoredToken, getLocalPaths, setLocalPath } from '../../api/client'
import { notifyServerRestarting } from '../shared/RebuildOverlay'
import { useMode } from '../../contexts/ModeContext'
import '@xterm/xterm/css/xterm.css'

interface UserShellViewProps {
  projectId: string
  compact?: boolean
  onStatusChange?: (status: string) => void
}

interface WSMessage {
  type: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any
}

type PathStatus = 'resolving' | 'ready' | 'unconfigured'

export default function UserShellView({ projectId, compact, onStatusChange }: UserShellViewProps) {
  const termNodeRef = useRef<HTMLDivElement | null>(null)
  const inlineSlotRef = useRef<HTMLDivElement>(null)
  const fullscreenSlotRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onDataDisposable = useRef<{ dispose: () => void } | null>(null)
  const [status, setStatus] = useState<string>('disconnected')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const mountedRef = useRef(true)

  // Path resolution for client mode
  const { displayMode } = useMode()
  const isClientMode = displayMode === 'client'
  const [pathStatus, setPathStatus] = useState<PathStatus>('resolving')
  const [workDir, setWorkDir] = useState<string>('')
  const [setupInput, setSetupInput] = useState<string>('')
  const [setupError, setSetupError] = useState<string>('')
  const [setupSaving, setSetupSaving] = useState(false)
  const [showPathChange, setShowPathChange] = useState(false)

  const fontSize = compact && !isFullscreen ? 11 : 14

  const updateStatus = (s: string) => {
    setStatus(s)
    onStatusChange?.(s)
  }

  // Resolve local path in client mode before connecting
  useEffect(() => {
    if (!isClientMode) {
      setPathStatus('ready')
      return
    }
    getLocalPaths()
      .then(paths => {
        const p = paths[projectId]
        if (p) {
          setWorkDir(p)
          setSetupInput(p)
          setPathStatus('ready')
        } else {
          setPathStatus('unconfigured')
        }
      })
      .catch(() => setPathStatus('unconfigured'))
  }, [projectId, isClientMode])

  const handleSetupSave = async () => {
    if (!setupInput.trim()) return
    setSetupSaving(true)
    setSetupError('')
    try {
      await setLocalPath(projectId, setupInput.trim())
      setWorkDir(setupInput.trim())
      setPathStatus('ready')
      setShowPathChange(false)
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : 'Failed to save path')
    } finally {
      setSetupSaving(false)
    }
  }

  const connect = (currentWorkDir: string) => {
    if (!terminalRef.current || !mountedRef.current) return
    const terminal = terminalRef.current
    const token = getStoredToken() ?? ''

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wdParam = currentWorkDir ? `&workDir=${encodeURIComponent(currentWorkDir)}` : ''
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/ws/shell?token=${encodeURIComponent(token)}&projectId=${encodeURIComponent(projectId)}${wdParam}`
    )
    wsRef.current = ws

    ws.onopen = () => updateStatus('connecting')

    ws.onmessage = (event) => {
      const msg: WSMessage = JSON.parse(event.data)
      switch (msg.type) {
        case 'output':
          if (msg.data?.data) terminal.write(msg.data.data)
          break
        case 'status':
          updateStatus(msg.data?.status || 'unknown')
          break
        case 'error':
          terminal.write(`\r\n\x1b[31mError: ${msg.data?.message ?? 'unknown'}\x1b[0m\r\n`)
          // If the path doesn't exist on disk, surface the change-path UI
          if (msg.data?.message?.includes('does not exist')) {
            setShowPathChange(true)
          }
          break
        case 'server_restarting':
          notifyServerRestarting()
          break
      }
    }

    ws.onclose = () => {
      if (!mountedRef.current) return
      updateStatus('disconnected')
      reconnectTimer.current = setTimeout(() => {
        if (mountedRef.current) {
          terminal.write('\r\n\x1b[33mReconnecting...\x1b[0m\r\n')
          connect(currentWorkDir)
        }
      }, 3000)
    }

    ws.onerror = () => updateStatus('error')

    if (onDataDisposable.current) onDataDisposable.current.dispose()
    onDataDisposable.current = terminal.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data: { data } }))
      }
    })
  }

  useEffect(() => {
    if (!inlineSlotRef.current || pathStatus !== 'ready') return
    mountedRef.current = true

    const termNode = document.createElement('div')
    termNode.style.flex = '1'
    termNode.style.overflow = 'hidden'
    termNode.style.minHeight = '0'
    inlineSlotRef.current.appendChild(termNode)
    termNodeRef.current = termNode

    const terminal = new Terminal({
      cursorBlink: true,
      theme: {
        background: '#1a1b26',
        foreground: '#c0caf5',
        cursor: '#c0caf5',
        selectionBackground: '#33467c',
      },
      fontSize,
      fontFamily: 'ui-monospace, Consolas, monospace',
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(termNode)
    fitAddon.fit()

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    const doResize = () => {
      fitAddon.fit()
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', data: { cols: terminal.cols, rows: terminal.rows } }))
      }
    }

    window.addEventListener('resize', doResize)
    const ro = new ResizeObserver(() => requestAnimationFrame(doResize))
    ro.observe(termNode)

    connect(workDir)

    return () => {
      mountedRef.current = false
      window.removeEventListener('resize', doResize)
      ro.disconnect()
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      if (wsRef.current) wsRef.current.close()
      terminal.dispose()
      termNode.remove()
      termNodeRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, pathStatus, workDir])

  useEffect(() => {
    const termNode = termNodeRef.current
    if (!termNode) return
    const target = isFullscreen ? fullscreenSlotRef.current : inlineSlotRef.current
    if (target && termNode.parentElement !== target) target.appendChild(termNode)
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current
    if (terminal && fitAddon) {
      terminal.options.fontSize = fontSize
      requestAnimationFrame(() => {
        fitAddon.fit()
        const ws = wsRef.current
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', data: { cols: terminal.cols, rows: terminal.rows } }))
        }
      })
    }
  }, [isFullscreen, fontSize])

  useEffect(() => {
    if (!isFullscreen) return
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsFullscreen(false) }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [isFullscreen])

  const statusColor = ({
    connecting: 'bg-yellow-500',
    started: 'bg-green-500',
    disconnected: 'bg-gray-500',
    error: 'bg-red-500',
    exited: 'bg-gray-500',
  } as Record<string, string>)[status] ?? 'bg-gray-500'

  const header = (
    <div className="flex items-center justify-between px-3 py-1 bg-gray-900 border-b border-gray-700 text-xs shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className={`w-2 h-2 rounded-full shrink-0 ${statusColor}`} />
        <span className="text-gray-400">{status}</span>
        {isClientMode && workDir && (
          <span className="text-gray-600 truncate max-w-48" title={workDir}>{workDir}</span>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {isClientMode && workDir && (
          <button
            onClick={() => { setShowPathChange(v => !v) }}
            className="text-gray-500 hover:text-gray-300 transition-colors"
            title="Change local path"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
        )}
        <button
          onClick={() => setIsFullscreen(f => !f)}
          className="text-gray-500 hover:text-gray-300 transition-colors"
          title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
        >
          {isFullscreen ? (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
          )}
        </button>
      </div>
    </div>
  )

  // Inline path setup form (shown as overlay when unconfigured or when user clicks change)
  const pathSetupForm = (
    <div className="flex flex-col items-center justify-center h-full px-6 py-8 text-center">
      <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center mb-4">
        <svg className="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
      </div>
      <p className="text-sm font-medium text-white mb-1">
        {showPathChange ? 'Change local path' : 'Set up local path'}
      </p>
      <p className="text-xs text-gray-400 mb-4 max-w-xs">
        {showPathChange
          ? 'Enter the new local directory for this project. The shell will restart in that directory.'
          : 'This project has no local path configured. Enter the local directory where you\'ve checked out this project.'}
      </p>
      <input
        type="text"
        value={setupInput}
        onChange={e => setSetupInput(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && handleSetupSave()}
        placeholder="/Users/you/projects/myproject"
        autoFocus
        className="w-full max-w-sm bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 mb-3"
      />
      {setupError && <p className="text-red-400 text-xs mb-2">{setupError}</p>}
      <div className="flex gap-2">
        {showPathChange && (
          <button
            onClick={() => { setShowPathChange(false); setSetupInput(workDir) }}
            className="text-xs text-gray-400 hover:text-white px-3 py-1.5 rounded transition-colors"
          >
            Cancel
          </button>
        )}
        <button
          onClick={handleSetupSave}
          disabled={setupSaving || !setupInput.trim()}
          className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium px-4 py-1.5 rounded-lg transition-colors"
        >
          {setupSaving ? 'Saving…' : showPathChange ? 'Update & Reconnect' : 'Connect'}
        </button>
      </div>
    </div>
  )

  const showSetupForm = pathStatus === 'unconfigured' || showPathChange

  return (
    <>
      <div className={isFullscreen ? 'flex flex-col h-full invisible' : 'flex flex-col h-full'}>
        {!isFullscreen && header}
        <div ref={inlineSlotRef} className="flex-1 overflow-hidden relative" style={{ minHeight: 0 }}>
          {pathStatus === 'resolving' && (
            <div className="flex items-center justify-center h-full">
              <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          {showSetupForm && pathSetupForm}
        </div>
      </div>
      {createPortal(
        <div
          className={isFullscreen ? 'fixed inset-0 z-50 flex flex-col bg-gray-950' : ''}
          style={isFullscreen ? undefined : { position: 'fixed', left: '-9999px', width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}
        >
          {isFullscreen && header}
          <div ref={fullscreenSlotRef} className="flex-1 overflow-hidden" style={{ minHeight: 0 }}>
            {isFullscreen && showSetupForm && pathSetupForm}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
