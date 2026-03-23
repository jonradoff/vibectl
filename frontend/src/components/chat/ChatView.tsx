import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listProjectPrompts, ensureDir, getClaudeAuthStatus, getStoredToken, submitClaudeLoginCode, submitClaudeTokenDirect } from '../../api/client'
import { notifyServerRestarting } from '../shared/RebuildOverlay'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
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
import diff from 'highlight.js/lib/languages/diff'
import markdown from 'highlight.js/lib/languages/markdown'

// Register languages
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('tsx', typescript)
hljs.registerLanguage('jsx', javascript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('go', go)
hljs.registerLanguage('golang', go)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('zsh', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('css', css)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)
hljs.registerLanguage('diff', diff)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)

export interface ChatSessionSnapshot {
  messages: ChatMessage[]
  startedAt: string
}

interface ChatViewProps {
  projectId: string
  projectCode: string
  localPath?: string
  compact?: boolean
  onStatusChange?: (status: string) => void
  onActivityChange?: (active: boolean) => void
  onSessionSnapshot?: (snapshot: ChatSessionSnapshot) => void
  onWaitingChange?: (waiting: boolean) => void
}

// Parsed message types for rendering
interface UserMessage {
  role: 'user'
  text: string
}

interface AssistantMessage {
  role: 'assistant'
  content: ContentBlock[]
}

interface ToolResultMessage {
  role: 'tool_result'
  toolUseId: string
  content: string
  isError: boolean
}

type ChatMessage = UserMessage | AssistantMessage | ToolResultMessage

interface TextBlock {
  type: 'text'
  text: string
}

interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

type ContentBlock = TextBlock | ToolUseBlock

export default function ChatView({
  projectId,
  localPath,
  compact,
  onStatusChange,
  onActivityChange,
  onSessionSnapshot,
  onWaitingChange,
}: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [inputText, setInputText] = useState('')
  const [status, setStatusState] = useState<string>('disconnected')
  const statusRef = useRef('disconnected')
  const setStatus = useCallback((s: string) => {
    statusRef.current = s
    setStatusState(s)
  }, [])
  const [contextPct, setContextPct] = useState<number | null>(null)
  const [costUsd, setCostUsd] = useState<number | null>(null)
  const [permissionMode, setPermissionMode] = useState<'accept-all' | 'approve'>('accept-all')
  const [showSlashCommands, setShowSlashCommands] = useState(false)
  const [showPromptPicker, setShowPromptPicker] = useState(false)
  const [isReconnecting, setIsReconnecting] = useState(false)
  const [exitError, setExitError] = useState<{ exitCode: number; stderr: string[] } | null>(null)
  const [showLoginModal, setShowLoginModal] = useState(false)

  // Proactively check Claude Code auth status on mount
  useEffect(() => {
    let cancelled = false
    getClaudeAuthStatus().then((status) => {
      if (cancelled) return
      if (!status.loggedIn) {
        setExitError({ exitCode: 1, stderr: ['Not logged in'] })
        setStatus('claude_error')
        onStatusChange?.('claude_error')
      }
    }).catch(() => {
      // Ignore — will be caught later when session starts
    })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const { data: savedPrompts = [] } = useQuery({
    queryKey: ['prompts', projectId],
    queryFn: () => listProjectPrompts(projectId),
  })
  const [pendingToolUse, setPendingToolUse] = useState(false)
  const [awaitingResult, setAwaitingResult] = useState(false) // true between sending a message and getting a result
  const [missingDir, setMissingDir] = useState<string | null>(null)
  const [creatingDir, setCreatingDir] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const activityTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const isActiveRef = useRef(false)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const isReplayingRef = useRef(false)

  // Input history (shell-style up/down arrow navigation)
  const inputHistoryRef = useRef<string[]>([])
  const historyIndexRef = useRef(-1) // -1 means "not browsing history"
  const savedInputRef = useRef('') // stash current input when entering history
  const sessionStartedAtRef = useRef(new Date().toISOString())

  const markActive = useCallback(() => {
    if (!isActiveRef.current) {
      isActiveRef.current = true
      onActivityChange?.(true)
    }
    // Reset the idle timer — if no events for 30s, check awaitingResult
    if (activityTimer.current) clearTimeout(activityTimer.current)
    activityTimer.current = setTimeout(() => {
      // Don't go idle if we're still awaiting a result
    }, 30000)
  }, [onActivityChange])

  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const userScrolledUpRef = useRef(false)

  const scrollToBottom = useCallback((instant?: boolean) => {
    const el = messagesContainerRef.current
    if (!el) return
    if (instant) {
      el.scrollTop = el.scrollHeight
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    }
  }, [])

  // Track whether the user has scrolled up (away from the bottom)
  const handleScroll = useCallback(() => {
    const el = messagesContainerRef.current
    if (!el) return
    // Consider "at bottom" if within 80px of the bottom edge
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    userScrolledUpRef.current = !atBottom
  }, [])

  useEffect(() => {
    if (!isReplayingRef.current && !userScrolledUpRef.current) {
      scrollToBottom()
    }
  }, [messages, streamingText, scrollToBottom])

  // Report current session snapshot for the History tab
  useEffect(() => {
    onSessionSnapshot?.({ messages, startedAt: sessionStartedAtRef.current })
  }, [messages, onSessionSnapshot])

  // Report waiting state (pending tool use in approve mode)
  useEffect(() => {
    onWaitingChange?.(pendingToolUse && permissionMode === 'approve')
  }, [pendingToolUse, permissionMode, onWaitingChange])

  // Keep activity in sync with awaitingResult
  useEffect(() => {
    if (awaitingResult && !isActiveRef.current) {
      isActiveRef.current = true
      onActivityChange?.(true)
    }
  }, [awaitingResult, onActivityChange])

  // WebSocket connection
  useEffect(() => {
    let aborted = false
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/ws/chat`

    const connect = () => {
      if (aborted) return
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      setStatus('connecting')
      onStatusChange?.('connecting')

      ws.onopen = () => {
        if (aborted) { ws.close(); return }
        // Suppress scroll during replay
        isReplayingRef.current = true
        sessionStartedAtRef.current = new Date().toISOString()
        // Clear stale state before launching
        setMessages([])
        setStreamingText('')
        setIsStreaming(false)
        setCostUsd(null)
        setContextPct(null)
        setExitError(null)

        // Send launch message
        ws.send(JSON.stringify({
          type: 'launch',
          data: { projectId, localPath: localPath || '' },
        }))
      }

      ws.onmessage = (event) => {
        if (aborted) return
        try {
          const data = JSON.parse(event.data)
          handleEvent(data)
        } catch {
          // ignore unparseable
        }
      }

      ws.onclose = () => {
        if (aborted) return
        setStatus('disconnected')
        onStatusChange?.('disconnected')
        onActivityChange?.(false)
        reconnectTimer.current = setTimeout(connect, 3000)
      }

      ws.onerror = () => {
        if (aborted) return
        setStatus('error')
        onStatusChange?.('error')
      }
    }

    connect()

    return () => {
      aborted = true
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, localPath])

  const handleEvent = useCallback((data: Record<string, unknown>) => {
    const type = data.type as string

    switch (type) {
      case 'status': {
        const statusData = data.data as { status: string }
        const s = statusData.status
        setStatus(s)
        onStatusChange?.(s)
        if (s === 'reconnected' || s === 'started' || s === 'restarted') {
          // Replay is done — jump to end instantly
          isReplayingRef.current = false
          setIsReconnecting(false)
          setExitError(null)
          setTimeout(() => scrollToBottom(true), 0)
        }
        if (s === 'exited') {
          onActivityChange?.(false)
          setIsStreaming(false)
          setAwaitingResult(false)
        }
        break
      }

      case 'system': {
        // Init event — session started
        isReplayingRef.current = false
        setTimeout(() => scrollToBottom(true), 0)
        if (data.subtype === 'init') {
          setStatus('connected')
          onStatusChange?.('connected')
        }
        // Check for "not logged in" in system messages (message field or subtype)
        const sysMsg = ((data.message as string) || (data.subtype as string) || '').toLowerCase()
        if (sysMsg.includes('not logged in') || sysMsg.includes('please run /login')) {
          setExitError({ exitCode: 1, stderr: [(data.message as string) || 'Not logged in'] })
          setIsStreaming(false)
          setAwaitingResult(false)
          setStatus('claude_error')
          onStatusChange?.('claude_error')
          onActivityChange?.(false)
        }
        break
      }

      case 'stream_event': {
        markActive()
        // If receiving stream events while showing disconnected/connecting, fix it
        if (['disconnected', 'connecting', 'error'].includes(statusRef.current)) {
          setStatus('connected')
          onStatusChange?.('connected')
        }
        const event = data.event as Record<string, unknown>
        const eventType = event.type as string

        if (eventType === 'content_block_start') {
          const block = event.content_block as { type: string }
          if (block.type === 'text') {
            setIsStreaming(true)
            setStreamingText('')
          } else if (block.type === 'tool_use') {
            // Tool use means Claude is still working
            setIsStreaming(true)
          }
        } else if (eventType === 'content_block_delta') {
          const delta = event.delta as { type: string; text?: string }
          if (delta.type === 'text_delta' && delta.text) {
            setStreamingText((prev) => prev + delta.text)
          }
        } else if (eventType === 'content_block_stop' || eventType === 'message_stop') {
          setIsStreaming(false)
          setStreamingText('')
        }
        break
      }

      case 'assistant': {
        markActive()
        if (['disconnected', 'connecting', 'error'].includes(statusRef.current)) {
          setStatus('connected')
          onStatusChange?.('connected')
        }
        setIsStreaming(false)
        setStreamingText('')

        const msg = data.message as {
          content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>
        }

        if (msg?.content) {
          const content: ContentBlock[] = msg.content
            .map((block) => {
              if (block.type === 'text') {
                return { type: 'text' as const, text: block.text || '' }
              } else if (block.type === 'tool_use') {
                return {
                  type: 'tool_use' as const,
                  id: block.id || '',
                  name: block.name || '',
                  input: block.input || {},
                }
              }
              return { type: 'text' as const, text: '' }
            })
            .filter((b) => b.type === 'text' ? b.text !== '' : true)

          if (content.length > 0) {
            setMessages((prev) => [...prev, { role: 'assistant', content }])
            // Track if assistant ended with a tool_use (may be waiting for approval)
            const hasToolUse = content.some((b) => b.type === 'tool_use')
            if (hasToolUse) setPendingToolUse(true)
          }
        }
        break
      }

      case 'user': {
        // Tool result from claude's internal tool execution
        markActive()
        const msg = data.message as {
          content?: Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>
        }
        const toolResult = data.tool_use_result

        if (msg?.content) {
          for (const block of msg.content) {
            if (block.type === 'tool_result') {
              // content can be string, array, or object — normalize to string
              let contentStr = ''
              if (typeof block.content === 'string') {
                contentStr = block.content
              } else if (block.content) {
                contentStr = JSON.stringify(block.content, null, 2)
              } else if (typeof toolResult === 'string') {
                contentStr = toolResult
              } else if (toolResult) {
                contentStr = JSON.stringify(toolResult, null, 2)
              }

              setPendingToolUse(false)
              setMessages((prev) => [...prev, {
                role: 'tool_result',
                toolUseId: block.tool_use_id || '',
                content: contentStr,
                isError: block.is_error || false,
              }])
            }
          }
        }
        break
      }

      case 'result': {
        setIsStreaming(false)
        setStreamingText('')
        setAwaitingResult(false)
        isActiveRef.current = false
        if (activityTimer.current) clearTimeout(activityTimer.current)
        onActivityChange?.(false)

        // Handle error results from Claude Code (e.g. auth failures)
        if (data.is_error) {
          const resultMsg = data.result as string | undefined
          const lowerResult = (resultMsg || '').toLowerCase()
          const isNotLoggedInResult = lowerResult.includes('not logged in') || lowerResult.includes('please run /login') || lowerResult.includes('run claude login')
          const isAuthError = typeof resultMsg === 'string' && (
            resultMsg.includes('OAuth token') ||
            resultMsg.includes('authentication_error') ||
            resultMsg.includes('401')
          )
          if (isNotLoggedInResult) {
            setExitError({ exitCode: 1, stderr: [resultMsg || 'Not logged in'] })
            setIsStreaming(false)
            setAwaitingResult(false)
            setStatus('claude_error')
            onStatusChange?.('claude_error')
            onActivityChange?.(false)
          } else if (isAuthError) {
            setIsReconnecting(true)
            setMessages((prev) => [...prev, {
              role: 'assistant',
              content: [{ type: 'text', text: `**Authentication expired.** Reconnecting and resuming session...` }],
            }])
            setTimeout(() => {
              sendWsMessage('restart', { skipPermissions: permissionMode === 'accept-all' })
            }, 1500)
          } else if (resultMsg) {
            setMessages((prev) => [...prev, {
              role: 'assistant',
              content: [{ type: 'text', text: `**Error:** ${resultMsg}` }],
            }])
          }
          break
        }

        // Extract cost and context info
        const totalCost = data.total_cost_usd as number | undefined
        if (totalCost) setCostUsd(totalCost)

        // Context % based on input_tokens from the result event.
        // input_tokens is the total prompt size (already includes cached tokens).
        // cache_read/cache_creation are subsets, NOT additive.
        const usage = data.usage as { input_tokens?: number } | undefined
        if (usage && usage.input_tokens && usage.input_tokens > 0) {
          const pct = parseFloat(((usage.input_tokens / 200000) * 100).toFixed(1))
          setContextPct(pct)
        }
        break
      }

      case 'error': {
        // Two possible error formats:
        // 1. Backend-generated: { type: "error", data: { message: "..." } }
        // 2. Claude Code native: { type: "error", error: { type: "authentication_error", message: "..." } }
        const errData = data.data as { message: string } | undefined
        const claudeErr = data.error as { type?: string; message?: string } | undefined
        const errorMessage = errData?.message || claudeErr?.message || ''

        if (!errorMessage) break

        const isAuthError = claudeErr?.type === 'authentication_error' ||
          errorMessage.includes('OAuth token') ||
          errorMessage.includes('authentication_error') ||
          (errorMessage.includes('401') && errorMessage.includes('auth'))

        const lowerMsg = errorMessage.toLowerCase()
        const isNotLoggedInError = lowerMsg.includes('not logged in') || lowerMsg.includes('please run /login') || lowerMsg.includes('run claude login')

        if (isNotLoggedInError) {
          // Show the login button UI
          setExitError({ exitCode: 1, stderr: [errorMessage] })
          setIsStreaming(false)
          setAwaitingResult(false)
          setStatus('claude_error')
          onStatusChange?.('claude_error')
          onActivityChange?.(false)
        } else if (isAuthError) {
          setIsReconnecting(true)
          setIsStreaming(false)
          setAwaitingResult(false)
          setMessages((prev) => [...prev, {
            role: 'assistant',
            content: [{ type: 'text', text: `**Authentication expired.** Reconnecting and resuming session...` }],
          }])
          // Auto-restart — claude will refresh token on next launch
          setTimeout(() => {
            sendWsMessage('restart', { skipPermissions: permissionMode === 'accept-all' })
          }, 1500)
        } else {
          const dirMatch = errorMessage.match(/DIR_NOT_FOUND:\s*(.+)/)
          if (dirMatch) {
            setMissingDir(dirMatch[1].trim())
          } else {
            setMessages((prev) => [...prev, {
              role: 'assistant',
              content: [{ type: 'text', text: `**Error:** ${errorMessage}` }],
            }])
          }
        }
        break
      }

      case 'system_error': {
        // Process exited with non-zero code or stderr output — show diagnostic info.
        const d = data.data as { exitCode?: number; stderr?: string[] }
        setExitError({ exitCode: d.exitCode ?? -1, stderr: d.stderr ?? [] })
        setIsStreaming(false)
        setAwaitingResult(false)
        setStatus('claude_error')
        onStatusChange?.('claude_error')
        onActivityChange?.(false)
        break
      }

      case 'server_restarting':
        notifyServerRestarting()
        break
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markActive, onStatusChange, onActivityChange])

  const pendingMessagesRef = useRef<string[]>([])

  // Flush any queued messages when we reconnect
  useEffect(() => {
    const connected = ['connecting', 'started', 'connected', 'reconnected', 'restarted'].includes(status)
    if (connected && pendingMessagesRef.current.length > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
      for (const text of pendingMessagesRef.current) {
        wsRef.current.send(JSON.stringify({
          type: 'user_message',
          data: { text },
        }))
      }
      pendingMessagesRef.current = []
    }
  }, [status])

  const sendMessage = useCallback(() => {
    const text = inputText.trim()
    if (!text) return

    // Push to history
    inputHistoryRef.current.push(text)
    historyIndexRef.current = -1
    savedInputRef.current = ''

    // Add user message to UI
    setMessages((prev) => [...prev, { role: 'user', text }])
    setInputText('')

    // Mark as working until result arrives
    setAwaitingResult(true)
    markActive()

    // Send or queue
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'user_message',
        data: { text },
      }))
    } else {
      pendingMessagesRef.current.push(text)
    }

    // Focus input
    inputRef.current?.focus()
  }, [inputText])

  const sendWsMessage = useCallback((type: string, data?: Record<string, unknown>) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    wsRef.current.send(JSON.stringify({ type, data }))
  }, [])

  const handleSetPermissionMode = useCallback((mode: 'accept-all' | 'approve') => {
    setPermissionMode(mode)
    // Restart the session with the new permission mode
    sendWsMessage('restart', { skipPermissions: mode === 'accept-all' })
  }, [sendWsMessage])

  const handleCompact = useCallback(() => {
    // Restart by resuming the same session — this compacts the context
    sendWsMessage('restart', { skipPermissions: permissionMode === 'accept-all' })
  }, [sendWsMessage, permissionMode])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
      return
    }

    const history = inputHistoryRef.current
    if (history.length === 0) return

    if (e.key === 'ArrowUp') {
      // Only navigate history when cursor is at the start of the input
      const el = inputRef.current
      if (el && el.selectionStart !== 0) return

      e.preventDefault()
      if (historyIndexRef.current === -1) {
        // Entering history — stash current input
        savedInputRef.current = inputText
        historyIndexRef.current = history.length - 1
      } else if (historyIndexRef.current > 0) {
        historyIndexRef.current--
      }
      setInputText(history[historyIndexRef.current])
    } else if (e.key === 'ArrowDown') {
      if (historyIndexRef.current === -1) return

      const el = inputRef.current
      if (el && el.selectionStart !== el.value.length) return

      e.preventDefault()
      if (historyIndexRef.current < history.length - 1) {
        historyIndexRef.current++
        setInputText(history[historyIndexRef.current])
      } else {
        // Past the end of history — restore stashed input
        historyIndexRef.current = -1
        setInputText(savedInputRef.current)
      }
    }
  }, [sendMessage, inputText])

  const handleCreateDir = async () => {
    if (!missingDir) return
    setCreatingDir(true)
    try {
      await ensureDir(missingDir)
      setMissingDir(null)
      // Close websocket to trigger auto-reconnect
      wsRef.current?.close()
    } catch (err) {
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: [{ type: 'text', text: `Failed to create directory: ${err}` }],
      }])
      setMissingDir(null)
    } finally {
      setCreatingDir(false)
    }
  }

  const isConnected = ['connecting', 'started', 'connected', 'reconnected', 'restarted'].includes(status)

  const statusColor = useMemo(() => {
    if (['started', 'connected', 'reconnected', 'restarted'].includes(status)) return 'text-green-400'
    if (['connecting'].includes(status)) return 'text-yellow-400'
    if (['error'].includes(status)) return 'text-red-400'
    return 'text-gray-500'
  }, [status])

  return (
    <div className="flex flex-col h-full bg-gray-900">
      {/* Status bar */}
      <div className="flex items-center justify-between px-3 py-1 border-b border-gray-700/50 shrink-0 bg-gray-900/80">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${statusColor.replace('text-', 'bg-')}`} />
          <span className="text-[10px] text-gray-500 font-mono">{status}</span>
          {costUsd !== null && (
            <span className="text-[10px] font-mono text-gray-600">
              ${costUsd.toFixed(2)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Context usage */}
          {contextPct !== null && (
            <div className="flex items-center gap-1.5" title={`${contextPct}% context used`}>
              <div className="w-16 h-1.5 rounded-full bg-gray-700 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    contextPct >= 80 ? 'bg-red-400' : contextPct >= 50 ? 'bg-yellow-400' : 'bg-indigo-400'
                  }`}
                  style={{ width: `${Math.min(contextPct, 100)}%` }}
                />
              </div>
              <span className={`text-[10px] font-mono ${
                contextPct >= 80 ? 'text-red-400' : contextPct >= 50 ? 'text-yellow-400' : 'text-gray-500'
              }`}>
                {contextPct}%
              </span>
            </div>
          )}
          {/* Permission mode toggle */}
          <div className="flex items-center rounded bg-gray-800 border border-gray-700/50">
            <button
              onClick={() => handleSetPermissionMode('accept-all')}
              className={`px-1.5 py-0.5 text-[10px] font-medium rounded-l transition-colors ${
                permissionMode === 'accept-all'
                  ? 'bg-green-600/30 text-green-400'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
              title="Accept all tool calls automatically"
            >
              Auto
            </button>
            <button
              onClick={() => handleSetPermissionMode('approve')}
              className={`px-1.5 py-0.5 text-[10px] font-medium rounded-r transition-colors ${
                permissionMode === 'approve'
                  ? 'bg-amber-600/30 text-amber-400'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
              title="Ask for approval before tool calls"
            >
              Approve
            </button>
          </div>
          {/* Compact button */}
          <button
            onClick={handleCompact}
            disabled={!isConnected}
            className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-gray-800 border border-gray-700/50 text-gray-500 hover:text-gray-300 disabled:opacity-30 transition-colors"
            title="Compact conversation to free context"
          >
            Compact
          </button>
          {/* Slash command helper */}
          <button
            onClick={() => setShowSlashCommands(true)}
            className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-gray-800 border border-gray-700/50 text-gray-500 hover:text-gray-300 transition-colors font-mono"
            title="Slash commands"
          >
            /cmd
          </button>
        </div>
      </div>

      {/* Messages area */}
      <div ref={messagesContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-3 py-2 space-y-3 min-h-0">
        {messages.length === 0 && !isStreaming && !exitError && (
          <div className="flex items-center justify-center h-full text-gray-600 text-sm">
            {isConnected ? 'Send a message to start' : status === 'exited' ? 'Session ended' : 'Connecting...'}
          </div>
        )}

        {messages.map((msg, i) => (
          <MessageRenderer key={i} message={msg} compact={compact} />
        ))}

        {isStreaming && streamingText && (
          <div className="chat-assistant">
            <div className={`prose prose-invert max-w-none ${compact ? 'prose-sm' : ''}`}>
              <MarkdownContent text={streamingText} />
              <span className="inline-block w-2 h-4 bg-indigo-400 animate-pulse ml-0.5" />
            </div>
          </div>
        )}

        {isStreaming && !streamingText && (
          <div className="flex items-center gap-2 text-gray-500 text-xs">
            <span className="flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '300ms' }} />
            </span>
            Thinking...
          </div>
        )}

        {/* Exit error panel — shown when claude process exited with error */}
        {exitError && (() => {
          const allText = exitError.stderr.join(' ').toLowerCase()
          const isNotLoggedIn = allText.includes('not logged in') || allText.includes('please run /login') || allText.includes('run claude login')
          return (
            <div className="rounded-lg bg-red-950/60 border border-red-800/60 p-3 space-y-2 shrink-0">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <svg className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                  </svg>
                  <span className="text-xs font-medium text-red-400">
                    {isNotLoggedIn ? 'Claude Code is not logged in' : `Claude exited${exitError.exitCode !== 0 ? ` (code ${exitError.exitCode})` : ''}`}
                  </span>
                </div>
                <button onClick={() => setExitError(null)} className="text-gray-600 hover:text-gray-400 text-[10px] shrink-0">dismiss</button>
              </div>
              {!isNotLoggedIn && exitError.stderr.length > 0 && (
                <div className="rounded bg-black/50 px-2.5 py-2 max-h-36 overflow-y-auto">
                  {exitError.stderr.map((line, i) => (
                    <div key={i} className="font-mono text-[11px] text-red-300 leading-relaxed whitespace-pre-wrap">{line}</div>
                  ))}
                </div>
              )}
              {isNotLoggedIn ? (
                <div className="flex items-center gap-2">
                  <p className="text-[10px] text-gray-400 flex-1">Authenticate Claude Code on the server to enable chat sessions.</p>
                  <button
                    onClick={() => setShowLoginModal(true)}
                    className="shrink-0 rounded bg-indigo-600 hover:bg-indigo-500 px-2.5 py-1 text-xs font-medium text-white transition-colors"
                  >
                    Login to Claude
                  </button>
                </div>
              ) : (
                <p className="text-[10px] text-gray-500">
                  Common causes: missing <span className="font-mono text-gray-400">ANTHROPIC_API_KEY</span>, stale OAuth token, or Claude Code not installed. Check server logs for details.
                </p>
              )}
            </div>
          )
        })()}
        {showLoginModal && <ClaudeLoginModal onClose={() => setShowLoginModal(false)} />}

        {isReconnecting && (
          <div className="flex items-center gap-2 text-amber-400 text-xs px-2 py-1.5 rounded bg-amber-900/20 border border-amber-700/30">
            <span className="flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-bounce" style={{ animationDelay: '300ms' }} />
            </span>
            Reconnecting — resuming from where we left off...
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area — never disabled so messages can be queued */}
      <div className="shrink-0 border-t border-gray-700/50 p-2 bg-gray-900/80">
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            value={inputText}
            onChange={(e) => { setInputText(e.target.value); if (showPromptPicker) setShowPromptPicker(false) }}
            onKeyDown={handleKeyDown}
            placeholder={isConnected ? 'Message Claude...' : 'Connecting... (messages will be queued)'}
            rows={compact ? 1 : 2}
            className="flex-1 resize-none rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:border-indigo-500 focus:outline-none"
          />
          {/* Prompt picker */}
          <div className="relative shrink-0">
            <button
              onClick={() => setShowPromptPicker(!showPromptPicker)}
              className={`rounded-lg px-2 py-2 text-sm transition-colors shrink-0 ${
                savedPrompts.length > 0
                  ? 'text-gray-400 hover:text-white hover:bg-gray-700'
                  : 'text-gray-700 cursor-default'
              }`}
              title={savedPrompts.length > 0 ? 'Insert saved prompt' : 'No saved prompts'}
              disabled={savedPrompts.length === 0}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
              </svg>
            </button>
            {showPromptPicker && savedPrompts.length > 0 && (
              <div className="absolute bottom-full right-0 mb-1 w-64 max-h-60 overflow-y-auto bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50">
                <div className="px-3 py-1.5 border-b border-gray-700 text-[10px] text-gray-500 font-medium uppercase">
                  Saved Prompts
                </div>
                {savedPrompts.map(p => (
                  <button
                    key={p.id}
                    onClick={() => {
                      setInputText(prev => prev ? prev + '\n' + p.body : p.body)
                      setShowPromptPicker(false)
                      inputRef.current?.focus()
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-gray-700/50 transition-colors border-b border-gray-800/50 last:border-0"
                  >
                    <div className="text-xs text-white font-medium truncate flex items-center gap-1.5">
                      {p.name}
                      {p.global && <span className="text-[9px] text-indigo-300 bg-indigo-600/20 px-1 rounded">*</span>}
                      {p.creatorName && <span className="text-[9px] text-gray-500">by {p.creatorName}</span>}
                    </div>
                    <div className="text-[10px] text-gray-500 truncate mt-0.5">{p.body}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
          {(isStreaming || awaitingResult) && !isReconnecting && (
            <button
              onClick={() => sendWsMessage('interrupt')}
              className="rounded-lg bg-red-600/20 border border-red-500/40 px-3 py-2 text-sm font-medium text-red-400 hover:bg-red-600/30 transition-colors shrink-0"
              title="Stop current execution (Ctrl+C)"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <rect x="5" y="5" width="14" height="14" rx="2" />
              </svg>
            </button>
          )}
          <button
            onClick={sendMessage}
            disabled={!inputText.trim()}
            className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" />
            </svg>
          </button>
        </div>
      </div>

      {/* Slash command modal */}
      {showSlashCommands && (
        <SlashCommandModal
          onExecute={(cmd) => {
            // Handle special commands via WS actions; others as user messages
            if (cmd === '/compact') {
              handleCompact()
            } else if (cmd === '/permissions auto') {
              handleSetPermissionMode('accept-all')
            } else if (cmd === '/permissions approve') {
              handleSetPermissionMode('approve')
            } else {
              // Send as a user message — Claude will interpret it as a natural language request
              setInputText(cmd.replace(/^\//, ''))
            }
            setShowSlashCommands(false)
          }}
          onClose={() => setShowSlashCommands(false)}
        />
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
    </div>
  )
}

// --- Slash Command Modal ---

interface SlashCommand {
  name: string
  description: string
  params: { name: string; placeholder: string; required?: boolean }[]
}

const SLASH_COMMANDS: SlashCommand[] = [
  // Commands that work via WebSocket actions (native support)
  { name: '/compact', description: 'Resume session to free context window (restarts Claude)', params: [] },
  { name: '/permissions auto', description: 'Accept all tool calls automatically (restarts Claude)', params: [] },
  { name: '/permissions approve', description: 'Require approval for tool calls (restarts Claude)', params: [] },
  // Commands sent as natural language requests to Claude
  { name: '/review', description: 'Ask Claude to review a pull request', params: [
    { name: 'pr', placeholder: 'PR number or URL', required: false },
  ]},
  { name: '/init', description: 'Ask Claude to create a CLAUDE.md for this project', params: [] },
  { name: '/memory', description: 'Ask Claude to review and edit project memory', params: [] },
  { name: '/status', description: 'Ask Claude to report current session and project status', params: [] },
  { name: '/pr-comments', description: 'Ask Claude to view and address PR review comments', params: [] },
  { name: '/model', description: 'Ask Claude about available models', params: [
    { name: 'model', placeholder: 'e.g. sonnet, opus, haiku', required: false },
  ]},
]

function SlashCommandModal({ onExecute, onClose }: { onExecute: (cmd: string) => void; onClose: () => void }) {
  const [selected, setSelected] = useState<SlashCommand | null>(null)
  const [paramValues, setParamValues] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState('')

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selected) {
          setSelected(null)
          setParamValues({})
        } else {
          onClose()
        }
      }
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onClose, selected])

  const filteredCommands = filter
    ? SLASH_COMMANDS.filter((c) =>
        c.name.toLowerCase().includes(filter.toLowerCase()) ||
        c.description.toLowerCase().includes(filter.toLowerCase())
      )
    : SLASH_COMMANDS

  const handleSelect = (cmd: SlashCommand) => {
    if (cmd.params.length === 0) {
      // No params — show confirm
      setSelected(cmd)
      setParamValues({})
    } else {
      setSelected(cmd)
      setParamValues({})
    }
  }

  const handleExecute = () => {
    if (!selected) return
    let cmd = selected.name
    for (const param of selected.params) {
      const val = paramValues[param.name]?.trim()
      if (val) cmd += ` ${val}`
    }
    onExecute(cmd)
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70" onClick={onClose}>
      <div
        className="bg-gray-900 rounded-lg border border-gray-700 w-full max-w-lg mx-4 flex flex-col max-h-[70vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-white font-mono">/</span>
            <span className="text-sm font-medium text-white">
              {selected ? selected.name : 'Slash Commands'}
            </span>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {selected ? (
          /* Parameter form */
          <div className="p-4 space-y-4">
            <p className="text-sm text-gray-400">{selected.description}</p>

            {selected.params.length > 0 && (
              <div className="space-y-3">
                {selected.params.map((param) => (
                  <div key={param.name}>
                    <label className="block text-xs font-medium text-gray-400 mb-1">
                      {param.name}
                      {param.required && <span className="text-red-400 ml-0.5">*</span>}
                    </label>
                    <input
                      value={paramValues[param.name] || ''}
                      onChange={(e) => setParamValues({ ...paramValues, [param.name]: e.target.value })}
                      placeholder={param.placeholder}
                      className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-gray-200 focus:border-indigo-500 focus:outline-none font-mono"
                      autoFocus
                    />
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-2 border border-gray-700/50">
              <span className="text-[10px] text-gray-500 font-medium">Preview:</span>
              <code className="text-xs text-indigo-400 font-mono">
                {selected.name}
                {selected.params.map((p) => paramValues[p.name]?.trim() ? ` ${paramValues[p.name].trim()}` : '').join('')}
              </code>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={handleExecute}
                disabled={selected.params.some((p) => p.required && !paramValues[p.name]?.trim())}
                className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
              >
                Execute
              </button>
              <button
                onClick={() => { setSelected(null); setParamValues({}) }}
                className="rounded bg-gray-700 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-gray-600 transition-colors"
              >
                Back
              </button>
            </div>
          </div>
        ) : (
          /* Command list */
          <>
            <div className="px-4 pt-3 pb-2 shrink-0">
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter commands..."
                className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
                autoFocus
              />
            </div>
            <div className="flex-1 overflow-y-auto">
              {filteredCommands.map((cmd) => (
                <button
                  key={cmd.name}
                  onClick={() => handleSelect(cmd)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-800/80 transition-colors border-b border-gray-800/50"
                >
                  <code className="text-sm font-mono text-indigo-400 shrink-0 w-28">{cmd.name}</code>
                  <span className="text-xs text-gray-500 truncate">{cmd.description}</span>
                  {cmd.params.length > 0 && (
                    <span className="text-[10px] text-gray-600 ml-auto shrink-0">{cmd.params.length} param{cmd.params.length > 1 ? 's' : ''}</span>
                  )}
                </button>
              ))}
              {filteredCommands.length === 0 && (
                <div className="px-4 py-6 text-center text-sm text-gray-500">No matching commands</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// --- Sub-components ---

const MessageRenderer = memo(function MessageRenderer({ message, compact }: { message: ChatMessage; compact?: boolean }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-indigo-600/30 border border-indigo-500/30 px-3 py-2">
          <p className={`text-gray-200 whitespace-pre-wrap ${compact ? 'text-xs' : 'text-sm'}`}>
            {message.text}
          </p>
        </div>
      </div>
    )
  }

  if (message.role === 'tool_result') {
    return <ToolResultCard message={message} compact={compact} />
  }

  // Assistant message
  return (
    <div className="space-y-2">
      {message.content.map((block, i) => {
        if (block.type === 'text') {
          return (
            <div key={i} className={`prose prose-invert max-w-none ${compact ? 'prose-sm' : ''}`}>
              <MarkdownContent text={block.text} />
            </div>
          )
        }
        if (block.type === 'tool_use') {
          return <ToolCallCard key={i} block={block} compact={compact} />
        }
        return null
      })}
    </div>
  )
})

const ToolCallCard = memo(function ToolCallCard({ block, compact }: { block: ToolUseBlock; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const [showDiff, setShowDiff] = useState(false)

  const toolIcon = getToolIcon(block.name)
  const summary = getToolSummary(block.name, block.input)
  const isEdit = block.name === 'Edit'

  return (
    <>
      <div className={`rounded-lg border border-gray-700/60 bg-gray-800/50 overflow-hidden ${compact ? 'text-xs' : 'text-sm'}`}>
        <div className="flex items-center">
          <button
            onClick={() => isEdit ? setShowDiff(true) : setOpen(!open)}
            className={`flex-1 flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${
              isEdit ? 'hover:bg-indigo-900/20 cursor-pointer' : 'hover:bg-gray-700/30'
            }`}
          >
            <span className="text-gray-500 shrink-0">{toolIcon}</span>
            <span className="text-amber-400/80 font-mono font-medium shrink-0">{block.name}</span>
            <span className="text-gray-500 truncate">{summary}</span>
            {isEdit && (
              <span className="text-[10px] text-indigo-400/70 ml-auto shrink-0">view diff</span>
            )}
            {!isEdit && (
              <svg
                className={`w-3 h-3 text-gray-600 ml-auto shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              </svg>
            )}
          </button>
        </div>
        {open && !isEdit && (
          <div className="px-3 py-2 border-t border-gray-700/40 bg-gray-850">
            <pre className="text-[11px] text-gray-400 overflow-x-auto whitespace-pre-wrap font-mono">
              {JSON.stringify(block.input, null, 2)}
            </pre>
          </div>
        )}
      </div>
      {showDiff && (
        <EditDiffModal
          filePath={String(block.input.file_path || '')}
          oldString={String(block.input.old_string || '')}
          newString={String(block.input.new_string || '')}
          onClose={() => setShowDiff(false)}
        />
      )}
    </>
  )
})

function EditDiffModal({
  filePath,
  oldString,
  newString,
  onClose,
}: {
  filePath: string
  oldString: string
  newString: string
  onClose: () => void
}) {
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onClose])

  const diffLines = computeDiffLines(oldString, newString)
  const fileName = filePath.split('/').slice(-2).join('/')

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70" onClick={onClose}>
      <div
        className="bg-gray-900 rounded-lg border border-gray-700 w-full max-w-4xl mx-4 flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-white">Edit</span>
            <span className="text-xs font-mono text-gray-400 truncate">{filePath}</span>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 transition-colors shrink-0"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Diff content */}
        <div className="overflow-auto flex-1 p-0">
          <div className="font-mono text-[13px] leading-relaxed">
            {/* File name bar */}
            <div className="sticky top-0 bg-gray-800 px-4 py-1.5 border-b border-gray-700 text-xs text-gray-400">
              {fileName}
            </div>
            <table className="w-full border-collapse">
              <tbody>
                {diffLines.map((line, i) => (
                  <tr
                    key={i}
                    className={
                      line.type === 'remove'
                        ? 'bg-red-950/40'
                        : line.type === 'add'
                          ? 'bg-green-950/40'
                          : ''
                    }
                  >
                    <td className="w-[1px] whitespace-nowrap px-3 py-0 text-right text-[11px] text-gray-600 select-none border-r border-gray-800 align-top">
                      {line.type !== 'add' ? line.oldNum ?? '' : ''}
                    </td>
                    <td className="w-[1px] whitespace-nowrap px-3 py-0 text-right text-[11px] text-gray-600 select-none border-r border-gray-800 align-top">
                      {line.type !== 'remove' ? line.newNum ?? '' : ''}
                    </td>
                    <td className="w-[1px] whitespace-nowrap px-1 py-0 select-none align-top">
                      <span className={`text-[13px] ${
                        line.type === 'remove'
                          ? 'text-red-400'
                          : line.type === 'add'
                            ? 'text-green-400'
                            : 'text-gray-600'
                      }`}>
                        {line.type === 'remove' ? '-' : line.type === 'add' ? '+' : ' '}
                      </span>
                    </td>
                    <td className="py-0 pr-4 whitespace-pre overflow-x-auto">
                      <span className={
                        line.type === 'remove'
                          ? 'text-red-300/80'
                          : line.type === 'add'
                            ? 'text-green-300/80'
                            : 'text-gray-400'
                      }>
                        {line.text}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

interface DiffLine {
  type: 'context' | 'remove' | 'add'
  text: string
  oldNum?: number
  newNum?: number
}

function computeDiffLines(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split('\n')
  const newLines = newStr.split('\n')
  // Simple LCS-based diff
  const m = oldLines.length
  const n = newLines.length

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  // Backtrack to produce diff
  const result: DiffLine[] = []
  let i = m, j = n
  const stack: DiffLine[] = []

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      stack.push({ type: 'context', text: oldLines[i - 1], oldNum: i, newNum: j })
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({ type: 'add', text: newLines[j - 1], newNum: j })
      j--
    } else {
      stack.push({ type: 'remove', text: oldLines[i - 1], oldNum: i })
      i--
    }
  }

  // Reverse since we built it backwards
  for (let k = stack.length - 1; k >= 0; k--) {
    result.push(stack[k])
  }

  return result
}

const ToolResultCard = memo(function ToolResultCard({ message, compact }: { message: ToolResultMessage; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const isLong = message.content.length > 200

  return (
    <div className={`rounded-lg border ${message.isError ? 'border-red-700/40 bg-red-900/10' : 'border-gray-700/40 bg-gray-800/30'} overflow-hidden ${compact ? 'text-xs' : 'text-sm'}`}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-1 text-left hover:bg-gray-700/20 transition-colors"
      >
        <span className={`text-[10px] font-mono ${message.isError ? 'text-red-400' : 'text-green-400/60'}`}>
          {message.isError ? 'ERROR' : 'RESULT'}
        </span>
        {!open && (
          <span className="text-gray-600 truncate text-[11px] font-mono">
            {message.content.slice(0, 80)}{isLong ? '...' : ''}
          </span>
        )}
        <svg
          className={`w-3 h-3 text-gray-600 ml-auto shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m19.5 8.25-7.5 7.5-7.5-7.5" />
        </svg>
      </button>
      {open && (
        <div className="px-3 py-2 border-t border-gray-700/30 max-h-60 overflow-y-auto">
          <pre className="text-[11px] text-gray-400 whitespace-pre-wrap font-mono">
            {message.content}
          </pre>
        </div>
      )}
    </div>
  )
})

const MarkdownContent = memo(function MarkdownContent({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || '')
          const lang = match?.[1]
          const codeStr = String(children).replace(/\n$/, '')

          // Inline code
          if (!className && !codeStr.includes('\n')) {
            return (
              <code className="rounded bg-gray-800 px-1.5 py-0.5 text-[13px] font-mono text-indigo-300" {...props}>
                {children}
              </code>
            )
          }

          // Block code with syntax highlighting.
          // Default to HTML-escaped plain text to prevent XSS when hljs falls through.
          const escapeHtml = (s: string) =>
            s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
          let highlighted = escapeHtml(codeStr)
          if (lang && hljs.getLanguage(lang)) {
            try {
              highlighted = hljs.highlight(codeStr, { language: lang }).value
            } catch { /* fallback to escaped plain text */ }
          }

          return (
            <div className="relative group">
              {lang && (
                <span className="absolute top-1.5 right-2 text-[10px] text-gray-600 font-mono">{lang}</span>
              )}
              <pre className="rounded-lg bg-[#0d1117] border border-gray-800 p-3 overflow-x-auto">
                <code
                  className="text-[13px] font-mono leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: highlighted }}
                />
              </pre>
            </div>
          )
        },
        a({ href, children }) {
          return (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">
              {children}
            </a>
          )
        },
        table({ children }) {
          return (
            <div className="overflow-x-auto">
              <table className="border-collapse border border-gray-700 text-sm">{children}</table>
            </div>
          )
        },
        th({ children }) {
          return <th className="border border-gray-700 bg-gray-800 px-3 py-1.5 text-left font-medium">{children}</th>
        },
        td({ children }) {
          return <td className="border border-gray-700 px-3 py-1.5">{children}</td>
        },
      }}
    >
      {text}
    </ReactMarkdown>
  )
})

// --- Helpers ---

function getToolIcon(name: string): string {
  if (name === 'Read') return '📄'
  if (name === 'Edit') return '✏️'
  if (name === 'Write') return '📝'
  if (name === 'Bash') return '⚡'
  if (name === 'Glob') return '🔍'
  if (name === 'Grep') return '🔎'
  if (name === 'Agent' || name === 'Task') return '🤖'
  if (name === 'WebSearch') return '🌐'
  if (name === 'WebFetch') return '📡'
  if (name.startsWith('mcp__')) return '🔌'
  return '🔧'
}

function getToolSummary(name: string, input: Record<string, unknown>): string {
  if (name === 'Read' && input.file_path) return String(input.file_path).split('/').slice(-2).join('/')
  if (name === 'Edit' && input.file_path) return String(input.file_path).split('/').slice(-2).join('/')
  if (name === 'Write' && input.file_path) return String(input.file_path).split('/').slice(-2).join('/')
  if (name === 'Bash' && input.command) return String(input.command).slice(0, 60)
  if (name === 'Glob' && input.pattern) return String(input.pattern)
  if (name === 'Grep' && input.pattern) return String(input.pattern)
  if (name === 'Agent' && input.description) return String(input.description)
  return ''
}

const CODE_TTL_SECONDS = 55

function ClaudeLoginModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'oauth' | 'direct'>('oauth')
  const [loading, setLoading] = useState(true)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [pkceParams, setPkceParams] = useState<{ codeVerifier: string; clientId: string; redirectUri: string; state: string } | null>(null)
  const [codeInput, setCodeInput] = useState('')
  const [directToken, setDirectToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [countdown, setCountdown] = useState(CODE_TTL_SECONDS)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const startSession = (token: string | null) => {
    setLoading(true)
    setError('')
    fetch('/api/v1/admin/claude-login', { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => r.json())
      .then((data: { authUrl: string; codeVerifier: string; clientId: string; redirectUri: string; state: string }) => {
        setAuthUrl(data.authUrl)
        setPkceParams({ codeVerifier: data.codeVerifier, clientId: data.clientId, redirectUri: data.redirectUri, state: data.state })
        setLoading(false)
        setCountdown(CODE_TTL_SECONDS)
        window.open(data.authUrl, '_blank')
      })
      .catch(() => {
        setError('Failed to start login flow')
        setLoading(false)
      })
  }

  // Fetch PKCE params from backend and open OAuth URL
  useEffect(() => {
    startSession(getStoredToken())
  }, [])

  // Countdown timer — warns user when the auth code is about to expire
  useEffect(() => {
    if (loading || done) return
    if (countdownRef.current) clearInterval(countdownRef.current)
    countdownRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          // Code expired — auto-refresh
          clearInterval(countdownRef.current!)
          setCodeInput('')
          startSession(getStoredToken())
          return CODE_TTL_SECONDS
        }
        return prev - 1
      })
    }, 1000)
    return () => { if (countdownRef.current) clearInterval(countdownRef.current) }
  }, [loading, done])

  // Extract the authorization code from either a raw code string or a full callback URL.
  const extractCode = (input: string): string => {
    try {
      const u = new URL(input.trim())
      const extracted = u.searchParams.get('code')
      if (extracted) return extracted
    } catch {
      // Not a URL, use as-is
    }
    return input.trim()
  }

  // Core exchange logic: try client-side first (no server round-trip), fall back to server-side.
  const submitCode = async (rawInput: string) => {
    if (!pkceParams) return
    const code = extractCode(rawInput)

    let stored = false
    try {
      // Attempt client-side token exchange directly with platform.claude.com.
      // This avoids the server-to-server round-trip. Will fail silently if CORS blocks it.
      const resp = await fetch('https://platform.claude.com/v1/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          redirect_uri: pkceParams.redirectUri,
          client_id: pkceParams.clientId,
          code_verifier: pkceParams.codeVerifier,
        }),
      })
      if (resp.ok) {
        const data = await resp.json()
        if (data.access_token) {
          await submitClaudeTokenDirect(data.access_token)
          stored = true
        }
      }
    } catch {
      // CORS block or network error — fall through to server-side
    }

    if (!stored) {
      await submitClaudeLoginCode(code, pkceParams.codeVerifier, pkceParams.clientId, pkceParams.redirectUri, pkceParams.state)
    }
  }

  const handleSubmitCode = async () => {
    if (!pkceParams || !codeInput.trim()) return
    setSubmitting(true)
    setError('')
    try {
      await submitCode(codeInput.trim())
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to complete login')
      setSubmitting(false)
    }
  }

  const handlePasteCode = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text').trim()
    if (!pasted) return
    setCodeInput(pasted)
    // Auto-submit immediately on paste — codes expire in ~60s
    setTimeout(() => {
      if (!pkceParams) return
      setSubmitting(true)
      setError('')
      submitCode(pasted)
        .then(() => setDone(true))
        .catch(err => {
          setError(err instanceof Error ? err.message : 'Failed to complete login')
          setSubmitting(false)
        })
    }, 0)
    e.preventDefault()
  }

  const handleSubmitDirect = async () => {
    if (!directToken.trim()) return
    setSubmitting(true)
    setError('')
    try {
      await submitClaudeTokenDirect(directToken.trim())
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to store token')
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div className="w-full max-w-md bg-gray-800 rounded-xl border border-gray-700 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-700 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">Login to Claude Code</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        {!done && (
          <div className="flex border-b border-gray-700">
            <button
              onClick={() => { setTab('oauth'); setError('') }}
              className={`flex-1 py-2 text-xs font-medium transition-colors ${tab === 'oauth' ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-gray-500 hover:text-gray-300'}`}
            >
              OAuth Login
            </button>
            <button
              onClick={() => { setTab('direct'); setError('') }}
              className={`flex-1 py-2 text-xs font-medium transition-colors ${tab === 'direct' ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-gray-500 hover:text-gray-300'}`}
            >
              Paste Token
            </button>
          </div>
        )}

        <div className="px-5 py-4 space-y-3">
          {done ? (
            <p className="text-sm text-green-400 font-medium">
              Authentication successful! Close this dialog to start using Claude Code.
            </p>
          ) : tab === 'oauth' ? (
            <>
              {loading && (
                <div className="flex items-center gap-2 text-gray-400 text-sm">
                  <div className="w-3 h-3 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                  Starting login process…
                </div>
              )}
              {!loading && authUrl && (
                <div className="space-y-3">
                  <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-3">
                    <p className="text-xs text-indigo-300 font-medium mb-1">Step 1: Authenticate in the browser tab that just opened</p>
                    <p className="text-xs text-indigo-200/70">
                      If it didn't open, <a href={authUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-indigo-200">click here</a>.
                    </p>
                  </div>
                  <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-3">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-xs text-indigo-300 font-medium">Step 2: Paste the code shown after login</p>
                      <span className={`text-xs font-mono font-semibold ${countdown <= 15 ? 'text-red-400' : countdown <= 30 ? 'text-yellow-400' : 'text-indigo-400'}`}>
                        {countdown}s
                      </span>
                    </div>
                    <p className="text-xs text-indigo-200/60 mb-2">The code auto-submits when pasted — move fast, codes expire in ~60s.</p>
                    {countdown <= 15 && (
                      <p className="text-xs text-yellow-400 mb-2">Expiring soon — will auto-refresh if time runs out.</p>
                    )}
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={codeInput}
                        onChange={(e) => setCodeInput(e.target.value)}
                        onPaste={handlePasteCode}
                        onKeyDown={(e) => e.key === 'Enter' && handleSubmitCode()}
                        placeholder="Paste authorization code here"
                        autoFocus
                        className="flex-1 bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                      />
                      <button
                        onClick={handleSubmitCode}
                        disabled={submitting || !codeInput.trim()}
                        className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium px-4 py-2 rounded-lg transition-colors shrink-0"
                      >
                        {submitting ? 'Signing in…' : 'Submit'}
                      </button>
                    </div>
                    {error && <p className="text-red-400 text-xs mt-1">{error}</p>}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="space-y-3">
              <div className="rounded-lg border border-gray-600 bg-gray-700/40 p-3">
                <p className="text-xs text-gray-300 font-medium mb-1">Paste your Claude OAuth token</p>
                <p className="text-xs text-gray-400 mb-3">
                  On a machine with Claude Code installed, run:<br />
                  <code className="text-indigo-300 font-mono">claude auth status --json</code><br />
                  and copy the <code className="text-indigo-300 font-mono">oauthToken</code> value (<span className="font-mono">sk-ant-oat01-…</span>).
                </p>
                <textarea
                  value={directToken}
                  onChange={(e) => setDirectToken(e.target.value)}
                  placeholder="sk-ant-oat01-…"
                  rows={3}
                  className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-white text-xs font-mono placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 resize-none"
                />
                <button
                  onClick={handleSubmitDirect}
                  disabled={submitting || !directToken.trim()}
                  className="mt-2 w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium py-2 rounded-lg transition-colors"
                >
                  {submitting ? 'Saving…' : 'Save Token'}
                </button>
                {error && <p className="text-red-400 text-xs mt-1">{error}</p>}
              </div>
            </div>
          )}
        </div>
        <div className="px-5 pb-4">
          <button onClick={onClose} className="w-full rounded-lg bg-gray-700 hover:bg-gray-600 py-2 text-sm text-gray-300 transition-colors">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
