import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ensureDir } from '../../api/client'
import { notifyServerRestarting } from '../shared/RebuildOverlay'
import '@xterm/xterm/css/xterm.css'

interface TerminalViewProps {
  projectCode: string
  localPath?: string
  prompt?: string
  compact?: boolean
  onStatusChange?: (status: string) => void
  onActivityChange?: (active: boolean) => void
}

interface WSMessage {
  type: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any
}

export default function TerminalView({ projectCode, localPath, prompt, compact, onStatusChange, onActivityChange }: TerminalViewProps) {
  // The terminal DOM node is created imperatively so React never unmounts it
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
  const [contextPercent, setContextPercent] = useState<number | null>(null)
  const [missingDir, setMissingDir] = useState<string | null>(null)
  const [creatingDir, setCreatingDir] = useState(false)
  const activityTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isActiveRef = useRef(false)

  const fontSize = compact && !isFullscreen ? 11 : 14

  const updateStatus = useCallback((s: string) => {
    setStatus(s)
    onStatusChange?.(s)
  }, [onStatusChange])

  const markActive = useCallback(() => {
    if (!isActiveRef.current) {
      isActiveRef.current = true
      onActivityChange?.(true)
    }
    if (activityTimer.current) clearTimeout(activityTimer.current)
    activityTimer.current = setTimeout(() => {
      isActiveRef.current = false
      onActivityChange?.(false)
    }, 2000)
  }, [onActivityChange])

  const connect = useCallback(() => {
    if (!terminalRef.current || !mountedRef.current) return

    const terminal = terminalRef.current

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/terminal`)
    wsRef.current = ws

    ws.onopen = () => {
      updateStatus('connecting')
      ws.send(JSON.stringify({
        type: 'launch',
        data: {
          projectCode,
          localPath: localPath || '',
          prompt: prompt || '',
        },
      }))
    }

    ws.onmessage = (event) => {
      const msg: WSMessage = JSON.parse(event.data)
      switch (msg.type) {
        case 'output':
          if (msg.data?.data) {
            terminal.write(msg.data.data)
            markActive()
            const text = msg.data.data as string
            const ctxMatch = text.match(/(\d+)%\s*(?:context|ctx)/i)
            if (ctxMatch) {
              setContextPercent(parseInt(ctxMatch[1], 10))
            }
          }
          break
        case 'status': {
          const s = msg.data?.status || 'unknown'
          updateStatus(s)
          if (s === 'exited') {
            isActiveRef.current = false
            onActivityChange?.(false)
          }
          break
        }
        case 'error': {
          const errMsg = msg.data?.message || 'unknown error'
          const dirMatch = errMsg.match(/DIR_NOT_FOUND:\s*(.+)/)
          if (dirMatch) {
            setMissingDir(dirMatch[1].trim())
          } else {
            terminal.write(`\r\n\x1b[31mError: ${errMsg}\x1b[0m\r\n`)
          }
          break
        }
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
          connect()
        }
      }, 3000)
    }

    ws.onerror = () => updateStatus('error')

    if (onDataDisposable.current) {
      onDataDisposable.current.dispose()
    }
    onDataDisposable.current = terminal.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data: { data } }))
      }
    })
  }, [projectCode, localPath, prompt, updateStatus, markActive])

  // Create terminal once — imperatively, so React never unmounts it
  useEffect(() => {
    if (!inlineSlotRef.current) return
    mountedRef.current = true

    // Create the terminal DOM node imperatively
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
        ws.send(JSON.stringify({
          type: 'resize',
          data: { cols: terminal.cols, rows: terminal.rows },
        }))
      }
    }

    window.addEventListener('resize', doResize)

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(doResize)
    })
    resizeObserver.observe(termNode)

    connect()

    return () => {
      mountedRef.current = false
      window.removeEventListener('resize', doResize)
      resizeObserver.disconnect()
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      if (wsRef.current) wsRef.current.close()
      terminal.dispose()
      termNode.remove()
      termNodeRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectCode, localPath, prompt])

  // Move terminal node between inline and fullscreen slots
  useEffect(() => {
    const termNode = termNodeRef.current
    if (!termNode) return

    const target = isFullscreen ? fullscreenSlotRef.current : inlineSlotRef.current
    if (target && termNode.parentElement !== target) {
      target.appendChild(termNode)
    }

    // Refit after reparenting
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current
    if (terminal && fitAddon) {
      terminal.options.fontSize = fontSize
      requestAnimationFrame(() => {
        fitAddon.fit()
        const ws = wsRef.current
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'resize',
            data: { cols: terminal.cols, rows: terminal.rows },
          }))
        }
      })
    }
  }, [isFullscreen, fontSize])

  // Escape exits fullscreen
  useEffect(() => {
    if (!isFullscreen) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen(false)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [isFullscreen])

  const handleCreateDir = async () => {
    if (!missingDir) return
    setCreatingDir(true)
    try {
      await ensureDir(missingDir)
      setMissingDir(null)
      // Reconnect now that the directory exists
      if (wsRef.current) wsRef.current.close()
      setTimeout(() => connect(), 500)
    } catch (err) {
      terminalRef.current?.write(`\r\n\x1b[31mFailed to create directory: ${err}\x1b[0m\r\n`)
      setMissingDir(null)
    } finally {
      setCreatingDir(false)
    }
  }

  const toggleFullscreen = () => setIsFullscreen(prev => !prev)

  const statusColor = {
    connecting: 'bg-yellow-500',
    connected: 'bg-green-500',
    started: 'bg-green-500',
    reconnected: 'bg-green-500',
    running: 'bg-green-500',
    idle: 'bg-yellow-500',
    disconnected: 'bg-gray-500',
    error: 'bg-red-500',
    exited: 'bg-gray-500',
  }[status] || 'bg-gray-500'

  const contextColor = contextPercent !== null
    ? contextPercent >= 80 ? 'text-red-400'
    : contextPercent >= 50 ? 'text-yellow-400'
    : 'text-gray-400'
    : 'text-gray-500'

  const header = (
    <div className="flex items-center justify-between px-3 py-1 bg-gray-900 border-b border-gray-700 text-xs shrink-0">
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${statusColor}`} />
        <span className="text-gray-400">{status}</span>
        {isFullscreen && (
          <span className="text-gray-600 ml-1">{projectCode}</span>
        )}
      </div>
      <div className="flex items-center gap-3">
        {contextPercent !== null && (
          <span className={`font-mono ${contextColor}`}>{contextPercent}% ctx</span>
        )}
        <button
          onClick={toggleFullscreen}
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

  return (
    <>
      {/* Inline container — visible when not fullscreen */}
      <div className={isFullscreen ? 'flex flex-col h-full invisible' : 'flex flex-col h-full'}>
        {!isFullscreen && header}
        <div ref={inlineSlotRef} className="flex-1 overflow-hidden" style={{ minHeight: 0 }} />
      </div>

      {/* Fullscreen container — always mounted via portal so termNode is never destroyed */}
      {createPortal(
        <div
          className={isFullscreen ? 'fixed inset-0 z-50 flex flex-col bg-gray-950' : ''}
          style={isFullscreen ? undefined : { position: 'fixed', left: '-9999px', width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}
        >
          {isFullscreen && header}
          <div ref={fullscreenSlotRef} className="flex-1 overflow-hidden" style={{ minHeight: 0 }} />
        </div>,
        document.body
      )}

      {/* Missing directory prompt */}
      {missingDir && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="rounded-lg border border-gray-700 bg-gray-800 p-5 max-w-md text-center space-y-3">
            <p className="text-sm text-gray-300">
              Directory does not exist:
            </p>
            <p className="text-sm font-mono text-yellow-400 break-all">{missingDir}</p>
            <p className="text-sm text-gray-400">Would you like to create it?</p>
            <div className="flex justify-center gap-3 pt-1">
              <button
                onClick={() => setMissingDir(null)}
                className="rounded bg-gray-600 px-4 py-1.5 text-sm text-gray-200 hover:bg-gray-500"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateDir}
                disabled={creatingDir}
                className="rounded bg-indigo-600 px-4 py-1.5 text-sm text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {creatingDir ? 'Creating...' : 'Create Directory'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
