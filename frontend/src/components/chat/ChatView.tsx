import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listProjectPrompts, ensureDir, getClaudeAuthStatus, getStoredToken, submitClaudeLoginCode, submitClaudeTokenDirect, listMCPServers, getSubscriptionUsage } from '../../api/client'
import { useAuth } from '../../contexts/AuthContext'
import { useMode } from '../../contexts/ModeContext'
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

interface ControlRequestMessage {
  role: 'control_request'
  requestId: string
  subtype: string
  toolName: string
  toolInput: Record<string, unknown>
  resolved?: 'allowed' | 'denied'
}

interface PlanModeMessage {
  role: 'plan_mode'
  requestId: string
  planText: string
  resolved?: 'accepted' | 'rejected'
  feedback?: string
}

interface LoginCodePromptMessage {
  role: 'login_code_prompt'
  text: string
}

type ChatMessage = UserMessage | AssistantMessage | ToolResultMessage | ControlRequestMessage | PlanModeMessage | LoginCodePromptMessage

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
  projectCode,
  localPath,
  compact,
  onStatusChange,
  onActivityChange,
  onSessionSnapshot,
  onWaitingChange,
}: ChatViewProps) {
  const { currentUser } = useAuth()
  const { mode: modeInfo } = useMode()
  const chatFontSize = currentUser?.claudeCodeFontSize || 14

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [inputText, setInputTextRaw] = useState(() => {
    try { return sessionStorage.getItem(`vibectl-draft-${projectCode}`) || '' } catch { return '' }
  })
  const setInputText = (v: string) => {
    setInputTextRaw(v)
    try { if (v) sessionStorage.setItem(`vibectl-draft-${projectCode}`, v); else sessionStorage.removeItem(`vibectl-draft-${projectCode}`) } catch { /* ignore */ }
  }
  const [status, setStatusState] = useState<string>('disconnected')
  const statusRef = useRef('disconnected')
  const setStatus = useCallback((s: string) => {
    statusRef.current = s
    setStatusState(s)
  }, [])
  const [contextPct, setContextPct] = useState<number | null>(null)
  const [costUsd, setCostUsd] = useState<number | null>(null)
  const [permissionMode, setPermissionModeRaw] = useState<'accept-all' | 'approve'>(() => {
    try {
      const saved = localStorage.getItem(`vibectl-perm-mode-${projectCode}`)
      if (saved === 'accept-all' || saved === 'approve') return saved
    } catch { /* ignore */ }
    return 'accept-all'
  })
  const setPermissionMode = (mode: 'accept-all' | 'approve') => {
    setPermissionModeRaw(mode)
    try { localStorage.setItem(`vibectl-perm-mode-${projectCode}`, mode) } catch { /* ignore */ }
  }
  const [slashHighlight, setSlashHighlight] = useState(0)
  const slashDismissedRef = useRef(false) // user pressed Escape to dismiss autocomplete
  const [showPromptPicker, setShowPromptPicker] = useState(false)
  const [isReconnecting, setIsReconnecting] = useState(false)
  const [compactingLabel, setCompactingLabel] = useState<string | null>(null)
  const compactingRef = useRef(false)
  const [exitError, setExitError] = useState<{ exitCode: number; stderr: string[] } | null>(null)
  const [showLoginModal, setShowLoginModal] = useState(false)

  // Inline slash command autocomplete — show when input starts with / and matches commands
  const slashMatches = useMemo(() => {
    const text = inputText.trim()
    if (!text.startsWith('/') || text.includes(' ') || slashDismissedRef.current) return []
    return SLASH_COMMANDS.filter(c => c.name.startsWith(text.toLowerCase()))
  }, [inputText])

  // Reset highlight when matches change, and clear dismissed flag when input changes away from /
  useEffect(() => {
    setSlashHighlight(0)
  }, [slashMatches.length])

  useEffect(() => {
    if (!inputText.startsWith('/')) slashDismissedRef.current = false
  }, [inputText])

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
  const loginPkceRef = useRef<{ authUrl: string; codeVerifier: string; clientId: string; redirectUri: string; state: string } | null>(null)
  const activityTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const isActiveRef = useRef(false)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const isReplayingRef = useRef(false)

  // Input history (shell-style up/down arrow navigation), persisted to localStorage
  const historyKey = `vibectl-input-history-${projectCode}`
  const inputHistoryRef = useRef<string[]>(
    (() => { try { return JSON.parse(localStorage.getItem(historyKey) || '[]') } catch { return [] } })()
  )
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

  const [replayDone, setReplayDone] = useState(0) // incremented when replay finishes to trigger scroll

  useEffect(() => {
    if (!isReplayingRef.current && !userScrolledUpRef.current) {
      scrollToBottom()
    }
  }, [messages, streamingText, replayDone, scrollToBottom])

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
          data: { projectCode, localPath: localPath || '' },
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
  }, [projectCode, localPath])

  const handleEvent = useCallback((data: Record<string, unknown>) => {
    const type = data.type as string

    switch (type) {
      case 'status': {
        const statusData = data.data as { status: string }
        const s = statusData.status
        setStatus(s)
        onStatusChange?.(s)
        if (s === 'reconnected' || s === 'started' || s === 'restarted') {
          // Replay is done — trigger scroll after React renders
          isReplayingRef.current = false
          userScrolledUpRef.current = false
          setIsReconnecting(false)
          setCompactingLabel(null)
          compactingRef.current = false
          setExitError(null)
          setReplayDone(n => n + 1)
        }
        if (s === 'exited') {
          onActivityChange?.(false)
          setIsStreaming(false)
          setAwaitingResult(false)
        }
        break
      }

      case 'login_params': {
        // PKCE params received — store them and show inline code prompt
        const lp = data.data as { authUrl: string; codeVerifier: string; clientId: string; redirectUri: string; state: string }
        loginPkceRef.current = lp
        setMessages((prev) => [...prev, {
          role: 'login_code_prompt',
          text: 'Complete authentication in the browser, then paste the code here.',
        }])
        break
      }

      case 'login_status': {
        const ls = data.data as { status: string; message: string }
        if (ls.status === 'success') {
          loginPkceRef.current = null
          setMessages((prev) => prev.filter(m => m.role !== 'login_code_prompt'))
          setMessages((prev) => [...prev, {
            role: 'assistant',
            content: [{ type: 'text', text: `**${ls.message}** — session restarting with new account.` }],
          }])
        } else if (ls.status === 'error') {
          loginPkceRef.current = null
          setMessages((prev) => prev.filter(m => m.role !== 'login_code_prompt'))
          setMessages((prev) => [...prev, {
            role: 'assistant',
            content: [{ type: 'text', text: `**Login failed:** ${ls.message}` }],
          }])
        }
        break
      }

      case 'system': {
        // Init event — session started
        isReplayingRef.current = false
        userScrolledUpRef.current = false
        setReplayDone(n => n + 1)
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

      case 'control_request': {
        // Permission prompt from Claude Code (tool approval, user question, etc.)
        const request = data.request as { subtype?: string; tool_name?: string; input?: Record<string, unknown> } | undefined
        const requestId = data.request_id as string
        if (requestId && request) {
          // Log all control_request events for debugging
          console.log('[vibectl] control_request:', JSON.stringify({ requestId, subtype: request.subtype, tool_name: request.tool_name, inputKeys: request.input ? Object.keys(request.input) : [] }, null, 2))

          // Detect plan mode events — match on subtype or tool name
          const isPlanMode = request.subtype === 'plan_mode_respond' ||
            request.subtype === 'plan_mode' ||
            request.tool_name === 'EnterPlanMode' ||
            request.tool_name === 'ExitPlanMode' ||
            (request.input && typeof request.input === 'object' && 'plan' in request.input)
          if (isPlanMode) {
            // Extract plan text from whichever field Claude uses
            const input = request.input || {}
            const planText = (input.plan as string) ||
              (input.prompt as string) ||
              (input.content as string) ||
              (input.text as string) ||
              (input.message as string) ||
              (typeof input.description === 'string' ? input.description : '') ||
              JSON.stringify(input, null, 2)
            setMessages((prev) => [...prev, {
              role: 'plan_mode' as const,
              requestId,
              planText,
            }])
          } else {
            setMessages((prev) => [...prev, {
              role: 'control_request',
              requestId,
              subtype: request.subtype || 'can_use_tool',
              toolName: request.tool_name || 'Unknown',
              toolInput: request.input || {},
            }])
          }
          setIsStreaming(false)
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
          if (isNotLoggedInResult || isAuthError) {
            // Show login UI — auto-restart loops with bad credentials
            setExitError({ exitCode: 1, stderr: [resultMsg || 'Authentication failed'] })
            setIsStreaming(false)
            setAwaitingResult(false)
            setStatus('claude_error')
            onStatusChange?.('claude_error')
            onActivityChange?.(false)
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

        if (isNotLoggedInError || isAuthError) {
          // Show the login button UI — both "not logged in" and auth failures
          // need user action (auto-restart loops with bad credentials)
          setExitError({ exitCode: 1, stderr: [errorMessage] })
          setIsStreaming(false)
          setAwaitingResult(false)
          setStatus('claude_error')
          onStatusChange?.('claude_error')
          onActivityChange?.(false)
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

  // Flush any queued messages when we reconnect (but not while compacting — wait for restarted)
  useEffect(() => {
    if (compactingRef.current) return
    const connected = ['started', 'connected', 'reconnected', 'restarted'].includes(status)
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

  const sendWsMessage = useCallback((type: string, data?: Record<string, unknown>) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    wsRef.current.send(JSON.stringify({ type, data }))
  }, [])

  const executeSlashCommand = useCallback((cmdName: string) => {
    setInputText('')
    if (cmdName === '/login') {
      if (modeInfo?.mode === 'standalone') {
        // Standalone dev: PKCE OAuth flow via WS — no keychain mutation
        setIsReconnecting(false)
        setExitError(null)
        sendWsMessage('login_start', { projectCode: projectCode, localPath: localPath })
      } else {
        // Remote/client mode: use the token paste modal
        setShowLoginModal(true)
      }
    } else if (cmdName === '/compact' || cmdName === '/reload') {
      setCompactingLabel(cmdName === '/compact' ? 'Compacting context and resuming session...' : 'Reloading MCPs and resuming session...')
      compactingRef.current = true
      sendWsMessage('restart', { skipPermissions: permissionMode === 'accept-all' })
    } else if (cmdName === '/fresh') {
      setCompactingLabel('Starting fresh session...')
      compactingRef.current = true
      sendWsMessage('fresh_start', { skipPermissions: permissionMode === 'accept-all' })
    } else if (cmdName === '/usage') {
      getSubscriptionUsage().then((usage) => {
        const formatReset = (iso: string) => {
          const d = new Date(iso)
          const now = new Date()
          const diffMs = d.getTime() - now.getTime()
          const diffHrs = Math.floor(diffMs / 3600000)
          const diffMin = Math.floor((diffMs % 3600000) / 60000)
          if (diffHrs > 24) return `${Math.floor(diffHrs / 24)}d ${diffHrs % 24}h`
          if (diffHrs > 0) return `${diffHrs}h ${diffMin}m`
          return `${diffMin}m`
        }
        const bar = (pct: number) => {
          const filled = Math.round(pct / 5)
          return '`' + '\u2588'.repeat(filled) + '\u2591'.repeat(20 - filled) + '`'
        }
        const lines: string[] = []
        lines.push(`**Claude Subscription** _(${usage.subscriptionType})_\n`)
        if (usage.fiveHour) {
          lines.push(`**Session (5h):** ${usage.fiveHour.utilization}% ${bar(usage.fiveHour.utilization)} resets in ${formatReset(usage.fiveHour.resetsAt)}`)
        }
        if (usage.sevenDay) {
          lines.push(`**Weekly (7d):** ${usage.sevenDay.utilization}% ${bar(usage.sevenDay.utilization)} resets in ${formatReset(usage.sevenDay.resetsAt)}`)
        }
        if (usage.sevenDaySonnet) {
          lines.push(`**Sonnet (7d):** ${usage.sevenDaySonnet.utilization}% ${bar(usage.sevenDaySonnet.utilization)} resets in ${formatReset(usage.sevenDaySonnet.resetsAt)}`)
        }
        if (usage.sevenDayOpus) {
          lines.push(`**Opus (7d):** ${usage.sevenDayOpus.utilization}% ${bar(usage.sevenDayOpus.utilization)} resets in ${formatReset(usage.sevenDayOpus.resetsAt)}`)
        }
        if (usage.extraUsage?.isEnabled) {
          lines.push(`\n_Extra usage enabled_ — $${usage.extraUsage.usedCredits.toFixed(2)} used${usage.extraUsage.monthlyLimit ? ` / $${usage.extraUsage.monthlyLimit} limit` : ''}`)
        }
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        }])
      }).catch((err: Error) => {
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: [{ type: 'text' as const, text: `Failed to fetch usage: ${err.message}` }],
        }])
      })
    } else if (cmdName === '/mcp') {
      // List configured MCP servers inline
      listMCPServers(localPath).then((data: { servers: Array<{ name: string; type: string; command?: string; url?: string; source: string }> }) => {
        if (data.servers.length === 0) {
          setMessages((prev) => [...prev, {
            role: 'assistant',
            content: [{ type: 'text' as const, text: 'No MCP servers configured.' }],
          }])
        } else {
          const lines = data.servers.map((s: { name: string; type: string; command?: string; url?: string; source: string }) => {
            const typeTag = s.type === 'stdio' ? `\`stdio\` ${s.command || ''}` : `\`${s.type}\` ${s.url || ''}`
            const sourceTag = s.source === 'user' ? 'user' : s.source === 'project' ? 'project' : '.mcp.json'
            return `- **${s.name}** — ${typeTag} _(${sourceTag})_`
          }).join('\n')
          setMessages((prev) => [...prev, {
            role: 'assistant',
            content: [{ type: 'text' as const, text: `**MCP Servers (${data.servers.length})**\n\n${lines}\n\n_Use \`/reload\` to restart session and pick up MCP config changes._` }],
          }])
        }
      }).catch((err: Error) => {
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: [{ type: 'text' as const, text: `Failed to list MCP servers: ${err.message}` }],
        }])
      })
    } else if (cmdName === '/permissions auto') {
      setPermissionMode('accept-all')
      sendWsMessage('restart', { skipPermissions: true })
    } else if (cmdName === '/permissions approve') {
      setPermissionMode('approve')
      sendWsMessage('restart', { skipPermissions: false })
    } else {
      // Other slash commands — send as user message text (keep the / so Claude Code recognizes them)
      setMessages((prev) => [...prev, { role: 'user', text: cmdName }])
      setAwaitingResult(true)
      markActive()
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'user_message', data: { text: cmdName } }))
      }
    }
  }, [sendWsMessage, permissionMode, modeInfo, projectCode, localPath])

  const sendMessage = useCallback(() => {
    const text = inputText.trim()
    if (!text) return

    // Intercept exact slash commands typed manually (when autocomplete wasn't used)
    const exactCmd = SLASH_COMMANDS.find(c => c.name === text)
    if (exactCmd) {
      executeSlashCommand(exactCmd.name)
      return
    }

    // Push to history and persist
    inputHistoryRef.current.push(text)
    // Keep last 200 entries to avoid unbounded growth
    if (inputHistoryRef.current.length > 200) inputHistoryRef.current = inputHistoryRef.current.slice(-200)
    try { localStorage.setItem(historyKey, JSON.stringify(inputHistoryRef.current)) } catch { /* ignore */ }
    historyIndexRef.current = -1
    savedInputRef.current = ''

    // Add user message to UI
    setMessages((prev) => [...prev, { role: 'user', text }])
    setInputText('')

    // Mark as working until result arrives
    setAwaitingResult(true)
    markActive()

    // Send or queue (queue during compaction since there's no active Claude session)
    if (compactingRef.current) {
      pendingMessagesRef.current.push(text)
    } else if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'user_message',
        data: { text },
      }))
    } else {
      pendingMessagesRef.current.push(text)
    }

    // Focus input
    inputRef.current?.focus()
  }, [inputText, executeSlashCommand])

  // Listen for external "send to this project" events (from Modules tab post-op)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { projectCode: string; text: string }
      if (detail.projectCode !== projectId) return
      // Inject as a user message
      setMessages((prev) => [...prev, { role: 'user', text: detail.text }])
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'user_message', data: { text: detail.text } }))
      }
    }
    window.addEventListener('vibectl:send-to-project', handler)
    return () => window.removeEventListener('vibectl:send-to-project', handler)
  }, [projectId])

  const handlePlanResponse = useCallback((requestId: string, accept: boolean, feedback?: string) => {
    const response = accept
      ? { subtype: 'success', behavior: 'allow' }
      : { subtype: 'success', behavior: 'deny', message: feedback || 'Plan rejected' }
    sendWsMessage('control_response', { requestId, response })
    setMessages((prev) => prev.map((m) =>
      m.role === 'plan_mode' && m.requestId === requestId
        ? { ...m, resolved: accept ? 'accepted' as const : 'rejected' as const, feedback: feedback || '' }
        : m
    ))
  }, [sendWsMessage])

  const handleControlResponse = useCallback((requestId: string, behavior: 'allow' | 'deny', message?: string) => {
    const response = behavior === 'allow'
      ? { subtype: 'success', behavior: 'allow' }
      : { subtype: 'success', behavior: 'deny', message: message || 'Denied by user' }
    sendWsMessage('control_response', { requestId, response })
    // Mark the control_request as resolved
    setMessages((prev) => prev.map((m) =>
      m.role === 'control_request' && m.requestId === requestId
        ? { ...m, resolved: behavior === 'allow' ? 'allowed' as const : 'denied' as const }
        : m
    ))
  }, [sendWsMessage])

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
    // Slash autocomplete navigation
    if (slashMatches.length > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashHighlight(i => (i - 1 + slashMatches.length) % slashMatches.length)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashHighlight(i => (i + 1) % slashMatches.length)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        executeSlashCommand(slashMatches[slashHighlight].name)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        // Tab-complete the command name into the input
        setInputText(slashMatches[slashHighlight].name)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        slashDismissedRef.current = true
        setSlashHighlight(0)
        return
      }
    }

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
  }, [sendMessage, inputText, slashMatches, slashHighlight, executeSlashCommand])

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
              title="Skip all permission checks (full autonomy)"
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
              title="Auto-approve reads and edits, block dangerous operations"
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
        </div>
      </div>

      {/* Messages area */}
      <div ref={messagesContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-3 py-2 space-y-3 min-h-0" style={chatFontSize !== 14 ? { zoom: chatFontSize / 14 } : undefined}>
        {messages.length === 0 && !isStreaming && !exitError && (
          <div className="flex items-center justify-center h-full text-gray-600 text-sm">
            {isConnected ? 'Send a message to start' : status === 'exited' ? 'Session ended' : 'Connecting...'}
          </div>
        )}

        {messages.map((msg, i) => {
          if (msg.role === 'login_code_prompt') {
            return <LoginCodePrompt key={i} onSubmit={(code) => {
              const pkce = loginPkceRef.current
              if (!pkce) return
              sendWsMessage('login_exchange', {
                code,
                codeVerifier: pkce.codeVerifier,
                clientId: pkce.clientId,
                redirectUri: pkce.redirectUri,
                projectCode: projectCode,
                localPath: localPath,
              })
            }} />
          }
          return <MessageRenderer key={i} message={msg} compact={compact} onControlResponse={handleControlResponse} onPlanResponse={handlePlanResponse} />
        })}

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
          const isNotLoggedIn = allText.includes('not logged in') || allText.includes('please run /login') || allText.includes('run claude login') || allText.includes('authentication_error') || allText.includes('invalid authentication')
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
        {showLoginModal && (
          <ClaudeLoginModal
            onClose={() => setShowLoginModal(false)}
            onToken={(token) => {
              // Set per-project token and restart session with new account
              setIsReconnecting(false)
              setExitError(null)
              sendWsMessage('set_project_token', { token, projectCode: projectCode, localPath: localPath })
            }}
            isStandalone={modeInfo?.mode === 'standalone'}
          />
        )}

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

        {compactingLabel && (
          <div className="flex items-center gap-2 text-cyan-400 text-xs px-2 py-1.5 rounded bg-cyan-900/20 border border-cyan-700/30">
            <svg className="w-3.5 h-3.5 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span>{compactingLabel}</span>
            {pendingMessagesRef.current.length > 0 && (
              <span className="text-cyan-500/70 ml-1">({pendingMessagesRef.current.length} message{pendingMessagesRef.current.length > 1 ? 's' : ''} queued)</span>
            )}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area — never disabled so messages can be queued */}
      <div className="shrink-0 border-t border-gray-700/50 p-2 bg-gray-900/80">
        <div className="relative flex gap-2">
          {/* Slash command autocomplete dropdown */}
          {slashMatches.length > 0 && (
            <div className="absolute bottom-full left-0 mb-1 w-80 max-h-56 overflow-y-auto bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50">
              {slashMatches.map((cmd, i) => (
                <button
                  key={cmd.name}
                  onMouseDown={(e) => { e.preventDefault(); executeSlashCommand(cmd.name) }}
                  className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                    i === slashHighlight ? 'bg-indigo-600/30' : 'hover:bg-gray-700/50'
                  }`}
                >
                  <code className="text-xs font-mono text-indigo-400 shrink-0">{cmd.name}</code>
                  <span className="text-[11px] text-gray-500 truncate">{cmd.description}</span>
                </button>
              ))}
              <div className="px-3 py-1 border-t border-gray-700/50 text-[10px] text-gray-600">
                <kbd className="text-gray-500">↑↓</kbd> navigate · <kbd className="text-gray-500">Enter</kbd> execute · <kbd className="text-gray-500">Tab</kbd> complete · <kbd className="text-gray-500">Esc</kbd> dismiss
              </div>
            </div>
          )}
          <textarea
            ref={inputRef}
            value={inputText}
            onChange={(e) => { setInputText(e.target.value); if (showPromptPicker) setShowPromptPicker(false) }}
            onKeyDown={handleKeyDown}
            placeholder={isConnected ? 'Message Claude... (type / for commands)' : 'Connecting... (messages will be queued)'}
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
                      setInputText(inputText ? inputText + '\n' + p.body : p.body)
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

// --- Inline Login Code Prompt ---

function LoginCodePrompt({ onSubmit }: { onSubmit: (code: string) => void }) {
  const [code, setCode] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const handleSubmit = () => {
    if (!code.trim() || submitted) return
    setSubmitted(true)
    onSubmit(code.trim())
  }

  return (
    <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-3 space-y-2">
      <p className="text-xs text-indigo-300 font-medium">Complete authentication in the browser, then paste the code below.</p>
      <p className="text-[10px] text-indigo-200/60">The code is shown on the page after you sign in. It expires quickly — paste it right away.</p>
      <div className="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text').trim()
            if (pasted) {
              e.preventDefault()
              setCode(pasted)
              setSubmitted(true)
              onSubmit(pasted)
            }
          }}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          placeholder="Paste authorization code..."
          disabled={submitted}
          className="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-1.5 text-white text-xs font-mono placeholder-gray-500 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
        />
        <button
          onClick={handleSubmit}
          disabled={!code.trim() || submitted}
          className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 rounded transition-colors"
        >
          {submitted ? 'Signing in...' : 'Submit'}
        </button>
      </div>
    </div>
  )
}

// --- Slash Command Autocomplete ---

const SLASH_COMMANDS = [
  { name: '/compact', description: 'Free context window (resume with compacted context)' },
  { name: '/fresh', description: 'Start a fresh session (clears all context)' },
  { name: '/reload', description: 'Reload MCPs and resume session with context' },
  { name: '/mcp', description: 'List configured MCP servers' },
  { name: '/usage', description: 'Show Claude subscription usage and limits' },
  { name: '/login', description: 'Log in or switch Claude Code account' },
  { name: '/permissions auto', description: 'Accept all tool calls automatically' },
  { name: '/permissions approve', description: 'Require approval for tool calls' },
  { name: '/review', description: 'Review a pull request' },
  { name: '/init', description: 'Create a CLAUDE.md for this project' },
  { name: '/memory', description: 'Review and edit project memory' },
  { name: '/status', description: 'Report current session and project status' },
  { name: '/pr-comments', description: 'View and address PR review comments' },
  { name: '/model', description: 'Switch model (e.g. /model sonnet)' },
]

// --- Sub-components ---

function PlanModePrompt({ message, onRespond, compact }: {
  message: PlanModeMessage
  onRespond?: (requestId: string, accept: boolean, feedback?: string) => void
  compact?: boolean
}) {
  const { requestId, planText, resolved, feedback: savedFeedback } = message
  const [feedbackText, setFeedbackText] = useState('')
  const [showFeedback, setShowFeedback] = useState(false)

  if (resolved) {
    return (
      <div className={`rounded-lg border px-3 py-2 ${
        resolved === 'accepted' ? 'border-emerald-700/50 bg-emerald-900/10' : 'border-orange-700/50 bg-orange-900/10'
      }`}>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs">&#x1f4cb;</span>
          <span className={`text-[10px] font-semibold uppercase tracking-wider ${
            resolved === 'accepted' ? 'text-emerald-400' : 'text-orange-400'
          }`}>
            Plan {resolved}
          </span>
        </div>
        <div className={`prose prose-invert max-w-none ${compact ? 'prose-xs' : 'prose-sm'} max-h-40 overflow-y-auto`}>
          <MarkdownContent text={planText} />
        </div>
        {savedFeedback && (
          <p className="text-[11px] text-orange-300/70 mt-1 italic">Feedback: {savedFeedback}</p>
        )}
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-cyan-600/50 bg-cyan-900/10 px-3 py-2.5">
      <div className="flex items-center gap-2 mb-2">
        <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
        <span className={`font-semibold text-cyan-300 ${compact ? 'text-xs' : 'text-sm'}`}>
          Claude&apos;s Plan
        </span>
      </div>
      <div className={`prose prose-invert max-w-none ${compact ? 'prose-xs' : 'prose-sm'} bg-gray-900/60 rounded p-3 mb-2 max-h-80 overflow-y-auto`}>
        <MarkdownContent text={planText} />
      </div>
      {showFeedback && (
        <textarea
          value={feedbackText}
          onChange={(e) => setFeedbackText(e.target.value)}
          placeholder="Provide feedback on the plan..."
          className="w-full bg-gray-900/80 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-300 mb-2 resize-none"
          rows={3}
          autoFocus
        />
      )}
      <div className="flex gap-2">
        <button
          onClick={() => onRespond?.(requestId, true)}
          className="bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-medium px-3 py-1 rounded transition-colors"
        >
          Accept Plan
        </button>
        {showFeedback ? (
          <button
            onClick={() => {
              onRespond?.(requestId, false, feedbackText || 'Plan rejected')
              setShowFeedback(false)
            }}
            className="bg-orange-800/60 hover:bg-orange-700 text-orange-300 text-xs font-medium px-3 py-1 rounded border border-orange-700/50 transition-colors"
          >
            Send Feedback
          </button>
        ) : (
          <button
            onClick={() => setShowFeedback(true)}
            className="bg-gray-700/60 hover:bg-gray-600 text-gray-300 text-xs font-medium px-3 py-1 rounded border border-gray-600/50 transition-colors"
          >
            Give Feedback
          </button>
        )}
      </div>
    </div>
  )
}

function PermissionPrompt({ message, onRespond, compact }: {
  message: ControlRequestMessage
  onRespond?: (requestId: string, behavior: 'allow' | 'deny', message?: string) => void
  compact?: boolean
}) {
  const { requestId, toolName, toolInput, resolved, subtype } = message
  const isQuestion = subtype === 'ask_user_question'
  const inputSummary = (() => {
    if (isQuestion) {
      const questions = toolInput.questions as Array<{ question: string }> | undefined
      return questions?.map(q => q.question).join('\n') || ''
    }
    // For tool calls, show a compact summary
    if (toolInput.command) return String(toolInput.command)
    if (toolInput.file_path) return String(toolInput.file_path)
    if (toolInput.content) return `${String(toolInput.content).slice(0, 120)}...`
    const keys = Object.keys(toolInput)
    if (keys.length === 0) return ''
    return JSON.stringify(toolInput, null, 2)
  })()

  if (resolved) {
    return (
      <div className={`rounded-lg border px-3 py-2 ${
        resolved === 'allowed' ? 'border-green-700/50 bg-green-900/10' : 'border-red-700/50 bg-red-900/10'
      }`}>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-semibold uppercase tracking-wider ${
            resolved === 'allowed' ? 'text-green-400' : 'text-red-400'
          }`}>
            {resolved === 'allowed' ? 'Approved' : 'Denied'}: {toolName}
          </span>
        </div>
        {inputSummary && (
          <pre className={`mt-1 text-gray-500 whitespace-pre-wrap break-all ${compact ? 'text-[10px]' : 'text-xs'}`}>
            {inputSummary.slice(0, 200)}{inputSummary.length > 200 ? '...' : ''}
          </pre>
        )}
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-purple-600/50 bg-purple-900/10 px-3 py-2.5">
      <div className="flex items-center gap-2 mb-1">
        <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
        <span className={`font-semibold text-purple-300 ${compact ? 'text-xs' : 'text-sm'}`}>
          {isQuestion ? 'Question' : `Approve: ${toolName}`}
        </span>
      </div>
      {inputSummary && (
        <pre className={`mb-2 text-gray-300 bg-gray-900/60 rounded p-2 whitespace-pre-wrap break-all max-h-40 overflow-y-auto ${compact ? 'text-[10px]' : 'text-xs'}`}>
          {inputSummary}
        </pre>
      )}
      <div className="flex gap-2">
        <button
          onClick={() => onRespond?.(requestId, 'allow')}
          className="bg-green-700 hover:bg-green-600 text-white text-xs font-medium px-3 py-1 rounded transition-colors"
        >
          Allow
        </button>
        <button
          onClick={() => onRespond?.(requestId, 'deny')}
          className="bg-red-800/60 hover:bg-red-700 text-red-300 text-xs font-medium px-3 py-1 rounded border border-red-700/50 transition-colors"
        >
          Deny
        </button>
      </div>
    </div>
  )
}

const MessageRenderer = memo(function MessageRenderer({ message, compact, onControlResponse, onPlanResponse }: {
  message: ChatMessage; compact?: boolean
  onControlResponse?: (requestId: string, behavior: 'allow' | 'deny', message?: string) => void
  onPlanResponse?: (requestId: string, accept: boolean, feedback?: string) => void
}) {
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

  if (message.role === 'plan_mode') {
    return <PlanModePrompt message={message} onRespond={onPlanResponse} compact={compact} />
  }

  if (message.role === 'control_request') {
    return <PermissionPrompt message={message} onRespond={onControlResponse} compact={compact} />
  }

  // Login code prompt (handled elsewhere in the UI, but guard the type)
  if (message.role === 'login_code_prompt') {
    return null
  }

  // Assistant message
  return (
    <div className="space-y-2">
      {message.content.map((block: ContentBlock, i: number) => {
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

const PLAN_TOOL_NAMES = new Set(['EnterPlanMode', 'ExitPlanMode', 'ExitPlan'])

function extractPlanText(input: Record<string, unknown>): string {
  // Claude Code plan tools put the plan in various fields — try them all
  for (const key of ['plan', 'prompt', 'content', 'text', 'message', 'description', 'plan_text']) {
    if (typeof input[key] === 'string' && (input[key] as string).length > 0) return input[key] as string
  }
  // Sometimes the plan is the only string value in the input
  const vals = Object.values(input).filter(v => typeof v === 'string' && (v as string).length > 20)
  if (vals.length === 1) return vals[0] as string
  return JSON.stringify(input, null, 2)
}

const PlanToolCard = memo(function PlanToolCard({ block, compact }: { block: ToolUseBlock; compact?: boolean }) {
  const planText = extractPlanText(block.input)
  const isJson = planText.startsWith('{') || planText.startsWith('[')

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-[10px] font-semibold text-cyan-400 uppercase tracking-wider">Plan</span>
        <div className="flex-1 h-px bg-cyan-800/30" />
      </div>
      {isJson ? (
        <pre className={`text-gray-400 whitespace-pre-wrap font-mono ${compact ? 'text-[10px]' : 'text-[11px]'}`}>{planText}</pre>
      ) : (
        <div className={`prose prose-invert max-w-none ${compact ? 'prose-sm' : ''}`}>
          <MarkdownContent text={planText} />
        </div>
      )}
    </div>
  )
})

const ToolCallCard = memo(function ToolCallCard({ block, compact }: { block: ToolUseBlock; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const [showDiff, setShowDiff] = useState(false)

  // Plan mode tools get a special renderer
  if (PLAN_TOOL_NAMES.has(block.name)) {
    return <PlanToolCard block={block} compact={compact} />
  }

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

const PLAN_RESULT_PATTERNS = /exit plan mode|enter plan mode|plan mode/i

const ToolResultCard = memo(function ToolResultCard({ message, compact }: { message: ToolResultMessage; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const isLong = message.content.length > 200
  const isPlanResult = PLAN_RESULT_PATTERNS.test(message.content)

  // Suppress plan mode "error" results — they're just Claude asking to exit plan mode,
  // which is already handled by the plan card above
  if (isPlanResult && message.isError) {
    return null
  }

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

function ClaudeLoginModal({ onClose, onToken, isStandalone: _isStandalone }: { onClose: () => void; onToken?: (token: string) => void; isStandalone?: boolean }) {
  const [tab, setTab] = useState<'oauth' | 'direct'>('direct')
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
      .then(r => {
        if (!r.ok) throw new Error(`Login endpoint returned ${r.status}`)
        return r.json()
      })
      .then((data: { authUrl: string; codeVerifier: string; clientId: string; redirectUri: string; state: string }) => {
        if (!data.authUrl || !data.codeVerifier) throw new Error('Missing PKCE parameters from server')
        setAuthUrl(data.authUrl)
        setPkceParams({ codeVerifier: data.codeVerifier, clientId: data.clientId, redirectUri: data.redirectUri, state: data.state })
        setLoading(false)
        setCountdown(CODE_TTL_SECONDS)
        window.open(data.authUrl, '_blank')
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to start login flow')
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
  // Authorization codes are single-use — if client-side gets a response (even an error),
  // the code is consumed and server-side fallback would get invalid_grant.
  const submitCode = async (rawInput: string) => {
    if (!pkceParams) return
    const code = extractCode(rawInput)
    console.log('[claude-login] submitCode called', { codeLen: code.length, codePreview: code.slice(0, 8) + '...' })

    try {
      // Attempt client-side token exchange directly with platform.claude.com.
      // This avoids the server-to-server round-trip.
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
          onToken?.(data.access_token)
          return // success
        }
      }
      // Got a response but not OK — code is consumed, surface the error
      const errData = await resp.json().catch(() => ({ error_description: `HTTP ${resp.status}` }))
      throw new Error(errData.error_description || `token exchange failed (${resp.status})`)
    } catch (err) {
      if (err instanceof TypeError) {
        // TypeError = CORS block or network error — code was NOT consumed, safe to try server-side
        await submitClaudeLoginCode(code, pkceParams.codeVerifier, pkceParams.clientId, pkceParams.redirectUri, pkceParams.state)
      } else {
        throw err // re-throw the error we created above
      }
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
      onToken?.(directToken.trim())
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
                <p className="text-xs text-gray-300 font-medium mb-1">Paste a Claude OAuth token</p>
                <p className="text-xs text-gray-400 mb-3">
                  Open a terminal and run:<br />
                  <code className="text-indigo-300 font-mono">claude auth status --json</code><br />
                  Copy the <code className="text-indigo-300 font-mono">oauthToken</code> value — it starts with <span className="font-mono text-indigo-300">sk-ant-oat01-…</span><br />
                  <span className="text-yellow-400/80 mt-1 block">Not the code from the browser OAuth page — that is an authorization code, not a token.</span>
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
