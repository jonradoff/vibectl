import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { listProjectPrompts, ensureDir, getClaudeAuthStatus, getStoredToken, submitClaudeLoginCode, submitClaudeTokenDirect, listMCPServers, getSubscriptionUsage, listPluginCommands, getProjectContextHealth, getAdapterStatus, updateProject } from '../../api/client'
import { ModelPicker } from '../shared/ModelPicker'
import type { Project } from '../../types'
import { useAuth } from '../../contexts/AuthContext'
import PluginManagerModal from '../plugins/PluginManagerModal'
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
  onModelChange?: (model: string) => void
  configuredModel?: string  // project.model override, used as fallback before message_start arrives
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

// Task tracker state — accumulated from TaskCreate/TaskUpdate calls across
// the assistant's messages. taskId mirrors the sequential integer Claude
// Code assigns at TaskCreate time (its input carries only subject/assignee;
// the returned id is 1-indexed). `tasks: null` means "this message didn't
// touch the tracker, so don't render the roll-up card here."
type TaskItem = { taskId: string; subject: string; assignee?: string; status: string; order: number }
type TaskSnapshot = { tasks: TaskItem[] | null }

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

// Persist WebSocket connections and message state across fullscreen remounts.
// Keyed by projectCode. Cleaned up only when the WS closes naturally.
const persistentWs = new Map<string, WebSocket>()
const persistentMessages = new Map<string, ChatMessage[]>()
const persistentStreamingText = new Map<string, string>()

// killChatConnection tears down the cached WS + message buffer for a project
// so the next ChatView mount opens a genuinely fresh connection (and sends a
// fresh `launch` message on ws.onopen). Used by the Session History Restart
// button — without this call, the chatViewKey bump remounts ChatView but the
// mount effect finds the still-open WS in persistentWs and reattaches to it,
// silently skipping the launch, leaving the server with no activeProjectID
// and the user with a "disconnected, typing does nothing" window.
export function killChatConnection(projectCode: string) {
  const ws = persistentWs.get(projectCode)
  if (ws) {
    try { ws.close() } catch { /* ignore */ }
    persistentWs.delete(projectCode)
  }
  persistentMessages.delete(projectCode)
  persistentStreamingText.delete(projectCode)
}

export default function ChatView({
  projectId,
  projectCode,
  localPath,
  compact,
  onStatusChange,
  onActivityChange,
  onSessionSnapshot,
  onWaitingChange,
  onModelChange,
  configuredModel,
}: ChatViewProps) {
  const { currentUser } = useAuth()
  const { mode: modeInfo } = useMode()
  const chatFontSize = currentUser?.claudeCodeFontSize || 14

  const [messages, setMessagesRaw] = useState<ChatMessage[]>(() => persistentMessages.get(projectCode) ?? [])
  const setMessages = useCallback((update: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
    setMessagesRaw(prev => {
      const next = typeof update === 'function' ? update(prev) : update
      persistentMessages.set(projectCode, next)
      return next
    })
  }, [projectCode])
  const [streamingText, setStreamingTextRaw] = useState(() => persistentStreamingText.get(projectCode) ?? '')
  const setStreamingText = useCallback((update: string | ((prev: string) => string)) => {
    setStreamingTextRaw(prev => {
      const next = typeof update === 'function' ? update(prev) : update
      persistentStreamingText.set(projectCode, next)
      return next
    })
  }, [projectCode])
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
  const [modelUnavailable, setModelUnavailable] = useState<{ message: string } | null>(null)
  const [pickerModel, setPickerModel] = useState('')
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [currentModel, setCurrentModel] = useState<string>(configuredModel || '')
  const queryClient = useQueryClient()

  // Seed currentModel from configuredModel ONLY while we still have no live
  // signal (no user pick, no message_start). Once currentModel is set —
  // either by user picking through the chip or by an assistant event — it
  // is the source of truth and configuredModel must not overwrite it.
  //
  // Old code overwrote unconditionally whenever configuredModel !== currentModel,
  // which caused this bug: user picks opus → updateProject writes to DB →
  // setCurrentModel("opus") → but the React Query cache still says fable-5 →
  // next render the prop is stale "fable-5" → effect fires "fable-5 !==
  // opus" → currentModel reverts to fable-5 → chip flips back → header chip
  // flips back via onModelChange. Confirmed by Jon: LOOM changed to opus,
  // both chips showed opus, later reverted to fable-5 while claude actually
  // stayed on opus.
  useEffect(() => {
    if (!currentModel && configuredModel) {
      setCurrentModel(configuredModel)
      onModelChange?.(configuredModel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configuredModel])
  const [showLoginModal, setShowLoginModal] = useState(false)
  // Pre-login picker: Anthropic runs two separate authorization servers
  // (Console for Team/Org, Claude.ai for personal Max/Pro). A user with
  // both on the same email only sees ONE of them on any given authorize
  // page. So we ask which one to route to before generating the PKCE URL.
  const [showAuthSourceModal, setShowAuthSourceModal] = useState(false)
  const [showPluginManager, setShowPluginManager] = useState(false)

  // Dynamic plugin commands — merged with builtins for autocomplete
  const { data: pluginCmds = [] } = useQuery({
    queryKey: ['pluginCommands'],
    queryFn: listPluginCommands,
    staleTime: 60_000,
    retry: 1,
  })
  // Context health from adapter (e.g., token-optimizer quality score)
  const { data: adapterStatus } = useQuery({
    queryKey: ['adapterStatus'],
    queryFn: getAdapterStatus,
    staleTime: 120_000,
    retry: 1,
  })
  const hasAdapters = (adapterStatus?.adapters?.length ?? 0) > 0
  const { data: contextHealth } = useQuery({
    queryKey: ['projectContextHealth', projectCode],
    queryFn: () => getProjectContextHealth(projectCode),
    enabled: hasAdapters && !['disconnected', 'error'].includes(status),
    refetchInterval: 30_000,
    staleTime: 15_000,
  })

  const SLASH_COMMANDS = useMemo(() => {
    const all = [...BUILTIN_SLASH_COMMANDS]
    for (const cmd of pluginCmds) {
      const name = '/' + cmd.name
      if (!all.some(c => c.name === name)) {
        all.push({ name, description: cmd.description, source: cmd.source })
      }
    }
    return all
  }, [pluginCmds])

  // Inline slash command autocomplete — show when input starts with / and matches commands
  const slashMatches = useMemo(() => {
    const text = inputText.trim()
    if (!text.startsWith('/') || text.includes(' ') || slashDismissedRef.current) return []
    return SLASH_COMMANDS.filter(c => c.name.startsWith(text.toLowerCase()))
  }, [inputText, SLASH_COMMANDS])

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
  const pendingExternalRef = useRef<string[]>([])
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const loginPkceRef = useRef<{ authUrl: string; codeVerifier: string; clientId: string; redirectUri: string; state: string } | null>(null)
  const activityTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const isActiveRef = useRef(false)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const isReplayingRef = useRef(false)
  const [isReplaying, setIsReplaying] = useState(false)
  const [resetKey, setResetKey] = useState(0)

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

  // When toggling fullscreen (compact changes), the DOM re-parents via createPortal.
  // Reset scroll state and scroll to bottom so output continues seamlessly.
  useEffect(() => {
    userScrolledUpRef.current = false
    requestAnimationFrame(() => scrollToBottom(true))
  }, [compact, scrollToBottom])

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

  // WebSocket connection — persists across fullscreen remounts via module-level cache.
  useEffect(() => {
    let aborted = false
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const token = getStoredToken()
    const wsUrl = `${protocol}//${window.location.host}/ws/chat${token ? `?token=${encodeURIComponent(token)}` : ''}`

    // Reattach handlers to an existing WS if it survived a fullscreen remount
    const existingWs = persistentWs.get(projectCode)
    if (existingWs && existingWs.readyState === WebSocket.OPEN) {
      wsRef.current = existingWs
      // Reattach message handler (the old one was from the previous mount)
      existingWs.onmessage = (event) => {
        if (aborted) return
        try { handleEvent(JSON.parse(event.data)) } catch { /* ignore */ }
      }
      existingWs.onclose = () => {
        if (aborted) return
        persistentWs.delete(projectCode)
        setStatus('disconnected')
        onStatusChange?.('disconnected')
        onActivityChange?.(false)
        reconnectTimer.current = setTimeout(connect, 3000)
      }
      existingWs.onerror = () => {
        if (aborted) return
        setStatus('error')
        onStatusChange?.('error')
      }
      // Don't clear messages — they're restored from persistentMessages cache.
      // Mark replay as done since the WS is already connected.
      isReplayingRef.current = false; setIsReplaying(false)
      return () => {
        aborted = true
        // Don't close — just detach. The WS stays in persistentWs for reattach.
      }
    }

    function connect() {
      if (aborted) return
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws
      persistentWs.set(projectCode, ws)

      setStatus('connecting')
      onStatusChange?.('connecting')

      ws.onopen = () => {
        if (aborted) { ws.close(); persistentWs.delete(projectCode); return }
        // Suppress scroll during replay
        isReplayingRef.current = true
        setIsReplaying(true)
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
        persistentWs.delete(projectCode)
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
      // Don't close the WS on unmount — keep it in persistentWs for reattach.
      // It will be cleaned up when it closes naturally or on a new connect().
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectCode, localPath, resetKey])

  const handleEvent = useCallback((data: Record<string, unknown>) => {
    const type = data.type as string

    switch (type) {
      case 'status': {
        const statusData = data.data as { status: string }
        const s = statusData.status
        setStatus(s)
        onStatusChange?.(s)
        // 'resumed' is what the backend sends when the launch took the
        // GetResumable path, the chat_sessions cross-dir fallback, the
        // chat_history archive fallback, or the latest-on-disk fallback —
        // ALL legitimate ways to land in a live session. Without it in
        // this gate, isReplaying stays true forever after replay finishes
        // and the input sits on "Loading chat session..." even though the
        // transcript is fully rendered. Same story if we ever add more
        // resume-flavored statuses — treat any non-{connecting,error,exited,disconnected}
        // terminal status as "replay complete".
        if (s === 'reconnected' || s === 'started' || s === 'restarted' || s === 'resumed') {
          // Replay is done — trigger scroll after React renders
          isReplayingRef.current = false; setIsReplaying(false)
          userScrolledUpRef.current = false
          setIsReconnecting(false)
          setCompactingLabel(null)
          compactingRef.current = false
          setExitError(null)
          setReplayDone(n => n + 1)
          // Flush any externally queued messages (e.g., from feedback prompt dispatch)
          if (pendingExternalRef.current.length > 0) {
            const queued = pendingExternalRef.current.splice(0)
            setTimeout(() => {
              for (const text of queued) {
                setMessages((prev) => [...prev, { role: 'user' as const, text }])
                if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                  wsRef.current.send(JSON.stringify({ type: 'user_message', data: { text } }))
                }
              }
              userScrolledUpRef.current = false
              scrollToBottom(true)
            }, 300)
          }
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
        isReplayingRef.current = false; setIsReplaying(false)
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

        if (eventType === 'message_start') {
          // Capture the model reported by Claude Code so the header can show
          // what's actually running (not just what we asked for). Skip Claude
          // Code's <synthetic> placeholder and subagent runs (isSidechain=true)
          // whose model would displace the primary agent's on the chip.
          const isSidechain = (data as { isSidechain?: boolean }).isSidechain === true
          const msg = event.message as { model?: string } | undefined
          const m = msg?.model
          if (m && !m.startsWith('<') && !isSidechain && m !== currentModel) {
            setCurrentModel(m)
            onModelChange?.(m)
          }
        } else if (eventType === 'content_block_start') {
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
          model?: string
          content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>
        }

        // Assistant messages always carry the model that produced them —
        // more reliable than message_start alone, which some Claude Code
        // versions omit or emit under a nested envelope. Skip:
        //  - Claude Code's <synthetic> marker (locally-generated messages
        //    like tool echoes, subagent aggregation, /compact summaries).
        //  - Subagent (Task tool) responses, marked with isSidechain=true.
        //    Those run Haiku by default and would overwrite the real
        //    primary model (Opus/Sonnet/Fable) with the subagent's model.
        const isSidechain = (data as { isSidechain?: boolean }).isSidechain === true
        if (msg?.model && !msg.model.startsWith('<') && !isSidechain && msg.model !== currentModel) {
          setCurrentModel(msg.model)
          onModelChange?.(msg.model)
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

      case 'session_ended': {
        // User tried to send a message after the Claude process exited.
        // Surface a clean exit panel that explains and offers reset.
        const d = data.data as { message?: string } | undefined
        const msg = d?.message?.replace(/^SESSION_ENDED:\s*/, '') || 'Claude Code session has ended.'
        setExitError({ exitCode: 1, stderr: [msg] })
        setIsStreaming(false)
        setAwaitingResult(false)
        setStatus('claude_error')
        onStatusChange?.('claude_error')
        onActivityChange?.(false)
        break
      }

      case 'session_lost': {
        // Orphan cleared — the session ID pointed at nothing on disk. Reset
        // everything and force a fresh spawn on the next mount.
        if (wsRef.current) { wsRef.current.close(); wsRef.current = null }
        persistentWs.delete(projectCode)
        persistentMessages.delete(projectCode)
        persistentStreamingText.delete(projectCode)
        setMessages([])
        setStreamingText('')
        setExitError(null)
        setIsStreaming(false)
        setAwaitingResult(false)
        setStatus('idle')
        onStatusChange?.('idle')
        onActivityChange?.(false)
        setTimeout(() => setResetKey(k => k + 1), 200)
        break
      }

      case 'session_reaped': {
        // Backend killed the Claude Code subprocess to free memory. The
        // transcript is intact on disk and re-hydrates on next launch.
        //
        // Do NOT auto-remount here. Previously we bumped resetKey which
        // reopened the WS which triggered a new spawn — which under a
        // busy user's cap enforcement immediately caused another reap on
        // some other project card, cascading into a whole-app spawn/reap
        // storm that starved the browser and triggered React's max-
        // update-depth guard. Instead we go into an "idle" state with the
        // transcript still visible; the WS effect will re-fire on the
        // next user interaction that bumps resetKey (Reset Session, /fresh,
        // sending a queued message via reconnect).
        if (wsRef.current) { wsRef.current.close(); wsRef.current = null }
        persistentWs.delete(projectCode)
        setExitError(null)
        setIsStreaming(false)
        setAwaitingResult(false)
        setStatus('reaped')
        onStatusChange?.('reaped')
        onActivityChange?.(false)
        break
      }

      case 'model_unavailable': {
        const d = data.data as { message?: string } | undefined
        setModelUnavailable({ message: d?.message || 'The selected Claude model is unavailable.' })
        setIsStreaming(false)
        setAwaitingResult(false)
        setStatus('claude_error')
        onStatusChange?.('claude_error')
        onActivityChange?.(false)
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
    const connected = ['started', 'connected', 'reconnected', 'restarted', 'resumed'].includes(status)
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
        // Standalone dev: PKCE OAuth flow via WS — no keychain mutation.
        // Ask which authorization server first (Console vs Claude.ai); the
        // browser only opens after the pick.
        setIsReconnecting(false)
        setExitError(null)
        setShowAuthSourceModal(true)
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
    } else if (cmdName === '/plugins') {
      setShowPluginManager(true)
    } else if (cmdName === '/model') {
      // Interactive picker: user typed bare "/model" — surface the same
      // ModelPicker we use for model_unavailable. If they wanted to type a
      // custom string they'd use "/model <name>" (handled in sendMessage).
      setPickerModel(currentModel || '')
      setShowModelPicker(true)
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

  // Listen for external "send to this project" events (from feedback prompt dispatch, Modules tab post-op)
  // Always queue — the flush happens after session startup/replay completes, ensuring the
  // message appears in the right place and doesn't get cleared by replay.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { projectCode: string; text: string }
      if (detail.projectCode !== projectId) return
      // If session is fully ready (not replaying), send immediately
      if (!isReplayingRef.current && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        setMessages((prev) => [...prev, { role: 'user', text: detail.text }])
        wsRef.current.send(JSON.stringify({ type: 'user_message', data: { text: detail.text } }))
        userScrolledUpRef.current = false
        requestAnimationFrame(() => scrollToBottom(true))
      } else {
        // Queue for after replay completes
        pendingExternalRef.current.push(detail.text)
      }
    }
    window.addEventListener('vibectl:send-to-project', handler)
    return () => window.removeEventListener('vibectl:send-to-project', handler)
  }, [projectId, scrollToBottom])

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

  // Tracks AskUserQuestion tool_use_ids that have already been answered, so
  // the inline form doesn't re-render after the user submits.
  const [answeredQuestions, setAnsweredQuestions] = useState<Record<string, Record<string, string | string[]>>>({})

  const handleQuestionAnswer = useCallback((toolUseId: string, answers: Record<string, string | string[]>) => {
    if (!toolUseId) return
    // Serialize answers as a JSON string in the tool_result content —
    // Claude Code accepts either a string or an array of blocks; a JSON
    // string is the safest cross-version choice.
    const payload = JSON.stringify({ answers })
    sendWsMessage('tool_result_response', { toolUseId, content: payload })
    setAnsweredQuestions((prev) => ({ ...prev, [toolUseId]: answers }))
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

  const isConnected = ['connecting', 'started', 'connected', 'reconnected', 'restarted', 'resumed'].includes(status)

  const statusColor = useMemo(() => {
    if (['started', 'connected', 'reconnected', 'restarted', 'resumed'].includes(status)) return 'text-green-400'
    if (['connecting'].includes(status)) return 'text-yellow-400'
    if (['error'].includes(status)) return 'text-red-400'
    return 'text-gray-500'
  }, [status])

  // Roll up TaskCreate/TaskUpdate calls into a per-message snapshot of the
  // task tracker. Each Task* call is a discrete event (not a full snapshot
  // like TodoWrite), so we accumulate state across ALL prior assistant
  // messages and store the state AT each message index. MessageRenderer
  // then draws one TaskListCard per message that touched tasks — showing
  // pending/in-progress/completed check-off in place instead of a wall of
  // repeated single-event chips.
  //
  // Claude Code hands out task IDs sequentially from the ORDER of
  // TaskCreate calls (the input doesn't carry the id — the tool_result
  // does — so we mirror the same "next integer" scheme here). Any
  // TaskUpdate whose id we haven't seen still surfaces so nothing is
  // silently dropped.
  const taskStatesByIdx = useMemo(() => {
    const states: TaskSnapshot[] = []
    const cur = new Map<string, TaskItem>()
    let nextId = 1
    for (const msg of messages) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block || block.type !== 'tool_use') continue
          const name = block.name
          const input = (block.input || {}) as Record<string, unknown>
          if (name === 'TaskCreate') {
            const id = String(nextId++)
            const subject = typeof input.subject === 'string' ? input.subject : ''
            const assignee = typeof input.assignee === 'string' ? input.assignee : undefined
            cur.set(id, { taskId: id, subject, assignee, status: 'pending', order: nextId - 1 })
          } else if (name === 'TaskUpdate') {
            const id = String(input.taskId ?? '')
            const status = typeof input.status === 'string' ? input.status : ''
            const existing = cur.get(id)
            if (existing) {
              existing.status = status
            }
            // Silently drop TaskUpdate calls that reference a taskId we've
            // never seen a TaskCreate for. In practice this is the
            // assistant emitting a bad taskId (seen 2026-07-12 on Stapledon:
            // 12 creates but an update against taskId=13). Rendering a
            // "(unknown task)" row was more confusing than useful — the
            // real task list still reflects everything that was actually
            // created.
          }
          // TaskOutput / TaskGet don't mutate tracker state, but their
          // presence in a message still triggers rendering the roll-up
          // so the user sees the current list even if the message only
          // read a task.
        }
      }
      // Snapshot AFTER processing this message, plus a flag for whether
      // this message touched tasks at all (renderer uses the flag to
      // decide whether to draw the card).
      const touched =
        msg.role === 'assistant' &&
        Array.isArray(msg.content) &&
        msg.content.some(b => b && b.type === 'tool_use' && (b.name === 'TaskCreate' || b.name === 'TaskUpdate' || b.name === 'TaskOutput' || b.name === 'TaskGet'))
      states.push({ tasks: touched ? Array.from(cur.values()) : null })
    }
    return states
  }, [messages])

  return (
    <div className="flex flex-col h-full bg-gray-900">
      {/* Status bar */}
      <div className="flex items-center justify-between px-3 py-1 border-b border-gray-700/50 shrink-0 bg-gray-900/80">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${statusColor.replace('text-', 'bg-')}`} />
          <span className="text-[10px] text-gray-500 font-mono">{status}</span>
          <button
            onClick={() => { setPickerModel(currentModel || ''); setShowModelPicker(true) }}
            title={currentModel
              ? `Active model: ${currentModel} — click to switch`
              : 'No project model override — click to set one'}
            className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-mono border transition-colors max-w-[160px] truncate ${
              currentModel
                ? 'bg-gray-800 text-gray-300 border-gray-700 hover:text-white hover:border-gray-500'
                : 'bg-gray-800/50 text-gray-500 border-gray-800 hover:text-gray-300 hover:border-gray-600 italic'
            }`}
          >
            {currentModel ? currentModel.replace(/^claude-/, '') : 'set model'}
          </button>
          {costUsd !== null && (
            <span className="text-[10px] font-mono text-gray-600">
              ${costUsd.toFixed(2)}
            </span>
          )}
          {contextHealth && contextHealth.grade && contextHealth.score > 0 && (
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                contextHealth.score >= 75 ? 'bg-green-900/40 text-green-400' :
                contextHealth.score >= 50 ? 'bg-amber-900/40 text-amber-400' :
                'bg-red-900/40 text-red-400'
              }`}
              title={`Context quality: ${contextHealth.grade} (${contextHealth.score}/100)${contextHealth.compactions > 0 ? ` | ${contextHealth.compactions} compactions` : ''}${contextHealth.compactionLossPct ? ` | ${contextHealth.compactionLossPct.toFixed(0)}% context lost` : ''}`}
            >
              {contextHealth.grade} {contextHealth.score}
            </span>
          )}
          {(status === 'disconnected' || status === 'error' || status === 'exited' || status === 'claude_error' || status === 'reaped') && (
            <button
              onClick={() => {
                // Clear persistent caches and force a fresh WS connection
                persistentWs.delete(projectCode)
                persistentMessages.delete(projectCode)
                persistentStreamingText.delete(projectCode)
                if (wsRef.current) {
                  wsRef.current.close()
                  wsRef.current = null
                }
                setMessages([])
                setStreamingText('')
                setExitError(null)
                setResetKey(k => k + 1)
              }}
              className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-red-900/40 border border-red-700/40 text-red-300 hover:bg-red-900/60 transition-colors"
            >
              Reset Session
            </button>
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
          <div className="flex flex-col items-center justify-center h-full gap-2">
            {isReplaying ? (
              <>
                <div className="flex gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-2 h-2 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-2 h-2 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
                <span className="text-gray-500 text-sm">Loading chat session...</span>
              </>
            ) : (
              <span className="text-gray-600 text-sm">
                {isConnected ? 'Send a message to start' : status === 'exited' ? 'Session ended' : 'Connecting...'}
              </span>
            )}
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
                state: pkce.state,
                projectCode: projectCode,
                localPath: localPath,
              })
            }} />
          }
          return <MessageRenderer key={i} message={msg} compact={compact} onControlResponse={handleControlResponse} onPlanResponse={handlePlanResponse} onQuestionAnswer={handleQuestionAnswer} answeredQuestions={answeredQuestions} taskState={taskStatesByIdx[i]} />
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

        {/* Interactive /model picker — shown when the user runs bare "/model" */}
        {showModelPicker && !modelUnavailable && (
          <div className="rounded-lg bg-indigo-950/60 border border-indigo-800/60 p-3 space-y-2 shrink-0">
            <div className="flex items-start justify-between gap-2">
              <span className="text-xs font-medium text-indigo-300">Switch model{currentModel ? ` (now: ${currentModel})` : ''}</span>
              <button onClick={() => { setShowModelPicker(false); setPickerModel('') }} className="text-gray-600 hover:text-gray-400 text-[10px] shrink-0">cancel</button>
            </div>
            <p className="text-[11px] text-indigo-200/80 leading-relaxed">
              Picks a project-level override. Applied live to the current session — no restart, no context loss. Same protocol Claude Code's <code className="font-mono text-indigo-100">/model</code> uses.
            </p>
            <div className="flex items-center gap-2">
              <ModelPicker value={pickerModel} onChange={setPickerModel} placeholder="Pick a model" />
              <button
                disabled={!pickerModel}
                onClick={async () => {
                  const chosen = pickerModel
                  try {
                    await updateProject(projectId, { model: chosen } as Partial<Project>)
                    // Refresh the projects list cache so the fresh model
                    // reaches ProjectCard's `project` prop. Without this the
                    // configuredModel prop keeps ferrying the old value on
                    // every re-render and any consumer that syncs from it
                    // (or its downstream state) can revert to fable-5.
                    queryClient.invalidateQueries({ queryKey: ['projects'] })
                    queryClient.invalidateQueries({ queryKey: ['project', projectId] })
                  } catch (e) {
                    console.error('failed to save model override', e)
                  }
                  // Flip the chip immediately — the project query cache
                  // is stale until React Query refetches, and the next
                  // assistant event is many seconds away.
                  setCurrentModel(chosen)
                  onModelChange?.(chosen)
                  // Live swap via stream-json set_model control_request.
                  // Backend routes through ChatSession.SendSetModel; the
                  // running claude process continues on the new model
                  // without a spawn/kill. If no session is live, the
                  // updateProject above ensures the next launch picks up
                  // the override — no explicit restart needed either way.
                  sendWsMessage('set_model', { model: chosen })
                  setShowModelPicker(false)
                  setPickerModel('')
                }}
                className="px-2 py-1 text-[10px] font-medium rounded bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white hover:bg-indigo-600"
              >
                Apply
              </button>
            </div>
          </div>
        )}

        {/* Model unavailable picker — shown when claude rejects the selected model */}
        {modelUnavailable && (
          <div className="rounded-lg bg-amber-950/60 border border-amber-800/60 p-3 space-y-2 shrink-0">
            <div className="flex items-start justify-between gap-2">
              <span className="text-xs font-medium text-amber-400">Selected model is unavailable</span>
              <button onClick={() => setModelUnavailable(null)} className="text-gray-600 hover:text-gray-400 text-[10px] shrink-0">dismiss</button>
            </div>
            <p className="text-[11px] text-amber-300 leading-relaxed">{modelUnavailable.message}</p>
            <div className="flex items-center gap-2">
              <ModelPicker value={pickerModel} onChange={setPickerModel} placeholder="Pick a model" />
              <button
                disabled={!pickerModel}
                onClick={async () => {
                  const chosen = pickerModel
                  try {
                    await updateProject(projectId, { model: chosen } as Partial<Project>)
                    // Refresh the projects list cache so the fresh model
                    // reaches ProjectCard's `project` prop. Without this the
                    // configuredModel prop keeps ferrying the old value on
                    // every re-render and any consumer that syncs from it
                    // (or its downstream state) can revert to fable-5.
                    queryClient.invalidateQueries({ queryKey: ['projects'] })
                    queryClient.invalidateQueries({ queryKey: ['project', projectId] })
                  } catch (e) {
                    console.error('failed to save model override', e)
                  }
                  // Flip the chip immediately (see notes on the /model picker).
                  setCurrentModel(chosen)
                  onModelChange?.(chosen)
                  // Kill the underlying claude process so the next launch spawns fresh
                  // with the new model. Without this, the chat handler "reconnects to
                  // existing chat session" and never re-reads the model.
                  if (wsRef.current?.readyState === WebSocket.OPEN) {
                    wsRef.current.send(JSON.stringify({ type: 'kill' }))
                  }
                  setModelUnavailable(null)
                  setExitError(null)
                  setPickerModel('')
                  persistentWs.delete(projectCode)
                  persistentMessages.delete(projectCode)
                  persistentStreamingText.delete(projectCode)
                  // Give the kill message time to flush before closing the socket.
                  setTimeout(() => {
                    if (wsRef.current) { wsRef.current.close(); wsRef.current = null }
                    setMessages([])
                    setStreamingText('')
                    setResetKey(k => k + 1)
                  }, 200)
                }}
                className="px-2 py-1 text-[10px] font-medium rounded bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white hover:bg-indigo-600"
              >
                Save & restart
              </button>
            </div>
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
                <div className="flex items-start gap-2">
                  <p className="text-[10px] text-gray-500 flex-1">
                    The Claude Code process has stopped. Reset the session to start a fresh one.
                  </p>
                  <button
                    onClick={() => {
                      persistentWs.delete(projectCode)
                      persistentMessages.delete(projectCode)
                      persistentStreamingText.delete(projectCode)
                      if (wsRef.current) { wsRef.current.close(); wsRef.current = null }
                      setMessages([])
                      setStreamingText('')
                      setExitError(null)
                      setIsStreaming(false)
                      setAwaitingResult(false)
                      setResetKey(k => k + 1)
                    }}
                    className="shrink-0 rounded bg-red-800 hover:bg-red-700 px-2.5 py-1 text-xs font-medium text-white transition-colors"
                  >
                    Reset Session
                  </button>
                </div>
              )}
            </div>
          )
        })()}
        {showPluginManager && (
          <PluginManagerModal
            onClose={() => setShowPluginManager(false)}
            onRestart={() => {
              setCompactingLabel('Reloading after plugin changes...')
              compactingRef.current = true
              sendWsMessage('restart', { skipPermissions: permissionMode === 'accept-all' })
            }}
          />
        )}

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

        {showAuthSourceModal && (
          <AuthSourcePickerModal
            onPick={(authSource) => {
              setShowAuthSourceModal(false)
              sendWsMessage('login_start', { projectCode: projectCode, localPath: localPath, authSource })
            }}
            onClose={() => setShowAuthSourceModal(false)}
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
                  {cmd.source && <span className="text-[9px] text-gray-600 shrink-0">[{cmd.source}]</span>}
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
            disabled={isReplaying}
            placeholder={isReplaying ? 'Loading chat session...' : isConnected ? 'Message Claude... (type / for commands)' : 'Connecting... (messages will be queued)'}
            rows={compact ? 1 : 2}
            className={`flex-1 resize-none rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:border-indigo-500 focus:outline-none ${isReplaying ? 'opacity-50 cursor-not-allowed' : ''}`}
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

const BUILTIN_SLASH_COMMANDS: { name: string; description: string; source?: string }[] = [
  { name: '/compact', description: 'Free context window (resume with compacted context)' },
  { name: '/fresh', description: 'Start a fresh session (clears all context)' },
  { name: '/reload', description: 'Reload MCPs and resume session with context' },
  { name: '/mcp', description: 'List configured MCP servers' },
  { name: '/usage', description: 'Show Claude subscription usage and limits' },
  { name: '/login', description: 'Log in or switch Claude Code account' },
  { name: '/permissions auto', description: 'Accept all tool calls automatically' },
  { name: '/permissions approve', description: 'Require approval for tool calls' },
  { name: '/plugins', description: 'Manage Claude Code plugins' },
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

const MessageRenderer = memo(function MessageRenderer({ message, compact, onControlResponse, onPlanResponse, onQuestionAnswer, answeredQuestions, taskState }: {
  message: ChatMessage; compact?: boolean
  onControlResponse?: (requestId: string, behavior: 'allow' | 'deny', message?: string) => void
  onPlanResponse?: (requestId: string, accept: boolean, feedback?: string) => void
  onQuestionAnswer?: (toolUseId: string, answers: Record<string, string | string[]>) => void
  answeredQuestions?: Record<string, Record<string, string | string[]>>
  taskState?: TaskSnapshot
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

  // Assistant message. When the message touches the Task tracker
  // (TaskCreate/TaskUpdate/TaskOutput/TaskGet), collapse every Task* block
  // into ONE TaskListCard placed where the FIRST Task* block appears, and
  // suppress the individual Task* renders. Non-Task blocks stay in place
  // and render normally. Result: instead of "TaskCreate ➕", "TaskCreate ➕",
  // "TaskUpdate ◐", "TaskUpdate ●", ... the log shows a single checklist
  // that reflects the tracker's current state at this point in the
  // conversation, with pending / current / done clearly checked off.
  const touchesTasks = !!taskState?.tasks && taskState.tasks.length > 0
  let taskCardEmitted = false
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
          const isTaskBlock =
            block.name === 'TaskCreate' ||
            block.name === 'TaskUpdate' ||
            block.name === 'TaskOutput' ||
            block.name === 'TaskGet'
          if (isTaskBlock && touchesTasks) {
            if (taskCardEmitted) return null
            taskCardEmitted = true
            return <TaskListCard key={i} tasks={taskState!.tasks!} compact={compact} />
          }
          return <ToolCallCard key={i} block={block} compact={compact} onQuestionAnswer={onQuestionAnswer} answeredQuestions={answeredQuestions} />
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

// Assistant-driven question tool. Renders each question with its options as
// radios (or checkboxes when multiSelect), plus a free-text "Other" fallback
// and a preview column when an option carries one. On submit, sends the
// answers map back to Claude Code as a tool_result via the WebSocket.
interface AskQuestion {
  question: string
  header?: string
  multiSelect?: boolean
  options: Array<{ label: string; description?: string; preview?: string }>
}
// TodoListCard renders TodoWrite tool calls as a compact VSCode-style
// checklist. Each TodoWrite call is a FULL snapshot (Claude passes the
// entire list every time), so each rendered card is a self-contained view
// of tracker state at that point in the conversation. Status → icon:
//   pending      →  ○  gray
//   in_progress  →  ◐  indigo, in a soft-pulse background
//   completed    →  ●  emerald (with strike-through)
// The label prefers activeForm when the item is in_progress ("Fixing X")
// and falls back to content otherwise ("Fix X").
function TodoListCard({ block, compact }: { block: ToolUseBlock; compact?: boolean }) {
  type Todo = { content?: string; status?: string; activeForm?: string }
  // The `todos` field CAN be missing, a stringified array, or an object with
  // wrong shape depending on historical Claude Code versions in the replayed
  // transcript. Guard with Array.isArray — an unwrapped `|| []` does NOT
  // catch objects (they're truthy) and the ".filter is not a function"
  // TypeError takes the whole ChatView down when the transcript replays.
  const rawRaw = (block.input as { todos?: unknown }).todos
  let raw: Todo[] = []
  if (Array.isArray(rawRaw)) {
    raw = rawRaw as Todo[]
  } else if (typeof rawRaw === 'string') {
    try {
      const parsed = JSON.parse(rawRaw)
      if (Array.isArray(parsed)) raw = parsed as Todo[]
    } catch { /* leave empty */ }
  }
  const todos = raw.filter(t => t && (t.content || t.activeForm))
  if (todos.length === 0) return null

  const done = todos.filter(t => t.status === 'completed').length
  const inProgress = todos.filter(t => t.status === 'in_progress').length
  const total = todos.length

  const textSize = compact ? 'text-[11px]' : 'text-xs'

  return (
    <div className="rounded-lg border border-gray-700/60 bg-gray-800/40 overflow-hidden">
      <div className={`flex items-center gap-2 px-3 py-1.5 border-b border-gray-700/40 ${textSize}`}>
        <span className="text-cyan-400/90">📋</span>
        <span className="text-cyan-300 font-medium uppercase tracking-wider text-[10px]">Tasks</span>
        <span className="text-gray-500">
          {done}/{total} done{inProgress > 0 ? ` · ${inProgress} in progress` : ''}
        </span>
      </div>
      <ul className="px-3 py-1.5 space-y-0.5">
        {todos.map((t, i) => {
          const status = t.status || 'pending'
          const isDone = status === 'completed'
          const isDoing = status === 'in_progress'
          const label = isDoing ? (t.activeForm || t.content || '') : (t.content || t.activeForm || '')
          const icon = isDone ? '●' : isDoing ? '◐' : '○'
          const iconColor = isDone ? 'text-emerald-400' : isDoing ? 'text-indigo-300' : 'text-gray-500'
          const textColor = isDone ? 'text-gray-500 line-through' : isDoing ? 'text-indigo-100 font-medium' : 'text-gray-300'
          return (
            <li key={i} className={`flex items-start gap-2 ${textSize} py-0.5 px-1 rounded ${isDoing ? 'bg-indigo-950/25' : ''}`}>
              <span className={`${iconColor} shrink-0 leading-5 select-none`} aria-hidden>{icon}</span>
              <span className={`${textColor} leading-5 flex-1 whitespace-pre-wrap`}>{label}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// TaskListCard is the rolled-up view of Claude Code's background-agent
// task tracker. Individual TaskCreate/TaskUpdate/TaskOutput/TaskGet
// events are absorbed by the MessageRenderer into one card per message
// that touches the tracker, showing the tracker's CURRENT state at that
// point in the conversation. Empty box = pending, filled arrow = current,
// check = completed, ✕ = failed/cancelled.
function TaskListCard({ tasks, compact }: { tasks: TaskItem[]; compact?: boolean }) {
  if (!tasks.length) return null
  const textSize = compact ? 'text-[11px]' : 'text-xs'
  const done = tasks.filter(t => t.status === 'completed').length
  const doing = tasks.filter(t => t.status === 'in_progress' || t.status === 'running').length
  const failed = tasks.filter(t => t.status === 'failed' || t.status === 'cancelled').length

  return (
    <div className="rounded-lg border border-indigo-800/40 bg-indigo-950/20 overflow-hidden">
      <div className={`flex items-center gap-2 px-3 py-1.5 border-b border-indigo-800/30 ${textSize}`}>
        <span className="text-indigo-300/90" aria-hidden>🎯</span>
        <span className="text-indigo-300 font-medium uppercase tracking-wider text-[10px]">Tasks</span>
        <span className="text-gray-500">
          {done}/{tasks.length} done
          {doing > 0 ? ` · ${doing} in progress` : ''}
          {failed > 0 ? ` · ${failed} failed` : ''}
        </span>
      </div>
      <ul className="px-3 py-1.5 space-y-0.5">
        {tasks.map(t => {
          const status = t.status || 'pending'
          const isDone = status === 'completed'
          const isDoing = status === 'in_progress' || status === 'running'
          const isBad = status === 'failed' || status === 'cancelled'
          const icon = isDone ? '☑' : isDoing ? '▶' : isBad ? '☒' : '☐'
          const iconColor = isDone ? 'text-emerald-400' : isDoing ? 'text-indigo-300' : isBad ? 'text-rose-400' : 'text-gray-500'
          const textColor = isDone
            ? 'text-gray-500 line-through'
            : isDoing
              ? 'text-indigo-100 font-medium'
              : isBad
                ? 'text-rose-300 line-through'
                : 'text-gray-300'
          const rowBg = isDoing ? 'bg-indigo-950/30' : ''
          return (
            <li key={t.taskId} className={`flex items-start gap-2 ${textSize} py-0.5 px-1 rounded ${rowBg}`}>
              <span className={`${iconColor} shrink-0 leading-5 select-none w-4 text-center`} aria-hidden>{icon}</span>
              <span className="text-gray-600 shrink-0 leading-5 text-[10px] mt-[3px] font-mono">#{t.taskId}</span>
              <span className={`${textColor} leading-5 flex-1 whitespace-pre-wrap`}>{t.subject || '(no subject)'}</span>
              {t.assignee && !isDone && (
                <span className="text-[10px] text-indigo-300/60 shrink-0 mt-[3px] uppercase tracking-wide">{t.assignee}</span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function AskUserQuestionCard({ block, compact, onSubmit, answered }: {
  block: ToolUseBlock
  compact?: boolean
  onSubmit?: (toolUseId: string, answers: Record<string, string | string[]>) => void
  answered?: Record<string, string | string[]>
}) {
  const questions = ((block.input.questions as AskQuestion[] | undefined) || []).filter(q => q && q.question && Array.isArray(q.options))
  const [selections, setSelections] = useState<Record<string, Set<string>>>(() => {
    const init: Record<string, Set<string>> = {}
    for (const q of questions) init[q.question] = new Set<string>()
    return init
  })
  const [others, setOthers] = useState<Record<string, string>>({})

  if (questions.length === 0) return null

  const isAnswered = !!answered

  if (isAnswered) {
    return (
      <div className="rounded-lg border border-emerald-800/50 bg-emerald-900/10 p-3">
        <div className="flex items-center gap-1.5 mb-2">
          <span className="text-[10px] font-semibold text-emerald-400 uppercase tracking-wider">Answered</span>
          <div className="flex-1 h-px bg-emerald-800/30" />
        </div>
        {questions.map((q, i) => {
          const a = answered?.[q.question]
          const shown = Array.isArray(a) ? a.join(', ') : (a ?? '')
          return (
            <div key={i} className={`${compact ? 'text-[11px]' : 'text-xs'} mb-1`}>
              <span className="text-gray-500">{q.header || q.question}: </span>
              <span className="text-emerald-300 font-medium">{shown}</span>
            </div>
          )
        })}
      </div>
    )
  }

  const toggle = (question: string, label: string, multi: boolean) => {
    setSelections(prev => {
      const cur = new Set(prev[question] || [])
      if (multi) {
        if (cur.has(label)) cur.delete(label); else cur.add(label)
      } else {
        cur.clear(); cur.add(label)
      }
      return { ...prev, [question]: cur }
    })
  }

  const submit = () => {
    if (!onSubmit) return
    const answers: Record<string, string | string[]> = {}
    for (const q of questions) {
      const picked = Array.from(selections[q.question] || [])
      // Merge "Other" free-text if provided.
      const other = (others[q.question] || '').trim()
      const final = other ? [...picked, other] : picked
      if (q.multiSelect) {
        answers[q.question] = final
      } else {
        answers[q.question] = final[0] || ''
      }
    }
    onSubmit(block.id, answers)
  }

  const allAnsweredable = questions.every(q => {
    const picks = selections[q.question]
    const other = (others[q.question] || '').trim()
    return (picks && picks.size > 0) || other.length > 0
  })

  return (
    <div className="rounded-lg border border-indigo-700/50 bg-indigo-950/40 p-3 space-y-3">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-semibold text-indigo-300 uppercase tracking-wider">Question{questions.length > 1 ? 's' : ''}</span>
        <div className="flex-1 h-px bg-indigo-800/40" />
      </div>
      {questions.map((q, qi) => {
        const multi = !!q.multiSelect
        return (
          <div key={qi} className="space-y-2">
            {q.header && <div className="text-[10px] font-semibold text-indigo-400 uppercase tracking-wide">{q.header}</div>}
            <div className={`${compact ? 'text-xs' : 'text-sm'} text-gray-200`}>{q.question}</div>
            <div className="space-y-1.5">
              {q.options.map((opt, oi) => {
                const checked = (selections[q.question] || new Set<string>()).has(opt.label)
                return (
                  <label key={oi} className={`flex items-start gap-2 rounded px-2 py-1.5 cursor-pointer transition-colors ${checked ? 'bg-indigo-800/40 border border-indigo-600/50' : 'hover:bg-gray-800/60 border border-transparent'}`}>
                    <input
                      type={multi ? 'checkbox' : 'radio'}
                      name={`q-${block.id}-${qi}`}
                      checked={checked}
                      onChange={() => toggle(q.question, opt.label, multi)}
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-gray-200 text-[12px] font-medium">{opt.label}</div>
                      {opt.description && <div className="text-gray-500 text-[11px] leading-snug">{opt.description}</div>}
                      {opt.preview && (
                        <pre className="mt-1 text-[10px] font-mono text-indigo-200/80 bg-black/40 rounded p-1.5 overflow-x-auto whitespace-pre">{opt.preview}</pre>
                      )}
                    </div>
                  </label>
                )
              })}
              <input
                type="text"
                value={others[q.question] || ''}
                onChange={(e) => setOthers(prev => ({ ...prev, [q.question]: e.target.value }))}
                placeholder="Other (free-text)…"
                className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>
        )
      })}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={submit}
          disabled={!allAnsweredable}
          className="rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium px-3 py-1.5 transition-colors"
        >
          Send answer{questions.length > 1 ? 's' : ''}
        </button>
      </div>
    </div>
  )
}

const ToolCallCard = memo(function ToolCallCard({ block, compact, onQuestionAnswer, answeredQuestions }: {
  block: ToolUseBlock
  compact?: boolean
  onQuestionAnswer?: (toolUseId: string, answers: Record<string, string | string[]>) => void
  answeredQuestions?: Record<string, Record<string, string | string[]>>
}) {
  const [open, setOpen] = useState(false)
  const [showDiff, setShowDiff] = useState(false)

  // Plan mode tools get a special renderer
  if (PLAN_TOOL_NAMES.has(block.name)) {
    return <PlanToolCard block={block} compact={compact} />
  }

  // AskUserQuestion → interactive form the user can answer inline.
  if (block.name === 'AskUserQuestion') {
    return (
      <AskUserQuestionCard
        block={block}
        compact={compact}
        onSubmit={onQuestionAnswer}
        answered={answeredQuestions?.[block.id]}
      />
    )
  }

  // TodoWrite → VSCode-style checklist. Every call is a full snapshot of the
  // todo list, so each rendering is a self-contained view of the tracker at
  // that point in the conversation.
  if (block.name === 'TodoWrite') {
    return <TodoListCard block={block} compact={compact} />
  }

  // Task* blocks (TaskCreate / TaskUpdate / TaskOutput / TaskGet) are
  // absorbed by MessageRenderer into one TaskListCard per message that
  // touches the tracker — see the isTaskBlock branch there. Falling
  // through to the generic tool row here shouldn't happen in practice,
  // but stays as a safety net so an unrouted Task* block still renders
  // instead of vanishing.

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

// AuthSourcePickerModal — mirrors the Claude Code CLI's login picker.
// Anthropic runs two separate authorization servers (Console for Team/Org,
// Claude.ai for personal Max/Pro), and a user with both on the same email
// only sees one of them on any given authorize page. We ask upfront which
// one to route to.
function AuthSourcePickerModal({ onPick, onClose }: { onPick: (source: 'claude_ai' | 'console') => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-5 max-w-md w-full mx-4 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div>
          <h3 className="text-base font-semibold text-white mb-1">Choose Claude account type</h3>
          <p className="text-sm text-gray-400">
            Anthropic runs two separate authorization servers. A single email address can be attached to one on each side, so pick which one to sign in to.
          </p>
        </div>
        <div className="space-y-2">
          <button
            onClick={() => onPick('claude_ai')}
            className="w-full text-left px-4 py-3 rounded-md bg-gray-800 hover:bg-gray-750 border border-gray-700 hover:border-indigo-500 transition-colors"
          >
            <div className="font-medium text-white">Claude.ai account</div>
            <div className="text-xs text-gray-400 mt-0.5">Personal Max or Pro subscription (claude.ai)</div>
          </button>
          <button
            onClick={() => onPick('console')}
            className="w-full text-left px-4 py-3 rounded-md bg-gray-800 hover:bg-gray-750 border border-gray-700 hover:border-indigo-500 transition-colors"
          >
            <div className="font-medium text-white">Anthropic Console account</div>
            <div className="text-xs text-gray-400 mt-0.5">Team, Org, or API-backed access (platform.claude.com)</div>
          </button>
        </div>
        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="text-sm text-gray-400 hover:text-gray-200 px-3 py-1"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
