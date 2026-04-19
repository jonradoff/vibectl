import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listIssues, updateProject, createIssue, archiveProject, runHealthCheck, getHealthHistory, listChatHistory, getChatHistoryEntry, listActivityLog, getSelfInfo, triggerRebuild, getCloneSSEUrl, getPullSSEUrl, removeClone, getSettings, detectFlyToml, detectStartSh, listUnits, addUnit, detachUnit, attachUnit, getProject, listProjects, listAllTags, listIntents, patchIntent, exportProjectToRemote, getDelegationStatus, getViewMode, checkDir } from '../../api/client'
import type { Intent } from '../../types'
import type { Project, ProjectSummary, Issue, IssueType, Priority, HealthCheckConfig, DeploymentConfig, HealthCheckResult, HealthRecord, ChatHistorySummary, ActivityLogEntry } from '../../types'
import { priorityColors, typeColors } from '../../types'
import ChatView from '../chat/ChatView'
import UserShellView from '../terminal/UserShellView'
import type { ChatSessionSnapshot } from '../chat/ChatView'
import { useActiveProject } from '../../contexts/ActiveProjectContext'
import { useMode } from '../../contexts/ModeContext'
import { useAuth } from '../../contexts/AuthContext'
import FilesBrowser from './FilesBrowser'
import MembersPanel from './MembersPanel'
import CITab from './CITab'
import FeedbackTab from './FeedbackTab'
import ServerModeClaudeTab from './ServerModeClaudeTab'

interface ProjectCardProps {
  summary: ProjectSummary
  embedded?: boolean // true when rendered inside MultiModuleCard (no own header chrome)
}

type CardTab = 'terminal' | 'shell' | 'issues' | 'files' | 'history' | 'health' | 'log' | 'settings' | 'members' | 'ci' | 'feedback' | 'modules' | 'intents'

export default function ProjectCard({ summary, embedded }: ProjectCardProps) {
  const { project, openIssueCount } = summary
  const [activeTab, setActiveTabRaw] = useState<CardTab>(() => {
    try {
      const saved = localStorage.getItem(`vibectl-card-tab-${project.id}`)
      if (saved && ['terminal','shell','issues','files','history','health','log','settings','members','ci','feedback','modules','intents'].includes(saved)) {
        return saved as CardTab
      }
    } catch { /* ignore */ }
    return 'terminal'
  })
  const setActiveTab = (tab: CardTab) => {
    setActiveTabRaw(tab)
    try { localStorage.setItem(`vibectl-card-tab-${project.id}`, tab) } catch { /* ignore */ }
  }
  const [terminalStatus, setTerminalStatus] = useState<string>('disconnected')
  const [isActive, setIsActive] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [currentSession, setCurrentSession] = useState<ChatSessionSnapshot | null>(null)
  const [isWaiting, setIsWaiting] = useState(false)
  const { activeProjectId, setActiveProjectId, updateProjectStatus, closeProject } = useActiveProject()
  const isActiveProject = activeProjectId === project.id
  const queryClient = useQueryClient()
  const { currentUser } = useAuth()

  const isUnit = !!project.parentId
  const isMultiModule = project.projectType === 'multi'

  // Fetch parent project name for unit cards
  const { data: parentProject } = useQuery({
    queryKey: ['project', project.parentId],
    queryFn: () => getProject(project.parentId!),
    enabled: isUnit,
    staleTime: 300_000,
  })

  const handleSessionSnapshot = useCallback((snapshot: ChatSessionSnapshot) => {
    setCurrentSession(snapshot)
  }, [])

  const handleWaitingChange = useCallback((waiting: boolean) => {
    setIsWaiting(waiting)
  }, [])

  const handleStatusChange = useCallback((status: string) => {
    setTerminalStatus(status)
  }, [])

  const handleActivityChange = useCallback((active: boolean) => {
    setIsActive(active)
  }, [])

  // Escape key exits fullscreen
  useEffect(() => {
    if (!isFullscreen) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen(false)
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [isFullscreen])

  const monitorEnv = project.healthCheck?.monitorEnv
  const { data: healthResults } = useQuery({
    queryKey: ['healthcheck', project.id],
    queryFn: () => runHealthCheck(project.id),
    enabled: !!monitorEnv,
    refetchInterval: 30_000,
  })

  // Detect if this project IS VibeCtl itself (self-project)
  const { data: selfInfo } = useQuery({
    queryKey: ['selfInfo'],
    queryFn: getSelfInfo,
    staleTime: Infinity,
  })
  const isSelfProject = !!(selfInfo?.sourceDir && project.links.localPath && selfInfo.sourceDir === project.links.localPath)

  // Clone/pull state
  const [cloneLog, setCloneLog] = useState<string[]>([])
  const [cloneStreaming, setCloneStreaming] = useState(false)
  const cloneLogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (cloneLogRef.current) cloneLogRef.current.scrollTop = cloneLogRef.current.scrollHeight
  }, [cloneLog])

  const startSSE = useCallback((url: string) => {
    setCloneLog([])
    setCloneStreaming(true)
    const es = new EventSource(url)
    es.onmessage = (e) => {
      const line = e.data as string
      if (line === 'DONE') {
        es.close()
        setCloneStreaming(false)
        queryClient.invalidateQueries({ queryKey: ['globalDashboard'] })
      } else if (line.startsWith('ERROR: ')) {
        setCloneLog(prev => [...prev, line])
        es.close()
        setCloneStreaming(false)
        queryClient.invalidateQueries({ queryKey: ['globalDashboard'] })
      } else {
        setCloneLog(prev => [...prev, line])
      }
    }
    es.onerror = () => {
      es.close()
      setCloneStreaming(false)
      setCloneLog(prev => prev.length === 0 ? ['ERROR: Connection failed — check server logs or try re-logging in'] : prev)
    }
  }, [queryClient])

  const handleClone = useCallback(() => startSSE(getCloneSSEUrl(project.id)), [project.id, startSSE])
  const handlePull = useCallback(() => startSSE(getPullSSEUrl(project.id)), [project.id, startSSE])
  const handleRemoveClone = useCallback(async () => {
    await removeClone(project.id)
    queryClient.invalidateQueries({ queryKey: ['globalDashboard'] })
  }, [project.id, queryClient])

  const [rebuilding, setRebuilding] = useState(false)
  const [showHealthDetail, setShowHealthDetail] = useState(false)
  const handleRebuild = useCallback(async () => {
    setRebuilding(true)
    try {
      await triggerRebuild()
    } catch {
      // The request may fail if the server restarts before responding — that's OK
    }
    // The RebuildOverlay handles the rest via WS broadcast
  }, [])

  const isConnected = ['started', 'running', 'connecting', 'connected', 'reconnected', 'restarted'].includes(terminalStatus)
  const isError = terminalStatus === 'claude_error'
  const isWorking = isConnected && isActive && !isWaiting
  const isReady = isConnected && !isActive && !isWaiting
  const isWaitingForApproval = isConnected && isWaiting

  const healthAllUp = healthResults && healthResults.length > 0 && healthResults.every((r: HealthCheckResult) => r.status === 'up')
  const healthAllDown = healthResults && healthResults.length > 0 && healthResults.every((r: HealthCheckResult) => r.status === 'down')
  const healthHasResults = healthResults && healthResults.length > 0

  // Report status to context for sidebar
  useEffect(() => {
    updateProjectStatus(project.id, {
      terminalStatus,
      isActive,
      isWaiting,
      isError,
      healthUp: !!healthAllUp,
      healthDown: !!healthAllDown,
      healthHasResults: !!healthHasResults,
    })
  }, [project.id, terminalStatus, isActive, isWaiting, isError, healthAllUp, healthAllDown, healthHasResults, updateProjectStatus])

  const canManageMembers = summary.currentUserRole === 'owner' || summary.currentUserRole === 'super_admin'

  const { data: appSettings } = useQuery({ queryKey: ['settings'], queryFn: getSettings, staleTime: 60_000 })
  const isSuperAdmin = summary.currentUserRole === 'super_admin'
  const shellEnabled = appSettings?.experimentalShell ?? false
  const { displayMode } = useMode()
  const isServerMode = displayMode === 'server'

  const tabs: { key: CardTab; label: string; icon: string; tooltip: string }[] = [
    { key: 'terminal', label: 'Claude Code', icon: 'terminal', tooltip: 'Claude Code' },
    { key: 'health', label: 'Health', icon: 'health', tooltip: 'Health & KPIs' },
    ...(shellEnabled || isSuperAdmin ? [{ key: 'shell' as CardTab, label: 'Shell', icon: 'shell', tooltip: 'Interactive Shell' }] : []),
    { key: 'issues', label: 'Issues', icon: 'issues', tooltip: 'Issues' },
    { key: 'feedback', label: 'Feedback', icon: 'feedback', tooltip: 'Feedback Review' },
    { key: 'files', label: 'Files', icon: 'files', tooltip: 'File Explorer' },
    { key: 'ci', label: 'CI', icon: 'ci', tooltip: 'CI / Deploy' },
    ...(isMultiModule || isUnit ? [{ key: 'modules' as CardTab, label: 'Modules', icon: 'modules', tooltip: 'Manage Units' }] : []),
  ]

  const menuItems: { key: CardTab; label: string; icon: string }[] = [
    { key: 'intents', label: 'Intents', icon: 'intents' },
    { key: 'settings', label: 'Settings', icon: 'settings' },
    { key: 'history', label: 'Session History', icon: 'history' },
    { key: 'log', label: 'Activity Log', icon: 'log' },
    ...(canManageMembers ? [{ key: 'members' as CardTab, label: 'Users', icon: 'members' }] : []),
  ]

  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close hamburger menu on outside click
  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  const handleCardClick = useCallback(() => {
    setActiveProjectId(project.id)
  }, [project.id, setActiveProjectId])

  const cardContent = (
    <div
      onClick={handleCardClick}
      className={embedded
        ? 'flex flex-col h-full bg-gray-800 overflow-hidden'
        : isFullscreen
          ? 'fixed inset-0 z-50 flex flex-col bg-gray-800'
          : `flex flex-col h-full rounded-lg border bg-gray-800 overflow-hidden transition-all duration-200 ${
              isActiveProject
                ? 'border-indigo-500 shadow-[0_0_12px_rgba(99,102,241,0.4)] ring-1 ring-indigo-500/50'
                : 'border-gray-700'
            }`
      }>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-gray-900 border-b border-gray-700 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {!embedded && <>
            {isUnit && parentProject && (
              <button
                onClick={(e) => { e.stopPropagation(); setActiveProjectId(parentProject.id); const el = document.querySelector(`[data-project-id="${parentProject.id}"]`); el?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }}
                className="inline-flex items-center gap-1 text-[10px] font-semibold text-purple-300/70 hover:text-purple-300 transition-colors shrink-0 mr-0.5"
                title={`Module of ${parentProject.name} — click to select`}
              >
                <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 7.125C2.25 6.504 2.754 6 3.375 6h6c.621 0 1.125.504 1.125 1.125v3.75c0 .621-.504 1.125-1.125 1.125h-6a1.125 1.125 0 0 1-1.125-1.125v-3.75ZM14.25 8.625c0-.621.504-1.125 1.125-1.125h5.25c.621 0 1.125.504 1.125 1.125v8.25c0 .621-.504 1.125-1.125 1.125h-5.25a1.125 1.125 0 0 1-1.125-1.125v-8.25ZM3.75 16.125c0-.621.504-1.125 1.125-1.125h5.25c.621 0 1.125.504 1.125 1.125v2.25c0 .621-.504 1.125-1.125 1.125h-5.25a1.125 1.125 0 0 1-1.125-1.125v-2.25Z" />
                </svg>
                {parentProject.name}
                <span className="text-gray-600">/</span>
              </button>
            )}
            <span className="drag-handle text-sm font-semibold text-white truncate cursor-grab select-none">
              {project.name}
            </span>
            <span className="drag-handle text-[10px] font-mono text-gray-500 shrink-0 cursor-grab select-none">({project.code})</span>
            {isMultiModule && (
              <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-purple-500/20 text-purple-300 shrink-0">orchestrator</span>
            )}
          </>}
          {(() => {
            const frontendUrl = monitorEnv === 'dev'
              ? project.healthCheck?.frontend.devUrl
              : monitorEnv === 'prod'
                ? project.healthCheck?.frontend.prodUrl
                : (project.healthCheck?.frontend.devUrl || project.healthCheck?.frontend.prodUrl);
            if (!frontendUrl) return null;
            const href = /^https?:\/\//i.test(frontendUrl) ? frontendUrl : `http://${frontendUrl}`;
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="relative z-20 inline-flex items-center gap-1 rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-indigo-500 transition-colors shrink-0"
                title={`Open ${frontendUrl}`}
              >
                Go
                <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </a>
            );
          })()}
          {openIssueCount > 0 && (
            <span
              className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-indigo-600 text-xs font-mono text-white shrink-0 cursor-pointer"
              title={`${openIssueCount} open issues`}
              onClick={(e) => { e.stopPropagation(); setActiveTab('issues') }}
            >
              {openIssueCount}
            </span>
          )}
          {(summary.pendingFeedbackCount ?? 0) > 0 && (
            <span
              className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-amber-600 text-xs font-mono text-white shrink-0 cursor-pointer"
              title={`${summary.pendingFeedbackCount} pending feedback`}
              onClick={(e) => { e.stopPropagation(); setActiveTab('feedback') }}
            >
              {summary.pendingFeedbackCount}
            </span>
          )}
        </div>
        {/* Drag handle spacer — textured grip area */}
        <div className="drag-handle flex-1 min-w-4 h-full cursor-grab flex items-center justify-center mx-1 opacity-30 hover:opacity-60 transition-opacity">
          <div className="flex gap-[3px] flex-wrap justify-center max-w-[40px]">
            {[...Array(6)].map((_, i) => (
              <span key={i} className="w-1 h-1 rounded-full bg-gray-500" />
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {activeTab === 'terminal' && isError && (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-500/20 px-2 py-0.5 text-xs font-medium text-red-400">
              <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
              Error
            </span>
          )}
          {activeTab === 'terminal' && isWorking && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-400">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              Working
            </span>
          )}
          {activeTab === 'terminal' && isWaitingForApproval && (
            <span className="inline-flex items-center gap-1 rounded-full bg-purple-500/20 px-2 py-0.5 text-xs font-medium text-purple-400">
              <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse" />
              Waiting
            </span>
          )}
          {activeTab === 'terminal' && isReady && (
            <span className="inline-flex items-center gap-1 rounded-full bg-green-500/20 px-2 py-0.5 text-xs font-medium text-green-400">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
              Ready
            </span>
          )}
          {monitorEnv && healthHasResults && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowHealthDetail(true) }}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium cursor-pointer hover:ring-1 hover:ring-white/20 transition-all ${
              healthAllUp
                ? 'bg-green-600/20 text-green-400'
                : healthAllDown
                  ? 'bg-red-600/20 text-red-400'
                  : 'bg-yellow-600/20 text-yellow-400'
            }`}>
              <span className={`h-1.5 w-1.5 rounded-full ${
                healthAllUp ? 'bg-green-400' : healthAllDown ? 'bg-red-400' : 'bg-yellow-400'
              }`} />
              {healthAllUp ? 'Up' : healthAllDown ? 'Down' : 'Degraded'}
            </button>
          )}
          {isSelfProject && activeTab === 'terminal' && (
            <button
              onClick={(e) => { e.stopPropagation(); handleRebuild() }}
              disabled={rebuilding}
              className="inline-flex items-center gap-1 rounded-full bg-cyan-600/20 px-2 py-0.5 text-[10px] font-medium text-cyan-400 hover:bg-cyan-600/30 transition-colors disabled:opacity-50"
              title="Rebuild & restart VibeCtl server"
            >
              <svg className={`w-3 h-3 ${rebuilding ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {rebuilding ? 'Rebuilding' : 'Rebuild'}
            </button>
          )}
          {!embedded && (
            <button
              onClick={() => setIsFullscreen(!isFullscreen)}
              className="text-gray-500 hover:text-gray-300 transition-colors"
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {isFullscreen ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9V4.5M9 9H4.5M9 9 3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5 5.25 5.25" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                )}
              </svg>
            </button>
          )}
          {!embedded && !isFullscreen && (
            <button
              onClick={(e) => { e.stopPropagation(); closeProject(project.id) }}
              className="text-gray-500 hover:text-red-400 transition-colors"
              title="Close window"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-700 shrink-0">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            title={tab.tooltip}
            className={`px-2.5 py-1.5 transition-colors ${
              activeTab === tab.key
                ? 'text-white border-b-2 border-indigo-500 bg-gray-800'
                : 'text-gray-500 hover:text-gray-300 bg-gray-850'
            }`}
          >
            <TabIcon name={tab.icon} />
          </button>
        ))}
        {/* Hamburger menu for secondary items */}
        <div className="relative ml-auto" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            title="More options"
            className={`px-2.5 py-1.5 transition-colors ${
              menuItems.some((m) => m.key === activeTab)
                ? 'text-white border-b-2 border-indigo-500 bg-gray-800'
                : 'text-gray-500 hover:text-gray-300 bg-gray-850'
            }`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM18.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z" />
            </svg>
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 w-44 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-30 py-1">
              {menuItems.map((item) => (
                <button
                  key={item.key}
                  onClick={() => { setActiveTab(item.key); setMenuOpen(false) }}
                  className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-xs transition-colors ${
                    activeTab === item.key
                      ? 'text-white bg-gray-700'
                      : 'text-gray-400 hover:text-white hover:bg-gray-700/50'
                  }`}
                >
                  <TabIcon name={item.icon} />
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Tab content — stop drag propagation so inputs work */}
      <div className="flex-1 overflow-hidden" onMouseDown={(e) => e.stopPropagation()}>
        {activeTab === 'terminal' && (() => {
          if (isServerMode) return <ServerModeClaudeTab />

          const isCloned = project.cloneStatus === 'cloned' || !!project.links.localPath
          const isCloning = project.cloneStatus === 'cloning' || cloneStreaming
          const hasGitHub = !!project.links.githubUrl

          if (isCloned && !cloneStreaming) {
            return (
              <div className="flex flex-col h-full">
                <div className="flex items-center justify-between gap-2 px-2 py-1 text-xs text-gray-500 shrink-0">
                  <span className="font-mono truncate">{project.links.localPath}</span>
                  <div className="flex gap-1 shrink-0">
                    <button onClick={handlePull} className="px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors">Pull</button>
                    <button onClick={handleRemoveClone} className="px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors">Remove</button>
                  </div>
                </div>
                <div className="flex-1 overflow-hidden">
                  <ChatView
                    projectId={project.id}
                    projectCode={project.code}
                    localPath={project.links.localPath}
                    compact={!isFullscreen}
                    onStatusChange={handleStatusChange}
                    onActivityChange={handleActivityChange}
                    onSessionSnapshot={handleSessionSnapshot}
                    onWaitingChange={handleWaitingChange}
                  />
                </div>
              </div>
            )
          }

          if (isCloning || cloneLog.length > 0) {
            return (
              <div className="p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm text-gray-400">
                  {cloneStreaming && <div className="w-3 h-3 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />}
                  <span>{cloneStreaming ? 'Cloning…' : 'Clone output'}</span>
                </div>
                <div ref={cloneLogRef} className="font-mono text-xs text-green-300 bg-black rounded p-3 h-64 overflow-y-auto whitespace-pre-wrap">
                  {cloneLog.map((line, i) => <div key={i}>{line}</div>)}
                </div>
              </div>
            )
          }

          if (hasGitHub || !isCloned) {
            return <SetLocalPathPanel project={project} onClone={handleClone} onPathSaved={() => queryClient.invalidateQueries({ queryKey: ['globalDashboard'] })} />
          }

          return (
            <ChatView
              projectId={project.id}
              projectCode={project.code}
              localPath={project.links.localPath}
              compact={!isFullscreen}
              onStatusChange={handleStatusChange}
              onActivityChange={handleActivityChange}
              onSessionSnapshot={handleSessionSnapshot}
              onWaitingChange={handleWaitingChange}
            />
          )
        })()}
        {activeTab === 'shell' && (
          <UserShellView projectId={project.id} compact={true} />
        )}
        {activeTab === 'issues' && (
          <CompactIssueList projectId={project.id} projectCode={project.code} />
        )}
        {activeTab === 'files' && (
          <FilesBrowser
            projectId={project.id}
            localPath={project.links.localPath}
            githubUrl={project.links.githubUrl}
            onClone={handleClone}
          />
        )}
        {activeTab === 'history' && (
          <ChatHistoryTab projectId={project.id} currentSession={currentSession} />
        )}
        {activeTab === 'health' && (
          <CompactHealthChecks project={project} results={healthResults} />
        )}
        {activeTab === 'log' && (
          <CompactActivityLog projectId={project.id} />
        )}
        {activeTab === 'settings' && (
          <CompactSettings project={project} currentUserRole={summary.currentUserRole} onClone={handleClone} />
        )}
        {activeTab === 'intents' && (
          <ProjectIntentsTab projectId={project.id} />
        )}
        {activeTab === 'feedback' && (
          <FeedbackTab projectId={project.id} projectCode={project.code} />
        )}
        {activeTab === 'ci' && (
          <div className="p-3 overflow-y-auto h-full">
            <CITab
              projectId={project.id}
              hasLocalPath={!!project.links.localPath}
              hasGitHubUrl={!!project.links.githubUrl}
              hasDeployCmd={!!project.deployment?.deployProd}
              hasStartDevCmd={!!project.deployment?.startDev}
              hasStartProdCmd={!!(project.deployment?.startProd || project.deployment?.flyApp)}
              hasRestartProdCmd={!!(project.deployment?.restartProd || project.deployment?.flyApp)}
              paused={project.paused}
              githubUrl={project.links.githubUrl}
              isCloned={project.cloneStatus === 'cloned' || !!project.links.localPath}
              cloneStreaming={cloneStreaming}
              cloneLog={cloneLog}
              hasGitHubPAT={!!currentUser?.hasGitHubPAT}
              onClone={handleClone}
              onPull={handlePull}
              onPausedChange={(p) => queryClient.setQueryData(['globalDashboard'], (old: unknown) => {
                if (!Array.isArray(old)) return old;
                return old.map((proj: { id: string; paused?: boolean }) => proj.id === project.id ? { ...proj, paused: p } : proj);
              })}
              onSaveGithubUrl={async (url) => {
                await updateProject(project.id, { links: { ...project.links, githubUrl: url } })
                queryClient.invalidateQueries({ queryKey: ['globalDashboard'] })
              }}
            />
          </div>
        )}
        {activeTab === 'members' && (
          <div className="p-3 overflow-y-auto h-full">
            <MembersPanel projectId={project.id} />
          </div>
        )}
        {activeTab === 'modules' && (isMultiModule || isUnit) && (
          <div className="p-3 overflow-y-auto h-full">
            <ModulesTab
              parentId={isUnit ? project.parentId! : project.id}
              parentProject={isUnit ? parentProject : project}
              showParentHero={isUnit}
            />
          </div>
        )}
      </div>
    </div>
  )

  return (
    <>
      {isFullscreen ? createPortal(cardContent, document.body) : cardContent}
      {showHealthDetail && healthResults && (
        <HealthDetailModal
          results={healthResults}
          projectName={project.name}
          monitorEnv={monitorEnv || ''}
          onClose={() => setShowHealthDetail(false)}
        />
      )}
    </>
  )
}

function HealthDetailModal({ results, projectName, monitorEnv, onClose }: {
  results: HealthCheckResult[]
  projectName: string
  monitorEnv: string
  onClose: () => void
}) {
  const allUp = results.every(r => r.status === 'up')
  const allDown = results.every(r => r.status === 'down')

  const statusIcon = (status: string) => {
    if (status === 'up' || status === 'healthy') return <span className="h-2 w-2 rounded-full bg-green-400 shrink-0" />
    if (status === 'down' || status === 'unhealthy') return <span className="h-2 w-2 rounded-full bg-red-400 shrink-0" />
    return <span className="h-2 w-2 rounded-full bg-yellow-400 shrink-0" />
  }

  const statusLabel = allUp ? 'Up' : allDown ? 'Down' : 'Degraded'
  const statusColor = allUp ? 'text-green-400' : allDown ? 'text-red-400' : 'text-yellow-400'

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-lg mx-4 bg-gray-900 rounded-xl border border-gray-700 shadow-2xl" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-white">{projectName}</h3>
            <span className={`text-xs font-medium ${statusColor}`}>{statusLabel}</span>
            <span className="text-[10px] text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded">{monitorEnv}</span>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Endpoints */}
        <div className="px-5 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {results.map((r, i) => (
            <div key={i} className="space-y-2">
              <div className="flex items-center gap-2">
                {statusIcon(r.status)}
                <span className="text-sm font-medium text-white">{r.name}</span>
                <span className={`text-xs font-medium ${
                  r.status === 'up' ? 'text-green-400' : r.status === 'down' ? 'text-red-400' : 'text-yellow-400'
                }`}>{r.status}</span>
                {r.code ? <span className="text-[10px] text-gray-500 font-mono">HTTP {r.code}</span> : null}
              </div>

              <div className="text-[11px] text-gray-500 font-mono truncate">{r.url}</div>

              {/* Error / reason for degraded/down */}
              {r.error && (
                <div className="rounded bg-red-900/20 border border-red-700/30 px-3 py-2">
                  <p className="text-xs text-red-300">{r.error}</p>
                </div>
              )}

              {/* Software info */}
              {(r.softwareName || r.version || r.uptime) && (
                <div className="flex gap-4 text-[11px] text-gray-400">
                  {r.softwareName && <span>{r.softwareName}{r.version ? ` v${r.version}` : ''}</span>}
                  {r.uptime ? <span>Uptime: {formatUptime(r.uptime)}</span> : null}
                </div>
              )}

              {/* Dependencies */}
              {r.dependencies && r.dependencies.length > 0 && (
                <div className="ml-3 space-y-1">
                  <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">Dependencies</p>
                  {r.dependencies.map((dep, di) => (
                    <div key={di} className="flex items-center gap-2">
                      {statusIcon(dep.status)}
                      <span className="text-xs text-gray-300">{dep.name}</span>
                      <span className={`text-[10px] ${
                        dep.status === 'healthy' ? 'text-green-400' : dep.status === 'unhealthy' ? 'text-red-400' : 'text-yellow-400'
                      }`}>{dep.status}</span>
                      {dep.message && <span className="text-[10px] text-gray-500 truncate">{dep.message}</span>}
                    </div>
                  ))}
                </div>
              )}

              {/* KPIs */}
              {r.kpis && r.kpis.length > 0 && (
                <div className="ml-3 flex flex-wrap gap-3">
                  {r.kpis.map((kpi, ki) => (
                    <div key={ki} className="text-[11px]">
                      <span className="text-gray-500">{kpi.name}: </span>
                      <span className="text-white font-medium">{kpi.value}</span>
                      <span className="text-gray-500 ml-0.5">{kpi.unit}</span>
                    </div>
                  ))}
                </div>
              )}

              {i < results.length - 1 && <hr className="border-gray-800 mt-3" />}
            </div>
          ))}

          {/* Explanation for degraded */}
          {!allUp && !allDown && (
            <div className="rounded-lg bg-yellow-900/15 border border-yellow-700/30 px-3 py-2 mt-2">
              <p className="text-xs text-yellow-300 font-medium mb-1">Why Degraded?</p>
              <p className="text-[11px] text-yellow-200/70">
                {results.filter(r => r.status === 'degraded').map(r =>
                  r.error
                    ? `${r.name}: ${r.error}`
                    : `${r.name}: responding but not fully healthy`
                ).join('. ')}.
                {' '}{results.filter(r => r.status === 'down').map(r =>
                  r.error
                    ? `${r.name}: ${r.error}`
                    : `${r.name}: not responding`
                ).join('. ')}{results.some(r => r.status === 'down') ? '.' : ''}
              </p>
            </div>
          )}

          {allDown && (
            <div className="rounded-lg bg-red-900/15 border border-red-700/30 px-3 py-2 mt-2">
              <p className="text-xs text-red-300 font-medium mb-1">Why Down?</p>
              <p className="text-[11px] text-red-200/70">
                {results.map(r =>
                  r.error
                    ? `${r.name}: ${r.error}`
                    : `${r.name}: not responding (HTTP ${r.code || '?'})`
                ).join('. ')}.
              </p>
            </div>
          )}
        </div>

        <div className="px-5 pb-4">
          <button onClick={onClose} className="w-full rounded-lg bg-gray-800 hover:bg-gray-700 py-2 text-xs text-gray-400 transition-colors">
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function TabIcon({ name }: { name: string }) {
  const cls = "w-4 h-4"
  switch (name) {
    case 'terminal':
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m6.75 7.5 3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z" />
        </svg>
      )
    case 'issues':
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
        </svg>
      )
    case 'files':
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
        </svg>
      )
    case 'history':
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
        </svg>
      )
    case 'health':
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h3l3-6 3 12 3-6h6" />
        </svg>
      )
    case 'log':
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z" />
        </svg>
      )
    case 'settings':
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
        </svg>
      )
    case 'members':
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
        </svg>
      )
    case 'ci':
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 0 0-3.7-3.7 48.678 48.678 0 0 0-7.324 0 4.006 4.006 0 0 0-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 0 0 3.7 3.7 48.656 48.656 0 0 0 7.324 0 4.006 4.006 0 0 0 3.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3-3 3" />
        </svg>
      )
    case 'feedback':
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />
        </svg>
      )
    case 'modules':
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 7.125C2.25 6.504 2.754 6 3.375 6h6c.621 0 1.125.504 1.125 1.125v3.75c0 .621-.504 1.125-1.125 1.125h-6a1.125 1.125 0 0 1-1.125-1.125v-3.75ZM14.25 8.625c0-.621.504-1.125 1.125-1.125h5.25c.621 0 1.125.504 1.125 1.125v8.25c0 .621-.504 1.125-1.125 1.125h-5.25a1.125 1.125 0 0 1-1.125-1.125v-8.25ZM3.75 16.125c0-.621.504-1.125 1.125-1.125h5.25c.621 0 1.125.504 1.125 1.125v2.25c0 .621-.504 1.125-1.125 1.125h-5.25a1.125 1.125 0 0 1-1.125-1.125v-2.25Z" />
        </svg>
      )
    case 'intents':
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z" />
        </svg>
      )
    default:
      return <span className="text-xs">{name}</span>
  }
}

function SetLocalPathPanel({ project, onClone, onPathSaved }: { project: Project; onClone: () => void; onPathSaved: () => void }) {
  const [editPath, setEditPath] = useState(project.links.localPath || '')
  const [checking, setChecking] = useState(false)
  const [pathExists, setPathExists] = useState<boolean | null>(null)

  const checkAndSave = async () => {
    if (!editPath.trim()) return
    setChecking(true)
    try {
      const res = await checkDir(editPath.trim())
      if (res.exists) {
        await updateProject(project.id, { links: { ...project.links, localPath: editPath.trim() } })
        setPathExists(true)
        onPathSaved()
      } else {
        setPathExists(false)
      }
    } catch {
      setPathExists(false)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-8">
      <div className="text-gray-400 text-sm">
        <p className="text-white font-medium mb-1">No local copy configured</p>
        <p>Set the local path to an existing repo, or clone from GitHub.</p>
      </div>

      {/* Current path display */}
      {project.links.localPath && (
        <div className="text-[10px] text-gray-500">
          Current path: <span className="font-mono text-gray-400">{project.links.localPath}</span>
          <span className="text-red-400 ml-1">(not found on disk)</span>
        </div>
      )}

      {/* Editable path */}
      <div className="w-full max-w-md">
        <div className="flex gap-2">
          <input
            value={editPath}
            onChange={(e) => { setEditPath(e.target.value); setPathExists(null) }}
            onKeyDown={(e) => e.key === 'Enter' && checkAndSave()}
            placeholder="/path/to/project"
            className="flex-1 rounded border border-gray-600 bg-gray-800 px-3 py-1.5 text-xs text-gray-200 font-mono focus:border-indigo-500 focus:outline-none"
          />
          <button
            onClick={checkAndSave}
            disabled={!editPath.trim() || checking}
            className="rounded bg-indigo-600 hover:bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 transition-colors"
          >
            {checking ? 'Checking...' : 'Set Path'}
          </button>
        </div>
        {pathExists === false && (
          <p className="text-red-400 text-[10px] mt-1">Directory not found. Check the path and try again.</p>
        )}
        {pathExists === true && (
          <p className="text-green-400 text-[10px] mt-1">Path verified and saved!</p>
        )}
      </div>

      {/* Clone option */}
      {project.links.githubUrl && (
        <div className="border-t border-gray-700/50 pt-3 w-full max-w-md">
          <p className="text-[10px] text-gray-500 mb-2">Or clone from GitHub:</p>
          <p className="font-mono text-xs text-gray-500 mb-2">{project.links.githubUrl}</p>
          {project.cloneStatus === 'error' && (
            <p className="text-red-400 text-xs mb-2">{project.cloneError}</p>
          )}
          <button onClick={onClone} className="bg-gray-700 hover:bg-gray-600 text-white font-medium py-1.5 px-4 rounded text-xs transition-colors">
            Clone Repository
          </button>
        </div>
      )}
    </div>
  )
}

function CompactIssueList({ projectId, projectCode }: { projectId: string; projectCode: string }) {
  const [showNewIssue, setShowNewIssue] = useState(false)
  const { data: issues, isLoading } = useQuery({
    queryKey: ['issues', projectId],
    queryFn: () => listIssues(projectId),
  })

  if (isLoading) {
    return (
      <div className="p-3 space-y-2">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-6 animate-pulse rounded bg-gray-700" />
        ))}
      </div>
    )
  }

  const openIssues = (issues ?? []).filter((i: Issue) => i.status === 'open')

  return (
    <div className="flex flex-col h-full">
      {/* New Issue button */}
      <div className="px-3 py-1.5 border-b border-gray-700/30 shrink-0">
        <button
          onClick={() => setShowNewIssue(true)}
          className="w-full rounded bg-indigo-600/80 px-2 py-1 text-[10px] font-medium text-white hover:bg-indigo-500 transition-colors"
        >
          + New Issue
        </button>
      </div>

      {openIssues.length === 0 ? (
        <div className="flex items-center justify-center flex-1 text-sm text-gray-500">
          No open issues
        </div>
      ) : (
        <div className="overflow-y-auto flex-1">
          {openIssues.slice(0, 20).map((issue: Issue) => (
            <Link
              key={issue.id}
              to={`/projects/${projectCode}/issues/${issue.issueKey}`}
              className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-gray-700/50 border-b border-gray-700/30"
            >
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${priorityColors[issue.priority as Priority] ?? ''}`}>
                {issue.priority}
              </span>
              <span className="text-gray-300 truncate">{issue.title}</span>
              <span className="ml-auto text-gray-600 font-mono text-[10px] shrink-0">{issue.issueKey}</span>
            </Link>
          ))}
          {openIssues.length > 20 && (
            <div className="px-3 py-1.5 text-xs text-gray-500 text-center">
              +{openIssues.length - 20} more
            </div>
          )}
        </div>
      )}

      {showNewIssue && (
        <NewIssueModal
          projectId={projectCode}
          onClose={() => setShowNewIssue(false)}
        />
      )}
    </div>
  )
}

function NewIssueModal({ projectCode, onClose }: { projectCode: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [title, setTitle] = useState('')
  const [type, setType] = useState<IssueType>('bug')
  const [priority, setPriority] = useState<Priority>('P2')
  const [description, setDescription] = useState('')
  const [reproSteps, setReproSteps] = useState('')
  const [reproError, setReproError] = useState('')

  const mutation = useMutation({
    mutationFn: (data: Partial<Issue>) => createIssue(projectCode, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issues', projectId] })
      queryClient.invalidateQueries({ queryKey: ['globalDashboard'] })
      onClose()
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    if (type === 'bug' && !reproSteps.trim()) {
      setReproError('Repro steps are required for bugs')
      return
    }
    setReproError('')
    mutation.mutate({
      title: title.trim(),
      type,
      priority,
      description: description.trim(),
      createdBy: 'user',
      ...(type === 'bug' && reproSteps.trim() && { reproSteps: reproSteps.trim() }),
    })
  }

  const issueTypes: { value: IssueType; label: string }[] = [
    { value: 'bug', label: 'Bug' },
    { value: 'feature', label: 'Feature' },
    { value: 'idea', label: 'Idea' },
  ]
  const priorities: Priority[] = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5']

  const inputClass = 'w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-200 focus:border-indigo-500 focus:outline-none'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-gray-800 rounded-lg border border-gray-700 w-full max-w-3xl mx-4 p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-white mb-4">New Issue</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Title *</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Issue title"
              className={inputClass}
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Type</label>
              <div className="flex gap-2">
                {issueTypes.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => { setType(t.value); setReproError('') }}
                    className={`rounded border px-3 py-1.5 text-xs font-medium transition ${
                      type === t.value
                        ? `${typeColors[t.value]} ring-1 ring-white/30`
                        : 'border-gray-600 bg-gray-700 text-gray-400 hover:border-gray-500'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Priority</label>
              <div className="flex gap-1.5">
                {priorities.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPriority(p)}
                    className={`rounded px-2.5 py-1 text-xs font-bold transition ${priorityColors[p]} ${
                      priority === p ? 'ring-1 ring-white/40' : 'opacity-40 hover:opacity-80'
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
              placeholder="Describe the issue (markdown supported)"
              className={inputClass + ' resize-y'}
            />
          </div>

          {type === 'bug' && (
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">
                Repro Steps <span className="text-red-400">*</span>
              </label>
              <textarea
                value={reproSteps}
                onChange={(e) => { setReproSteps(e.target.value); setReproError('') }}
                rows={4}
                placeholder="1. Go to...&#10;2. Click on...&#10;3. Observe..."
                className={inputClass + ' resize-y'}
              />
              {reproError && (
                <p className="mt-1 text-xs text-red-400">{reproError}</p>
              )}
            </div>
          )}

          <div className="flex items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={mutation.isPending || !title.trim()}
              className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {mutation.isPending ? 'Creating...' : 'Create Issue'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded bg-gray-700 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-gray-600"
            >
              Cancel
            </button>
            {mutation.isError && (
              <span className="text-xs text-red-400">
                {mutation.error instanceof Error ? mutation.error.message : 'Failed'}
              </span>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}

function ProjectIntentsTab({ projectId }: { projectId: string }) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const { data: intents = [], isLoading } = useQuery({
    queryKey: ['intents', projectId],
    queryFn: () => listIntents({ projectCode, limit: 100 }),
    refetchInterval: 30_000,
  })

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => patchIntent(id, { status } as Partial<Intent>),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['intents', projectId] })
      queryClient.invalidateQueries({ queryKey: ['intentProductivity'] })
    },
  })

  const delivered = intents.filter((i: Intent) => i.status === 'delivered')
  const deliveredPoints = delivered.reduce((s: number, i: Intent) => s + i.sizePoints, 0)
  const totalPoints = intents.reduce((s: number, i: Intent) => s + i.sizePoints, 0)
  const totalTokens = intents.reduce((s: number, i: Intent) => s + i.tokensInput + i.tokensOutput, 0)

  const formatTokens = (n: number) => n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n)
  const formatDuration = (secs: number) => {
    if (secs < 60) return `${secs}s`
    if (secs < 3600) return `${Math.round(secs / 60)}m`
    return `${(secs / 3600).toFixed(1)}h`
  }

  const categoryColors: Record<string, string> = {
    UI: 'bg-purple-500/20 text-purple-300', API: 'bg-blue-500/20 text-blue-300',
    infra: 'bg-orange-500/20 text-orange-300', data: 'bg-cyan-500/20 text-cyan-300',
    test: 'bg-green-500/20 text-green-300', docs: 'bg-gray-500/20 text-gray-300',
    bugfix: 'bg-red-500/20 text-red-300', refactor: 'bg-amber-500/20 text-amber-300',
  }
  const statusIcons: Record<string, string> = {
    delivered: '\u2705', partial: '\u26a0\ufe0f', abandoned: '\u274c', deferred: '\u23f8\ufe0f',
  }

  if (isLoading) {
    return <div className="p-3 space-y-2">{[...Array(3)].map((_, i) => <div key={i} className="h-8 animate-pulse rounded bg-gray-800" />)}</div>
  }

  return (
    <div className="p-3 overflow-y-auto h-full text-xs space-y-3">
      {/* Summary */}
      <div className="flex gap-3">
        <div className="rounded bg-gray-800/50 border border-gray-700/40 px-2.5 py-1.5 text-center flex-1">
          <div className="font-bold text-indigo-400">{deliveredPoints}<span className="text-gray-600 font-normal">/{totalPoints}</span></div>
          <div className="text-[9px] text-gray-500">Points</div>
        </div>
        <div className="rounded bg-gray-800/50 border border-gray-700/40 px-2.5 py-1.5 text-center flex-1">
          <div className="font-bold text-emerald-400">{delivered.length}<span className="text-gray-600 font-normal">/{intents.length}</span></div>
          <div className="text-[9px] text-gray-500">Delivered</div>
        </div>
        <div className="rounded bg-gray-800/50 border border-gray-700/40 px-2.5 py-1.5 text-center flex-1">
          <div className="font-bold text-gray-400">{formatTokens(totalTokens)}</div>
          <div className="text-[9px] text-gray-500">Tokens</div>
        </div>
      </div>

      {intents.length === 0 ? (
        <div className="text-center py-6 text-gray-600">No intents extracted yet.</div>
      ) : (
        <div className="space-y-1">
          {intents.map((intent: Intent) => (
            <div key={intent.id} className="rounded border border-gray-700/40 bg-gray-800/30 overflow-hidden">
              <button
                onClick={() => setExpandedId(expandedId === intent.id ? null : intent.id)}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-gray-700/20 transition-colors"
              >
                <span className="text-[11px]">{statusIcons[intent.status] || ''}</span>
                <span className="font-medium text-gray-300 flex-1 truncate">{intent.title}</span>
                <span className={`rounded px-1 py-0 text-[9px] font-medium ${categoryColors[intent.category] || 'bg-gray-700/50 text-gray-400'}`}>{intent.category}</span>
                <span className="text-[10px] font-mono text-gray-500">{intent.size} ({intent.sizePoints}pt)</span>
              </button>
              {expandedId === intent.id && (
                <div className="px-2.5 py-2 border-t border-gray-700/30 space-y-1.5 text-[10px]">
                  <p className="text-gray-400">{intent.description}</p>
                  <div className="flex flex-wrap gap-1">
                    {(intent.techTags ?? []).map(t => <span key={t} className="rounded bg-gray-700/50 px-1.5 py-0.5 text-gray-400">{t}</span>)}
                  </div>
                  <div className="flex gap-3 text-gray-500">
                    <span>{intent.size} ({intent.sizePoints} pt)</span>
                    <span>UX: {intent.uxJudgment}</span>
                    <span>Tokens: {formatTokens(intent.tokensInput + intent.tokensOutput)}</span>
                    <span>Duration: {formatDuration(intent.wallClockSecs)}</span>
                    <span>Prompts: {intent.promptCount}</span>
                  </div>
                  <p className="text-gray-600 italic">{intent.statusEvidence}</p>
                  {(intent.filesChanged ?? []).length > 0 && (
                    <details>
                      <summary className="text-gray-500 cursor-pointer">{(intent.filesChanged ?? []).length} files</summary>
                      <div className="mt-1 font-mono text-gray-600 max-h-20 overflow-y-auto">
                        {(intent.filesChanged ?? []).map((f, i) => <div key={i}>{f}</div>)}
                      </div>
                    </details>
                  )}
                  <div className="flex items-center justify-between mt-1 pt-1 border-t border-gray-700/20">
                    <span className="text-gray-600">{new Date(intent.completedAt).toLocaleString()}</span>
                    <div className="flex gap-1.5">
                      {intent.status !== 'delivered' && (
                        <button
                          onClick={(e) => { e.stopPropagation(); statusMutation.mutate({ id: intent.id, status: 'delivered' }) }}
                          disabled={statusMutation.isPending}
                          className="rounded bg-emerald-800/40 hover:bg-emerald-700/50 text-emerald-300 px-2 py-0.5 text-[9px] font-medium transition-colors"
                        >
                          Mark Complete
                        </button>
                      )}
                      {intent.status === 'delivered' && (
                        <button
                          onClick={(e) => { e.stopPropagation(); statusMutation.mutate({ id: intent.id, status: 'partial' }) }}
                          disabled={statusMutation.isPending}
                          className="rounded bg-gray-700/40 hover:bg-gray-600/50 text-gray-400 px-2 py-0.5 text-[9px] font-medium transition-colors"
                        >
                          Mark Incomplete
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ExportToRemoteButton({ projectCode }: { projectCode: string }) {
  const { data: delegation } = useQuery({
    queryKey: ['delegationStatus'],
    queryFn: getDelegationStatus,
    retry: 1,
  })
  const viewMode = getViewMode()
  const exportMutation = useMutation({
    mutationFn: () => exportProjectToRemote(projectCode),
  })

  // Only show when delegation is active and viewing local data
  if (!delegation?.enabled || viewMode !== 'local') return null

  return (
    <div className="border-t border-gray-700/50 pt-2 mt-2">
      <button
        onClick={() => exportMutation.mutate()}
        disabled={exportMutation.isPending}
        className="rounded bg-cyan-800/40 border border-cyan-700/50 px-3 py-1 text-xs font-medium text-cyan-300 hover:bg-cyan-800/60 disabled:opacity-50 transition-colors"
      >
        {exportMutation.isPending ? 'Exporting...' : 'Export to Remote Server'}
      </button>
      {exportMutation.isSuccess && (
        <span className="ml-2 text-[10px] text-green-400">
          {(exportMutation.data as { message: string })?.message || 'Exported!'}
        </span>
      )}
      {exportMutation.isError && (
        <span className="ml-2 text-[10px] text-red-400">
          {exportMutation.error instanceof Error ? exportMutation.error.message : 'Export failed'}
        </span>
      )}
      <p className="text-[10px] text-gray-600 mt-1">
        Creates this project on the remote server so it appears in Remote View.
      </p>
    </div>
  )
}

function CompactSettings({ project, currentUserRole, onClone }: { project: ProjectSummary['project']; currentUserRole?: string; onClone?: () => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description || '')
  const [localPath, setLocalPath] = useState(project.links.localPath || '')
  const [githubUrl, setGithubUrl] = useState(project.links.githubUrl || '')
  const [goals, setGoals] = useState((project.goals ?? []).join('\n'))
  const [tags, setTags] = useState<string[]>(project.tags ?? [])
  const [tagInput, setTagInput] = useState('')
  const [allTags, setAllTags] = useState<string[]>([])
  const [tagHighlight, setTagHighlight] = useState(0)

  // Fetch all tags for autocomplete
  useEffect(() => {
    listAllTags().then(setAllTags).catch(() => {})
  }, [])

  const filteredSuggestions = tagInput.trim()
    ? allTags.filter(t => t.toLowerCase().includes(tagInput.toLowerCase()) && !tags.includes(t))
    : []

  const addTag = (tag: string) => {
    const t = tag.trim().toLowerCase()
    if (t && !tags.includes(t)) setTags([...tags, t])
    setTagInput('')
    setTagHighlight(0)
  }

  const removeTag = (tag: string) => setTags(tags.filter(t => t !== tag))

  const [healthCheck, setHealthCheck] = useState<HealthCheckConfig>(
    project.healthCheck || { frontend: {}, backend: {}, monitorEnv: '' }
  )
  const [deployment, setDeployment] = useState<DeploymentConfig>(project.deployment || {})
  const [saved, setSaved] = useState(false)
  const [showArchiveModal, setShowArchiveModal] = useState(false)
  const [offerClone, setOfferClone] = useState(false)
  const [flyDetecting, setFlyDetecting] = useState(false)
  const [flyDetected, setFlyDetected] = useState<{ appName: string; deployProd: string; startProd: string; restartProd: string; viewLogs: string } | null>(null)
  const [flyNotFound, setFlyNotFound] = useState(false)
  const [startShDetecting, setStartShDetecting] = useState(false)
  const [startShFound, setStartShFound] = useState<{ preview: string; command: string } | null>(null)
  const [startShNotFound, setStartShNotFound] = useState(false)
  const [startShApplied, setStartShApplied] = useState(false)

  const mutation = useMutation({
    mutationFn: (data: Partial<Project>) => updateProject(project.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['globalDashboard'] })
      queryClient.invalidateQueries({ queryKey: ['healthcheck', project.id] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      // Offer clone if GitHub URL was set and there's no local path
      if (githubUrl && !localPath && onClone) {
        setOfferClone(true)
      }
    },
  })

  const archiveMutation = useMutation({
    mutationFn: () => archiveProject(project.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['globalDashboard'] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })

  const handleSave = () => {
    mutation.mutate({
      name,
      description,
      links: {
        localPath: localPath || undefined,
        githubUrl: githubUrl || undefined,
      },
      goals: goals.split('\n').map((g) => g.trim()).filter(Boolean),
      tags,
      healthCheck,
      deployment,
    })
  }

  const inputClass = 'w-full rounded border border-gray-600 bg-gray-700 px-2 py-1 text-xs text-gray-200 focus:border-indigo-500 focus:outline-none'
  const labelClass = 'block text-[10px] font-medium text-gray-500 mb-0.5'

  return (
    <div className="p-3 text-xs space-y-2 overflow-y-auto h-full">
      <div>
        <label className={labelClass}>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
      </div>
      <div>
        <label className={labelClass}>Description</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className={inputClass + ' resize-none'} />
      </div>
      <div>
        <label className={labelClass}>Local Path</label>
        <input value={localPath} onChange={(e) => setLocalPath(e.target.value)} className={inputClass + ' font-mono'} placeholder="/path/to/project" />
      </div>
      <div>
        <label className={labelClass}>GitHub URL</label>
        <input value={githubUrl} onChange={(e) => setGithubUrl(e.target.value)} className={inputClass} placeholder="https://github.com/..." />
      </div>
      <div>
        <label className={labelClass}>Goals (one per line)</label>
        <textarea value={goals} onChange={(e) => setGoals(e.target.value)} rows={3} className={inputClass + ' resize-none'} placeholder="Ship v2 by Q2&#10;Fix critical bugs" />
      </div>
      <div>
        <label className={labelClass}>Tags</label>
        <div className="flex flex-wrap gap-1 mb-1">
          {tags.map(tag => (
            <span key={tag} className="inline-flex items-center gap-0.5 rounded-full bg-indigo-600/20 text-indigo-300 px-2 py-0.5 text-[10px] font-medium">
              {tag}
              <button onClick={() => removeTag(tag)} className="text-indigo-400 hover:text-indigo-200 ml-0.5">&times;</button>
            </span>
          ))}
        </div>
        <div className="relative">
          <input
            value={tagInput}
            onChange={(e) => { setTagInput(e.target.value); setTagHighlight(0) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && tagInput.trim()) {
                e.preventDefault()
                if (filteredSuggestions.length > 0) addTag(filteredSuggestions[tagHighlight])
                else addTag(tagInput)
              } else if (e.key === 'ArrowDown' && filteredSuggestions.length > 0) {
                e.preventDefault()
                setTagHighlight(h => (h + 1) % filteredSuggestions.length)
              } else if (e.key === 'ArrowUp' && filteredSuggestions.length > 0) {
                e.preventDefault()
                setTagHighlight(h => (h - 1 + filteredSuggestions.length) % filteredSuggestions.length)
              } else if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
                removeTag(tags[tags.length - 1])
              }
            }}
            className={inputClass}
            placeholder="Add tag..."
          />
          {filteredSuggestions.length > 0 && (
            <div className="absolute z-10 left-0 right-0 mt-0.5 rounded border border-gray-600 bg-gray-800 shadow-lg max-h-32 overflow-y-auto">
              {filteredSuggestions.map((s, i) => (
                <button
                  key={s}
                  onMouseDown={(e) => { e.preventDefault(); addTag(s) }}
                  className={`w-full text-left px-2 py-1 text-[10px] ${i === tagHighlight ? 'bg-indigo-600/30 text-indigo-200' : 'text-gray-300 hover:bg-gray-700/50'}`}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {/* Health Check Config */}
      <div className="border-t border-gray-700/50 pt-2 mt-2">
        <label className={labelClass}>Health Checks</label>
        <div className="flex gap-1 mb-1.5">
          {[
            { value: '', label: 'Off' },
            { value: 'dev', label: 'Dev' },
            { value: 'prod', label: 'Prod' },
          ].map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setHealthCheck({ ...healthCheck, monitorEnv: opt.value })}
              className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                healthCheck.monitorEnv === opt.value
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="space-y-1">
          <div className="grid grid-cols-2 gap-1">
            <input
              value={healthCheck.frontend.devUrl || ''}
              onChange={(e) => setHealthCheck({ ...healthCheck, frontend: { ...healthCheck.frontend, devUrl: e.target.value } })}
              placeholder="Frontend dev URL"
              className={inputClass + ' text-[10px]'}
            />
            <input
              value={healthCheck.frontend.prodUrl || ''}
              onChange={(e) => setHealthCheck({ ...healthCheck, frontend: { ...healthCheck.frontend, prodUrl: e.target.value } })}
              placeholder="Frontend prod URL"
              className={inputClass + ' text-[10px]'}
            />
          </div>
          <div className="grid grid-cols-2 gap-1">
            <input
              value={healthCheck.backend.devUrl || ''}
              onChange={(e) => setHealthCheck({ ...healthCheck, backend: { ...healthCheck.backend, devUrl: e.target.value } })}
              placeholder="Backend dev URL"
              className={inputClass + ' text-[10px]'}
            />
            <input
              value={healthCheck.backend.prodUrl || ''}
              onChange={(e) => setHealthCheck({ ...healthCheck, backend: { ...healthCheck.backend, prodUrl: e.target.value } })}
              placeholder="Backend prod URL"
              className={inputClass + ' text-[10px]'}
            />
          </div>
        </div>
      </div>

      {/* Deployment */}
      <div className="border-t border-gray-700/50 pt-2 mt-2">
        <div className="flex items-center justify-between mb-1.5">
          <label className={labelClass}>Deployment Commands</label>
          {localPath && (
            <button
              type="button"
              disabled={flyDetecting}
              onClick={async () => {
                setFlyDetecting(true)
                setFlyNotFound(false)
                try {
                  const res = await detectFlyToml(localPath)
                  if (res.found && res.appName) {
                    setFlyDetected({ appName: res.appName, deployProd: res.deployProd!, startProd: res.startProd!, restartProd: res.restartProd!, viewLogs: res.viewLogs! })
                  } else {
                    setFlyNotFound(true)
                  }
                } catch {
                  setFlyNotFound(true)
                } finally {
                  setFlyDetecting(false)
                }
              }}
              className="text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              {flyDetecting ? 'Examining…' : '⚡ Examine fly.toml'}
            </button>
          )}
        </div>

        {flyNotFound && <p className="text-[10px] text-gray-500 mb-1">No fly.toml found in local path.</p>}

        {flyDetected && createPortal(
          <FlyTomlSuggestionsModal
            appName={flyDetected.appName}
            suggestions={{
              flyApp: flyDetected.appName,
              deployProd: flyDetected.deployProd,
              startProd: flyDetected.startProd,
              restartProd: flyDetected.restartProd,
              viewLogs: flyDetected.viewLogs,
            }}
            current={deployment}
            onApply={(accepted) => {
              setDeployment({ ...deployment, ...accepted })
              setFlyDetected(null)
            }}
            onClose={() => setFlyDetected(null)}
          />,
          document.body
        )}

        <div className="space-y-1">
          {([
            { key: 'deployProd', label: 'Deploy Prod', placeholder: 'fly deploy' },
            { key: 'startProd', label: 'Start Prod', placeholder: 'fly apps start myapp' },
            { key: 'restartProd', label: 'Restart Prod', placeholder: 'fly apps restart myapp' },
            { key: 'viewLogs', label: 'View Logs', placeholder: 'fly logs -a myapp' },
          ] as { key: keyof DeploymentConfig; label: string; placeholder: string }[]).map((cmd) => (
            <div key={cmd.key}>
              <label className={labelClass}>{cmd.label}</label>
              <input
                value={(deployment[cmd.key] as string) || ''}
                onChange={(e) => setDeployment({ ...deployment, [cmd.key]: e.target.value })}
                placeholder={cmd.placeholder}
                className={inputClass + ' font-mono'}
              />
            </div>
          ))}

          {/* Start Dev — with start.sh detection */}
          <div>
            <div className="flex items-center justify-between mb-0.5">
              <label className={labelClass}>Start Dev</label>
              {localPath && !startShFound && (
                <button
                  type="button"
                  disabled={startShDetecting}
                  onClick={async () => {
                    setStartShDetecting(true)
                    setStartShNotFound(false)
                    try {
                      const res = await detectStartSh(localPath)
                      if (res.found && res.command) {
                        setStartShFound({ preview: res.preview ?? '', command: res.command })
                      } else {
                        setStartShNotFound(true)
                      }
                    } catch {
                      setStartShNotFound(true)
                    } finally {
                      setStartShDetecting(false)
                    }
                  }}
                  className="text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors"
                >
                  {startShDetecting ? 'Checking…' : '⚡ Detect start.sh'}
                </button>
              )}
            </div>

            {startShNotFound && <p className="text-[10px] text-gray-500 mb-1">No start.sh found in local path.</p>}

            {startShFound && (
              <div className="rounded border border-indigo-500/30 bg-indigo-500/10 p-2 mb-1 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-indigo-300 font-medium">start.sh found</span>
                  <button type="button" onClick={() => setStartShFound(null)} className="text-gray-500 hover:text-gray-400 text-[10px]">✕</button>
                </div>
                {startShFound.preview && (
                  <pre className="text-[9px] text-gray-400 bg-gray-950 rounded p-1.5 max-h-20 overflow-y-auto whitespace-pre-wrap">{startShFound.preview}</pre>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setDeployment({ ...deployment, startDev: startShFound.command })
                    setStartShFound(null)
                    setStartShApplied(true)
                    setTimeout(() => setStartShApplied(false), 3000)
                  }}
                  className="w-full rounded bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-medium py-1 transition-colors"
                >
                  Use ./start.sh as Start Dev command
                </button>
              </div>
            )}

            <input
              value={(deployment.startDev as string) || ''}
              onChange={(e) => setDeployment({ ...deployment, startDev: e.target.value })}
              placeholder="npm run dev  or  ./start.sh"
              className={inputClass + ' font-mono'}
            />
            {startShApplied && <span className="text-[10px] text-green-400">Applied — hit Save to persist</span>}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={handleSave}
          disabled={mutation.isPending}
          className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {mutation.isPending ? 'Saving...' : 'Save'}
        </button>
        {saved && <span className="text-green-400 text-[10px]">Saved</span>}
        {mutation.isError && <span className="text-red-400 text-[10px]">{mutation.error instanceof Error ? mutation.error.message : 'Failed to save'}</span>}
      </div>

      {offerClone && (
        <div className="rounded border border-indigo-500/30 bg-indigo-500/10 p-2 space-y-1.5">
          <p className="text-[11px] text-indigo-300 font-medium">Clone repository now?</p>
          <p className="text-[10px] text-gray-400 font-mono truncate">{githubUrl}</p>
          <div className="flex gap-1.5">
            <button
              onClick={() => { setOfferClone(false); onClone?.() }}
              className="rounded bg-indigo-600 hover:bg-indigo-500 px-2 py-1 text-[10px] font-medium text-white transition-colors"
            >
              Clone
            </button>
            <button
              onClick={() => setOfferClone(false)}
              className="rounded bg-gray-700 hover:bg-gray-600 px-2 py-1 text-[10px] font-medium text-gray-300 transition-colors"
            >
              Not now
            </button>
          </div>
        </div>
      )}

      {/* Export to Remote — only visible when delegation active + local view */}
      <ExportToRemoteButton projectCode={project.code} />

      {/* Inactive toggle */}
      <div className="border-t border-gray-700/50 pt-2 mt-2">
        <label className={labelClass}>Inactive</label>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              const newVal = !project.inactive
              updateProject(project.id, { inactive: newVal }).then(() => {
                queryClient.invalidateQueries({ queryKey: ['globalDashboard'] })
                queryClient.invalidateQueries({ queryKey: ['universeData'] })
              })
            }}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${project.inactive ? 'bg-indigo-600' : 'bg-gray-600'}`}
          >
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${project.inactive ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
          </button>
          <span className="text-[10px] text-gray-500">
            {project.inactive ? 'Project is inactive — hidden from default dashboard views' : 'Project is active'}
          </span>
        </div>
      </div>

      {/* Archive — owner/super_admin only */}
      {(currentUserRole === 'owner' || currentUserRole === 'super_admin') && (
        <div className="border-t border-gray-700/50 pt-2 mt-2">
          <button
            onClick={() => setShowArchiveModal(true)}
            disabled={archiveMutation.isPending}
            className="rounded bg-red-900/40 border border-red-800/50 px-3 py-1 text-xs font-medium text-red-400 hover:bg-red-900/60 disabled:opacity-50 transition-colors"
          >
            {archiveMutation.isPending ? 'Archiving...' : 'Archive Project'}
          </button>
          {archiveMutation.isError && (
            <span className="ml-2 text-red-400 text-[10px]">
              {archiveMutation.error instanceof Error ? archiveMutation.error.message : 'Failed to archive'}
            </span>
          )}
        </div>
      )}

      {/* Archive confirmation modal */}
      {showArchiveModal && createPortal(
        <ArchiveConfirmModal
          project={project}
          onCancel={() => setShowArchiveModal(false)}
          onConfirm={() => { setShowArchiveModal(false); archiveMutation.mutate() }}
        />,
        document.body
      )}
    </div>
  )
}

function ChatHistoryTab({ projectCode, currentSession }: { projectCode: string; currentSession: ChatSessionSnapshot | null }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [viewingCurrent, setViewingCurrent] = useState(false)

  const { data: history, isLoading } = useQuery({
    queryKey: ['chatHistory', projectId],
    queryFn: () => listChatHistory(projectId),
  })

  const { data: entry, isLoading: entryLoading } = useQuery({
    queryKey: ['chatHistoryEntry', selectedId],
    queryFn: () => getChatHistoryEntry(selectedId!),
    enabled: !!selectedId,
  })

  if (isLoading) {
    return (
      <div className="p-3 space-y-2">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-8 animate-pulse rounded bg-gray-700" />
        ))}
      </div>
    )
  }

  const hasCurrentMessages = currentSession && currentSession.messages.length > 0
  const hasHistory = history && history.length > 0

  if (!hasCurrentMessages && !hasHistory) {
    return (
      <div className="flex items-center justify-center h-full p-4 text-center text-gray-500 text-xs">
        No chat history yet.
      </div>
    )
  }

  // Viewing current session
  if (viewingCurrent && currentSession) {
    return (
      <HistoryDetailView
        label="Active Session"
        labelColor="text-green-400"
        subtitle={`started ${new Date(currentSession.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
        messages={currentSession.messages}
        messageType="chat"
        onBack={() => setViewingCurrent(false)}
      />
    )
  }

  // Viewing a past entry
  if (selectedId && entry) {
    return (
      <HistoryDetailView
        label={`${new Date(entry.startedAt).toLocaleDateString()} ${new Date(entry.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
        subtitle={`${entry.messageCount} messages`}
        messages={entry.messages}
        messageType="raw"
        onBack={() => setSelectedId(null)}
      />
    )
  }

  if (selectedId && entryLoading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-xs">
        Loading...
      </div>
    )
  }

  // List view
  return (
    <div className="overflow-y-auto h-full">
      {/* Current session at the top */}
      {hasCurrentMessages && (
        <button
          onClick={() => setViewingCurrent(true)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-700/50 border-b border-gray-700/30 transition-colors bg-green-900/10"
        >
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs text-green-400 font-medium">Active Session</div>
            <div className="text-[10px] text-gray-500">
              started {new Date(currentSession!.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              {' \u00b7 '}
              {currentSession!.messages.length} messages
            </div>
          </div>
          <svg className="w-3 h-3 text-gray-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m8.25 4.5 7.5 7.5-7.5 7.5" />
          </svg>
        </button>
      )}

      {/* Past sessions */}
      {(history ?? []).map((item: ChatHistorySummary) => {
        const startDate = new Date(item.startedAt)
        const endDate = new Date(item.endedAt)
        const duration = Math.round((endDate.getTime() - startDate.getTime()) / 60000)

        return (
          <button
            key={item.id}
            onClick={() => setSelectedId(item.id)}
            className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-700/50 border-b border-gray-700/30 transition-colors"
          >
            <div className="flex-1 min-w-0">
              <div className="text-xs text-gray-300">
                {startDate.toLocaleDateString()} {startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
              <div className="text-[10px] text-gray-500">
                {duration > 0 ? `${duration}m` : '<1m'} &middot; {item.messageCount} messages
              </div>
            </div>
            <svg className="w-3 h-3 text-gray-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m8.25 4.5 7.5 7.5-7.5 7.5" />
            </svg>
          </button>
        )
      })}
    </div>
  )
}

function HistoryDetailView({
  label,
  labelColor,
  subtitle,
  messages,
  messageType,
  onBack,
}: {
  label: string
  labelColor?: string
  subtitle: string
  messages: unknown[]
  messageType: 'chat' | 'raw'
  onBack: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Find indices of user messages (the "turns" where the user gave input)
  const userIndices = useMemo(() => {
    const indices: number[] = []
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i] as Record<string, unknown>
      if (messageType === 'chat') {
        if (msg.role === 'user' && msg.text) indices.push(i)
      } else {
        // Raw messages from backend: user messages with text content
        if (msg.type === 'user') {
          const message = msg.message as { content?: Array<{ type: string; text?: string }> } | undefined
          if (message?.content?.some((b) => b.type === 'text' && b.text)) indices.push(i)
        }
      }
    }
    return indices
  }, [messages, messageType])

  // Start at the last user message
  const [turnIndex, setTurnIndex] = useState(() => Math.max(0, userIndices.length - 1))

  // Reset when messages change (e.g. live session updates)
  useEffect(() => {
    setTurnIndex(Math.max(0, userIndices.length - 1))
  }, [userIndices.length])

  const currentUserMsgIndex = userIndices[turnIndex] ?? 0
  // Show from this user message up to (but not including) the next user message
  const nextUserMsgIndex = turnIndex < userIndices.length - 1
    ? userIndices[turnIndex + 1]
    : messages.length

  const visibleMessages = messages.slice(currentUserMsgIndex, nextUserMsgIndex)

  // Scroll to top when stepping
  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0)
  }, [turnIndex])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-700/50 shrink-0">
        <button
          onClick={onBack}
          className="text-[10px] text-indigo-400 hover:text-indigo-300 shrink-0"
        >
          &larr; Back
        </button>
        <span className={`text-[10px] font-medium ${labelColor || 'text-gray-500'}`}>{label}</span>
        <span className="text-[10px] text-gray-600 ml-auto shrink-0">{subtitle}</span>
      </div>

      {/* Turn navigator */}
      {userIndices.length > 0 && (
        <div className="flex items-center justify-between px-3 py-1 border-b border-gray-700/30 shrink-0 bg-gray-800/50">
          <button
            onClick={() => setTurnIndex((i) => Math.max(0, i - 1))}
            disabled={turnIndex <= 0}
            className="text-[10px] text-gray-400 hover:text-white disabled:text-gray-700 disabled:cursor-not-allowed transition-colors px-1.5 py-0.5 rounded hover:bg-gray-700/50"
          >
            &larr; Prev
          </button>
          <span className="text-[10px] text-gray-500 font-mono">
            Turn {turnIndex + 1} / {userIndices.length}
          </span>
          <button
            onClick={() => setTurnIndex((i) => Math.min(userIndices.length - 1, i + 1))}
            disabled={turnIndex >= userIndices.length - 1}
            className="text-[10px] text-gray-400 hover:text-white disabled:text-gray-700 disabled:cursor-not-allowed transition-colors px-1.5 py-0.5 rounded hover:bg-gray-700/50"
          >
            Next &rarr;
          </button>
        </div>
      )}

      {/* Messages for this turn */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {visibleMessages.map((msg, i) => (
          messageType === 'chat'
            ? <HistoryMessageFromChat key={currentUserMsgIndex + i} msg={msg as any} />
            : <HistoryMessage key={currentUserMsgIndex + i} msg={msg} />
        ))}
      </div>
    </div>
  )
}

function HistoryMessage({ msg }: { msg: unknown }) {
  const data = msg as Record<string, unknown>
  const type = data.type as string

  if (type === 'assistant') {
    const message = data.message as { content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> } | undefined
    if (!message?.content) return null

    return (
      <div className="space-y-1">
        {message.content.map((block, i) => {
          if (block.type === 'text' && block.text) {
            return (
              <div key={i} className="text-xs text-gray-300 whitespace-pre-wrap">
                {block.text}
              </div>
            )
          }
          if (block.type === 'tool_use') {
            return (
              <div key={i} className="text-[10px] font-mono text-amber-400/70 bg-gray-800/50 rounded px-2 py-0.5">
                {block.name}{block.input && 'file_path' in block.input ? ` ${String(block.input.file_path).split('/').slice(-2).join('/')}` : ''}
              </div>
            )
          }
          return null
        })}
      </div>
    )
  }

  if (type === 'user') {
    const message = data.message as { content?: Array<{ type: string; text?: string; content?: unknown }> } | undefined
    if (!message?.content) return null

    const textBlock = message.content.find((b) => b.type === 'text')
    const toolResult = message.content.find((b) => b.type === 'tool_result')

    if (textBlock?.text) {
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-lg bg-indigo-600/20 border border-indigo-500/20 px-2 py-1">
            <p className="text-[11px] text-gray-300 whitespace-pre-wrap">{textBlock.text}</p>
          </div>
        </div>
      )
    }

    if (toolResult) {
      let content = ''
      if (typeof toolResult.content === 'string') {
        content = toolResult.content
      } else if (toolResult.content) {
        content = JSON.stringify(toolResult.content)
      }
      return (
        <div className="text-[10px] font-mono text-gray-600 bg-gray-800/30 rounded px-2 py-0.5 truncate">
          {content.slice(0, 120)}{content.length > 120 ? '...' : ''}
        </div>
      )
    }

    return null
  }

  return null
}

function HistoryMessageFromChat({ msg }: { msg: { role: string; text?: string; content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>; toolUseId?: string; isError?: boolean } }) {
  if (msg.role === 'user' && msg.text) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-indigo-600/20 border border-indigo-500/20 px-2 py-1">
          <p className="text-[11px] text-gray-300 whitespace-pre-wrap">{msg.text}</p>
        </div>
      </div>
    )
  }

  if (msg.role === 'assistant' && msg.content) {
    return (
      <div className="space-y-1">
        {msg.content.map((block, i) => {
          if (block.type === 'text' && block.text) {
            return <div key={i} className="text-xs text-gray-300 whitespace-pre-wrap">{block.text}</div>
          }
          if (block.type === 'tool_use') {
            return (
              <div key={i} className="text-[10px] font-mono text-amber-400/70 bg-gray-800/50 rounded px-2 py-0.5">
                {block.name}{block.input && 'file_path' in block.input ? ` ${String(block.input.file_path).split('/').slice(-2).join('/')}` : ''}
              </div>
            )
          }
          return null
        })}
      </div>
    )
  }

  if (msg.role === 'tool_result') {
    const content = (msg as unknown as { content: string }).content || ''
    return (
      <div className="text-[10px] font-mono text-gray-600 bg-gray-800/30 rounded px-2 py-0.5 truncate">
        {content.slice(0, 120)}{content.length > 120 ? '...' : ''}
      </div>
    )
  }

  return null
}

function CompactHealthChecks({ project, results }: { project: ProjectSummary['project']; results?: HealthCheckResult[] }) {
  const queryClient = useQueryClient()
  const monitorEnv = project.healthCheck?.monitorEnv

  const { data: history } = useQuery({
    queryKey: ['healthHistory', project.id],
    queryFn: () => getHealthHistory(project.id),
    enabled: !!monitorEnv,
    refetchInterval: 10 * 60 * 1000,
  })

  if (!monitorEnv) {
    return (
      <div className="flex items-center justify-center h-full p-4 text-center text-gray-500 text-xs">
        <div>
          <p className="mb-1">Health checks not configured.</p>
          <p>Set up URLs in the <span className="text-indigo-400 font-medium">Settings</span> tab.</p>
        </div>
      </div>
    )
  }

  if (!results || results.length === 0) {
    return (
      <div className="flex items-center justify-center h-full p-4 text-center text-gray-500 text-xs">
        No endpoints configured for <span className="font-medium ml-1">{monitorEnv}</span>.
      </div>
    )
  }

  // Collect KPIs deduplicated by name+value (same KPI reported by multiple endpoints shown once)
  const kpiMap = new Map<string, { name: string; value: number; unit: string }>()
  for (const r of results) {
    for (const k of (r.kpis || [])) {
      const existing = kpiMap.get(k.name)
      if (!existing || existing.value !== k.value) {
        // Only add if new or values differ (if values differ, include both under unique keys)
        kpiMap.set(existing && existing.value !== k.value ? `${k.name}__${r.name}` : k.name, k)
      }
    }
  }
  const allKPIs = Array.from(kpiMap.values())
  // Collect dependencies deduplicated by name (same dep from multiple endpoints shown once)
  const depMap = new Map<string, { name: string; status: string; message?: string }>()
  for (const r of results) {
    for (const d of (r.dependencies || [])) {
      if (!depMap.has(d.name)) depMap.set(d.name, d)
    }
  }
  const allDeps = Array.from(depMap.values())

  return (
    <div className="p-3 space-y-3 overflow-y-auto h-full">
      {/* KPI cards — prominent at top */}
      {allKPIs.length > 0 && (
        <div className={`flex flex-wrap justify-center gap-2`}>
          {allKPIs.map((k, i) => (
            <div key={`${k.name}-${i}`} className="rounded-lg border border-gray-700/60 bg-gray-800/60 p-3 text-center" style={{ width: `calc(${100 / Math.min(allKPIs.length, 3)}% - ${(Math.min(allKPIs.length, 3) - 1) * 8 / Math.min(allKPIs.length, 3)}px)`, minWidth: '80px' }}>
              <div className={`text-2xl font-bold leading-none ${kpiValueColor(k.value, k.unit)}`}>
                {formatKPIValue(k.value, k.unit)}
              </div>
              <div className="text-[10px] text-gray-500 mt-1.5 uppercase tracking-wider font-medium">
                {k.name.replace(/_/g, ' ')}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Endpoint status — compact inline row */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-gray-500 uppercase font-medium mr-1">
          Endpoints ({monitorEnv})
        </span>
        {results.map((r: HealthCheckResult) => (
          <div
            key={r.name}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 ${
              r.status === 'up'
                ? 'border-green-800/50 bg-green-900/10'
                : r.status === 'degraded'
                  ? 'border-yellow-800/50 bg-yellow-900/10'
                  : 'border-red-800/50 bg-red-900/10'
            }`}
            title={`${r.url}${r.error ? `\n${r.error}` : ''}${r.uptime != null && r.uptime > 0 ? `\nUptime: ${formatUptime(r.uptime)}` : ''}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${
              r.status === 'up' ? 'bg-green-400' : r.status === 'degraded' ? 'bg-yellow-400' : 'bg-red-400'
            }`} />
            <span className="text-[11px] font-medium text-gray-300">{r.name === 'Frontend' ? 'Front' : r.name === 'Backend' ? 'Back' : r.name}</span>
            {r.version && <span className="text-[9px] text-gray-600 font-mono">v{r.version}</span>}
            <span className={`text-[9px] font-mono font-medium ${
              r.status === 'up' ? 'text-green-500' : r.status === 'degraded' ? 'text-yellow-400' : 'text-red-400'
            }`}>
              {r.status === 'up' ? r.code : r.status === 'degraded' ? 'DEGRADED' : 'DOWN'}
            </span>
          </div>
        ))}
        <button
          onClick={() => queryClient.invalidateQueries({ queryKey: ['healthcheck', project.id] })}
          className="text-[10px] text-indigo-400 hover:text-indigo-300 ml-auto"
        >
          Refresh
        </button>
      </div>

      {/* Dependencies — compact inline */}
      {allDeps.length > 0 && (
        <div className="flex items-center gap-x-3 gap-y-0.5 flex-wrap">
          <span className="text-[10px] text-gray-500 uppercase font-medium mr-0.5">Deps</span>
          {allDeps.map((d, i) => (
            <span key={`${d.name}-${i}`} className="inline-flex items-center gap-1 text-[11px]" title={d.message || undefined}>
              <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                d.status === 'healthy' ? 'bg-green-400' : d.status === 'degraded' ? 'bg-yellow-400' : 'bg-red-400'
              }`} />
              <span className="text-gray-300">{d.name}</span>
            </span>
          ))}
        </div>
      )}

      {history && history.length > 0 && <CompactUptimeTimeline history={history} />}
    </div>
  )
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
  const days = Math.floor(seconds / 86400)
  const hrs = Math.floor((seconds % 86400) / 3600)
  return `${days}d ${hrs}h`
}

function formatKPIValue(value: number, unit: string): string {
  const u = unit.toLowerCase()
  if (u === 'usd') {
    const abs = Math.abs(value).toFixed(2)
    return value < 0 ? `-$${abs}` : `$${abs}`
  }
  if (u === 'percent') return `${value.toFixed(1)}%`
  if (u === 'ms') return `${value.toFixed(0)}ms`
  if (u === 's' || u === 'seconds') return `${value.toFixed(1)}s`
  if (u === 'bytes') {
    if (value > 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)}GB`
    if (value > 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)}MB`
    if (value > 1024) return `${(value / 1024).toFixed(1)}KB`
    return `${value}B`
  }
  if (u === 'rpm' || u === 'rps') return `${value.toLocaleString()} ${unit}`
  if (Number.isInteger(value)) return value.toLocaleString()
  return value.toFixed(1)
}

function kpiValueColor(value: number, unit: string): string {
  const u = unit.toLowerCase()
  if (u === 'usd') return value < 0 ? 'text-red-400' : 'text-green-400'
  return 'text-white'
}

function CompactUptimeTimeline({ history }: { history: HealthRecord[] }) {
  const endpointNames = Array.from(
    new Set(history.flatMap((r) => r.results.map((res) => res.name)))
  )

  const uptimeByEndpoint: Record<string, { up: number; total: number }> = {}
  for (const name of endpointNames) {
    uptimeByEndpoint[name] = { up: 0, total: 0 }
  }
  for (const record of history) {
    for (const res of record.results) {
      if (uptimeByEndpoint[res.name]) {
        uptimeByEndpoint[res.name].total++
        if (res.status === 'up') uptimeByEndpoint[res.name].up++
      }
    }
  }

  const getStatusColor = (record: HealthRecord, endpointName: string): string => {
    const res = record.results.find((r) => r.name === endpointName)
    if (!res) return 'bg-gray-700'
    if (res.status === 'up') return 'bg-green-500'
    if (res.status === 'down') return 'bg-red-500'
    return 'bg-yellow-500'
  }

  const formatTime = (dateStr: string) =>
    new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="border-t border-gray-700/50 pt-2 mt-1">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] text-gray-500 font-medium">Last 24 hours</span>
        <span className="text-[10px] text-gray-600">{history.length} checks</span>
      </div>
      <div className={`grid gap-3 ${endpointNames.length >= 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
      {endpointNames.map((name) => {
        const stats = uptimeByEndpoint[name]
        const pct = stats.total > 0 ? ((stats.up / stats.total) * 100).toFixed(1) : '—'
        return (
          <div key={name} className="space-y-0.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-gray-400">{name === 'Frontend' ? 'Front' : name === 'Backend' ? 'Back' : name}</span>
              <span className={`text-[10px] font-mono font-medium ${
                pct === '100.0' ? 'text-green-400'
                  : pct === '—' ? 'text-gray-500'
                    : Number(pct) >= 99 ? 'text-yellow-400'
                      : 'text-red-400'
              }`}>
                {pct}%
              </span>
            </div>
            <div className="flex gap-px">
              {history.map((record) => (
                <div
                  key={record.id}
                  className={`h-3 flex-1 rounded-sm ${getStatusColor(record, name)} opacity-80 hover:opacity-100 transition-opacity cursor-default`}
                  title={`${formatTime(record.checkedAt)}: ${
                    record.results.find((r) => r.name === name)?.status ?? 'no data'
                  }`}
                />
              ))}
            </div>
            <div className="flex justify-between text-[9px] text-gray-600">
              <span>{formatTime(history[0].checkedAt)}</span>
              <span>{formatTime(history[history.length - 1].checkedAt)}</span>
            </div>
          </div>
        )
      })}
      </div>
    </div>
  )
}

// --- Compact Activity Log ---

const LOG_TYPE_META: Record<string, { label: string; color: string }> = {
  backend_start: { label: 'Start', color: 'text-blue-400' },
  prompt_sent: { label: 'Prompt', color: 'text-indigo-400' },
  file_edit: { label: 'File', color: 'text-amber-400' },
  settings_change: { label: 'Settings', color: 'text-gray-400' },
  issue_created: { label: 'Issue+', color: 'text-green-400' },
  issue_status: { label: 'Status', color: 'text-cyan-400' },
  prompt_created: { label: 'Prompt+', color: 'text-purple-400' },
  prompt_edited: { label: 'PromptEdit', color: 'text-purple-300' },
  prompt_deleted: { label: 'Prompt-', color: 'text-red-400' },
  feedback_submitted: { label: 'Feedback', color: 'text-amber-400' },
  feedback_accepted: { label: 'Accepted', color: 'text-green-400' },
  feedback_dismissed: { label: 'Dismissed', color: 'text-gray-500' },
  feedback_converted: { label: 'Converted', color: 'text-teal-400' },
}

function formatLogTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'now'
  if (diffMin < 60) return `${diffMin}m`
  const diffHrs = Math.floor(diffMin / 60)
  if (diffHrs < 24) return `${diffHrs}h`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function CompactActivityLog({ projectId }: { projectCode: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['activity-log', projectId],
    queryFn: () => listActivityLog({ projectCode, limit: 50 }),
    refetchInterval: 15000,
  })

  const entries = data?.entries || []

  if (isLoading) {
    return (
      <div className="p-3 space-y-1">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-5 animate-pulse rounded bg-gray-700/50" />
        ))}
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-xs p-4">
        No activity logged for this project yet.
      </div>
    )
  }

  return (
    <div className="overflow-y-auto h-full">
      {entries.map((entry: ActivityLogEntry) => (
        <CompactLogRow key={entry.id} entry={entry} />
      ))}
    </div>
  )
}

function CompactLogRow({ entry }: { entry: ActivityLogEntry }) {
  const [expanded, setExpanded] = useState(false)
  const meta = LOG_TYPE_META[entry.type] || { label: entry.type, color: 'text-gray-500' }
  const fullText = (entry.metadata?.fullText as string) || ''
  const hasMore = !!fullText && fullText !== entry.snippet

  return (
    <div className="flex items-start gap-2 px-3 py-1.5 hover:bg-gray-800/30 transition-colors border-b border-gray-800/30">
      <span className={`text-[10px] font-medium shrink-0 w-14 ${meta.color}`}>{meta.label}</span>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-gray-100 truncate">
          {entry.userName && <span className="text-gray-500">{entry.userName}: </span>}
          {entry.message}
        </p>
        {entry.snippet && (
          <p className={`text-[10px] text-gray-400 font-mono mt-0.5 whitespace-pre-wrap ${expanded ? '' : 'truncate'}`}>
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
      <span className="text-[10px] text-gray-500 shrink-0">{formatLogTime(entry.timestamp)}</span>
    </div>
  )
}

// ─── Modules tab (multi-module parent only) ─────────────────────────────────

type AddMode = 'chooser' | 'new' | 'existing' | null
type PostOpAction = { type: 'added' | 'detached'; unitName: string; parentName: string; parentPath: string } | null

function ModulesTab({ parentId, parentProject, showParentHero }: {
  parentId: string; parentProject?: Project | null; showParentHero?: boolean
}) {
  const [addMode, setAddMode] = useState<AddMode>(null)
  const [confirmDetach, setConfirmDetach] = useState<Project | null>(null)
  const [postOp, setPostOp] = useState<PostOpAction>(null)
  const [unitName, setUnitName] = useState('')
  const [unitCode, setUnitCode] = useState('')
  const [unitPath, setUnitPath] = useState('')
  const [unitDesc, setUnitDesc] = useState('')
  const [selectedExisting, setSelectedExisting] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const queryClient = useQueryClient()
  const { setActiveProjectId } = useActiveProject()

  const { data: units = [], isLoading } = useQuery({
    queryKey: ['units', parentId],
    queryFn: () => listUnits(parentId),
    staleTime: 60_000,
  })

  // For attach existing: get all projects, filter to eligible ones
  const { data: allProjects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
    enabled: addMode === 'existing',
  })
  const eligibleProjects = allProjects.filter(p =>
    !p.parentId && p.projectType !== 'multi' && p.id !== parentId && !units.some(u => u.id === p.id)
  )

  const pName = parentProject?.name || 'Orchestrator'
  const pPath = parentProject?.links.localPath || ''

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['units', parentId] })
    queryClient.invalidateQueries({ queryKey: ['globalDashboard'] })
    queryClient.invalidateQueries({ queryKey: ['universeData'] })
  }

  const handleAddNew = async () => {
    setError('')
    if (!unitName.trim() || !unitCode.trim() || !unitPath.trim()) { setError('Name, code, and path are required.'); return }
    if (!/^[A-Z]{3,5}$/.test(unitCode)) { setError('Code must be 3-5 uppercase letters.'); return }
    setBusy(true)
    try {
      await addUnit(parentId, { name: unitName.trim(), code: unitCode, path: unitPath.trim(), description: unitDesc.trim() })
      invalidateAll()
      setPostOp({ type: 'added', unitName: unitName.trim(), parentName: pName, parentPath: pPath })
      setAddMode(null)
      setUnitName(''); setUnitCode(''); setUnitPath(''); setUnitDesc('')
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed') }
    finally { setBusy(false) }
  }

  const handleAttachExisting = async () => {
    if (!selectedExisting) return
    setBusy(true)
    setError('')
    try {
      const attached = await attachUnit(parentId, selectedExisting)
      invalidateAll()
      setPostOp({ type: 'added', unitName: attached.unitName || attached.name, parentName: pName, parentPath: pPath })
      setAddMode(null)
      setSelectedExisting('')
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed') }
    finally { setBusy(false) }
  }

  const handleDetach = async () => {
    if (!confirmDetach) return
    setBusy(true)
    try {
      await detachUnit(parentId, confirmDetach.id)
      invalidateAll()
      setPostOp({ type: 'detached', unitName: confirmDetach.unitName || confirmDetach.name, parentName: pName, parentPath: pPath })
      setConfirmDetach(null)
    } catch { /* ignore */ }
    finally { setBusy(false) }
  }

  const buildPrompt = (op: NonNullable<PostOpAction>) => {
    if (op.type === 'added') {
      return `The module "${op.unitName}" was just added to the ${op.parentName} multi-module project. Review and update the CLAUDE.md files:\n- Orchestrator: ${op.parentPath}/CLAUDE.md\n- New module and all sibling modules\n\nEnsure the orchestrator's unit table is current, and that the new module's CLAUDE.md describes how it integrates with the other modules, what interfaces it exposes, and what contracts it should respect.`
    }
    return `The module "${op.unitName}" was just detached from the ${op.parentName} multi-module project and is now independent. Review and update the CLAUDE.md files:\n- Orchestrator: ${op.parentPath}/CLAUDE.md — remove the detached module from the unit table\n- Remaining sibling modules — remove references to the detached module`
  }

  if (isLoading) return <div className="p-4 text-sm text-gray-500">Loading units...</div>

  return (
    <div className="space-y-3">
      {/* Parent hero for unit cards */}
      {showParentHero && parentProject && (
        <button
          onClick={() => { setActiveProjectId(parentProject.id); const el = document.querySelector(`[data-project-id="${parentProject.id}"]`); el?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }}
          className="w-full rounded-lg border border-purple-700/40 bg-purple-900/10 px-3 py-2 flex items-center gap-2 text-left hover:bg-purple-900/20 transition-colors"
        >
          <svg className="w-4 h-4 text-purple-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 7.125C2.25 6.504 2.754 6 3.375 6h6c.621 0 1.125.504 1.125 1.125v3.75c0 .621-.504 1.125-1.125 1.125h-6a1.125 1.125 0 0 1-1.125-1.125v-3.75ZM14.25 8.625c0-.621.504-1.125 1.125-1.125h5.25c.621 0 1.125.504 1.125 1.125v8.25c0 .621-.504 1.125-1.125 1.125h-5.25a1.125 1.125 0 0 1-1.125-1.125v-8.25ZM3.75 16.125c0-.621.504-1.125 1.125-1.125h5.25c.621 0 1.125.504 1.125 1.125v2.25c0 .621-.504 1.125-1.125 1.125h-5.25a1.125 1.125 0 0 1-1.125-1.125v-2.25Z" />
          </svg>
          <div>
            <p className="text-xs font-semibold text-purple-300">{parentProject.name}</p>
            <p className="text-[10px] text-purple-400/60">Orchestrator — click to select</p>
          </div>
        </button>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Units ({units.length})</h3>
        <button onClick={() => setAddMode('chooser')} className="text-[10px] text-indigo-400 hover:text-indigo-300 font-medium">+ Add Unit</button>
      </div>

      {/* Add chooser modal */}
      {addMode === 'chooser' && (
        <div className="rounded-lg border border-gray-700 bg-gray-900/50 p-3 space-y-2">
          <p className="text-xs text-gray-400">How would you like to add a unit?</p>
          <div className="flex gap-2">
            <button onClick={() => setAddMode('new')} className="flex-1 rounded border border-gray-600 bg-gray-700 hover:border-indigo-500 px-3 py-2 text-xs text-gray-200 transition-colors">Create New</button>
            <button onClick={() => setAddMode('existing')} className="flex-1 rounded border border-gray-600 bg-gray-700 hover:border-indigo-500 px-3 py-2 text-xs text-gray-200 transition-colors">Attach Existing</button>
          </div>
          <button onClick={() => setAddMode(null)} className="text-[10px] text-gray-500 hover:text-gray-300">Cancel</button>
        </div>
      )}

      {/* Create new form */}
      {addMode === 'new' && (
        <div className="rounded-lg border border-gray-700 bg-gray-900/50 p-3 space-y-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-gray-400 uppercase tracking-wider">Create New Unit</span>
            <button onClick={() => setAddMode(null)} className="text-[10px] text-gray-500 hover:text-gray-300">Cancel</button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input type="text" value={unitName} onChange={e => setUnitName(e.target.value)} placeholder="Unit Name" autoFocus
              className="rounded border border-gray-600 bg-gray-700 px-2 py-1.5 text-xs text-gray-100 focus:border-indigo-500 focus:outline-none" />
            <input type="text" value={unitCode} onChange={e => setUnitCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5))} placeholder="CODE" maxLength={5}
              className="rounded border border-gray-600 bg-gray-700 px-2 py-1.5 text-xs font-mono text-gray-100 focus:border-indigo-500 focus:outline-none" />
          </div>
          <input type="text" value={unitPath} onChange={e => setUnitPath(e.target.value)} placeholder="Relative path (e.g. units/combat)"
            className="w-full rounded border border-gray-600 bg-gray-700 px-2 py-1.5 text-xs font-mono text-gray-100 focus:border-indigo-500 focus:outline-none" />
          <input type="text" value={unitDesc} onChange={e => setUnitDesc(e.target.value)} placeholder="Description (optional)"
            className="w-full rounded border border-gray-600 bg-gray-700 px-2 py-1.5 text-xs text-gray-100 focus:border-indigo-500 focus:outline-none" />
          {error && <p className="text-[10px] text-red-400">{error}</p>}
          <button onClick={handleAddNew} disabled={busy}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-[10px] font-medium px-3 py-1 rounded transition-colors">
            {busy ? 'Adding...' : 'Create & Add'}
          </button>
        </div>
      )}

      {/* Attach existing form */}
      {addMode === 'existing' && (
        <div className="rounded-lg border border-gray-700 bg-gray-900/50 p-3 space-y-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-gray-400 uppercase tracking-wider">Attach Existing Project</span>
            <button onClick={() => setAddMode(null)} className="text-[10px] text-gray-500 hover:text-gray-300">Cancel</button>
          </div>
          {eligibleProjects.length === 0 ? (
            <p className="text-xs text-gray-500">No eligible projects to attach. Projects already in a multi-module setup or orchestrators cannot be attached.</p>
          ) : (
            <>
              <select value={selectedExisting} onChange={e => setSelectedExisting(e.target.value)}
                className="w-full rounded border border-gray-600 bg-gray-700 px-2 py-1.5 text-xs text-gray-100 focus:border-indigo-500 focus:outline-none">
                <option value="">Select a project...</option>
                {eligibleProjects.map(p => (
                  <option key={p.id} value={p.id}>{p.name} ({p.code})</option>
                ))}
              </select>
              {error && <p className="text-[10px] text-red-400">{error}</p>}
              <button onClick={handleAttachExisting} disabled={busy || !selectedExisting}
                className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-[10px] font-medium px-3 py-1 rounded transition-colors">
                {busy ? 'Attaching...' : 'Attach'}
              </button>
            </>
          )}
        </div>
      )}

      {/* Units list */}
      <div className="divide-y divide-gray-800/60">
        {units.map(unit => (
          <div key={unit.id} className="flex items-center justify-between py-2">
            <div className="min-w-0">
              <button
                onClick={() => { setActiveProjectId(unit.id); const el = document.querySelector(`[data-project-id="${unit.id}"]`); el?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }}
                className="flex items-center gap-1.5 text-xs text-gray-300 hover:text-white transition-colors"
              >
                <span className="font-medium">{unit.unitName || unit.name}</span>
                <span className="font-mono text-gray-500">({unit.code})</span>
              </button>
              <p className="text-[10px] text-gray-600 font-mono">{unit.unitPath}</p>
            </div>
            <button onClick={() => setConfirmDetach(unit)} className="text-[10px] text-red-400/60 hover:text-red-400 transition-colors shrink-0">
              Remove
            </button>
          </div>
        ))}
        {units.length === 0 && <p className="text-xs text-gray-600 py-3">No units yet</p>}
      </div>

      {/* Detach confirmation modal */}
      {confirmDetach && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={() => setConfirmDetach(null)}>
          <div className="w-full max-w-sm rounded-xl bg-gray-800 border border-gray-700 p-5 space-y-3" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-white">Remove module?</h3>
            <p className="text-xs text-gray-400">
              <span className="text-gray-200 font-medium">{confirmDetach.unitName || confirmDetach.name}</span> will be detached from{' '}
              <span className="text-gray-200 font-medium">{pName}</span> and become an independent project.
              It will remain on the dashboard. Archive it separately if you want it removed.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDetach(null)} className="text-xs text-gray-400 hover:text-white px-3 py-1.5 rounded transition-colors">Cancel</button>
              <button onClick={handleDetach} disabled={busy}
                className="bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors">
                {busy ? 'Detaching...' : 'Detach'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Post-operation prompt modal */}
      {postOp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={() => setPostOp(null)}>
          <div className="w-full max-w-md rounded-xl bg-gray-800 border border-gray-700 p-5 space-y-3" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-white">
              {postOp.type === 'added' ? 'Module added' : 'Module detached'}
            </h3>
            <p className="text-xs text-gray-400">
              CLAUDE.md files have been automatically updated. You can optionally send the following prompt to the orchestrator's Claude Code to refine the integration context:
            </p>
            <pre className="text-[10px] text-gray-300 bg-gray-900 border border-gray-700 rounded p-2.5 whitespace-pre-wrap max-h-32 overflow-y-auto">
              {buildPrompt(postOp)}
            </pre>
            <div className="flex justify-end gap-2">
              <button onClick={() => setPostOp(null)} className="text-xs text-gray-400 hover:text-white px-3 py-1.5 rounded transition-colors">Dismiss</button>
              <button
                onClick={() => { navigator.clipboard.writeText(buildPrompt(postOp)); setPostOp(null) }}
                className="bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors">
                Copy Prompt
              </button>
              <button
                onClick={() => {
                  // Send to orchestrator's Claude Code via WebSocket
                  // Find the orchestrator's ChatView and inject the message
                  const event = new CustomEvent('vibectl:send-to-project', { detail: { projectCode: parentId, text: buildPrompt(postOp) } })
                  window.dispatchEvent(event)
                  setPostOp(null)
                }}
                className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors">
                Send to Orchestrator
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Archive confirmation with multi-module warning ─────────────────────────

// ─── Fly.toml suggestions modal ──────────────────────────────────────────────

type SuggestionField = { key: keyof DeploymentConfig; label: string }
const SUGGESTION_FIELDS: SuggestionField[] = [
  { key: 'flyApp', label: 'Fly App' },
  { key: 'deployProd', label: 'Deploy Prod' },
  { key: 'startProd', label: 'Start Prod' },
  { key: 'restartProd', label: 'Restart Prod' },
  { key: 'viewLogs', label: 'View Logs' },
]

function FlyTomlSuggestionsModal({ appName, suggestions, current, onApply, onClose }: {
  appName: string
  suggestions: Partial<DeploymentConfig>
  current: DeploymentConfig
  onApply: (accepted: Partial<DeploymentConfig>) => void
  onClose: () => void
}) {
  const [accepted, setAccepted] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {}
    for (const f of SUGGESTION_FIELDS) {
      const suggested = suggestions[f.key] as string | undefined
      const currentVal = current[f.key] as string | undefined
      // Only auto-check if current field is blank and there's a suggestion
      if (suggested && !currentVal) init[f.key] = true
    }
    return init
  })

  const toggle = (key: string) => setAccepted(prev => ({ ...prev, [key]: !prev[key] }))

  const handleApply = () => {
    const result: Partial<DeploymentConfig> = {}
    for (const f of SUGGESTION_FIELDS) {
      if (accepted[f.key]) {
        (result as Record<string, string>)[f.key] = suggestions[f.key] as string
      }
    }
    onApply(result)
  }

  const acceptedCount = Object.values(accepted).filter(Boolean).length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl bg-gray-800 shadow-2xl border border-gray-700" onClick={e => e.stopPropagation()}>
        <div className="px-6 pt-5 pb-3">
          <h3 className="text-sm font-semibold text-white mb-1">fly.toml detected: <span className="font-mono text-indigo-300">{appName}</span></h3>
          <p className="text-xs text-gray-400">Select which suggestions to apply. You'll still need to Save to persist changes.</p>
        </div>

        <div className="px-6 pb-4">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 uppercase tracking-wider border-b border-gray-700">
                <th className="py-1.5 text-left w-8"></th>
                <th className="py-1.5 text-left">Field</th>
                <th className="py-1.5 text-left">Current</th>
                <th className="py-1.5 text-left">Suggested</th>
              </tr>
            </thead>
            <tbody>
              {SUGGESTION_FIELDS.map(f => {
                const suggested = suggestions[f.key] as string | undefined
                const currentVal = current[f.key] as string | undefined
                const hasSuggestion = !!suggested
                const isDifferent = suggested !== currentVal
                const isChecked = !!accepted[f.key]

                return (
                  <tr key={f.key} className="border-b border-gray-800/50">
                    <td className="py-2">
                      {hasSuggestion && isDifferent ? (
                        <input type="checkbox" checked={isChecked} onChange={() => toggle(f.key)}
                          className="rounded border-gray-600 bg-gray-700 text-indigo-500 focus:ring-indigo-500 w-3.5 h-3.5" />
                      ) : hasSuggestion && !isDifferent ? (
                        <span className="text-green-500 text-[10px]">✓</span>
                      ) : null}
                    </td>
                    <td className="py-2 text-gray-400 font-medium">{f.label}</td>
                    <td className="py-2 font-mono text-gray-500 max-w-[140px] truncate" title={currentVal || ''}>
                      {currentVal || <span className="text-gray-700 italic">not set</span>}
                    </td>
                    <td className={`py-2 font-mono max-w-[140px] truncate ${hasSuggestion && isDifferent ? 'text-indigo-300' : 'text-gray-600'}`} title={suggested || ''}>
                      {hasSuggestion ? suggested : <span className="text-gray-700">—</span>}
                      {hasSuggestion && !isDifferent && <span className="ml-1 text-[9px] text-green-500/70">same</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="flex justify-end gap-2 px-6 pb-5">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-xs text-gray-400 hover:text-gray-200 transition-colors">
            Cancel
          </button>
          <button onClick={handleApply} disabled={acceptedCount === 0}
            className="rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-4 py-2 text-xs font-medium text-white transition-colors">
            Apply {acceptedCount > 0 ? `(${acceptedCount})` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}

function ArchiveConfirmModal({ project, onCancel, onConfirm }: {
  project: Project; onCancel: () => void; onConfirm: () => void
}) {
  const isMulti = project.projectType === 'multi'
  const { data: units = [] } = useQuery({
    queryKey: ['units', project.id],
    queryFn: () => listUnits(project.id),
    enabled: isMulti,
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-sm rounded-xl bg-gray-800 shadow-2xl border border-gray-700">
        <div className="px-6 py-5">
          <h3 className="text-sm font-semibold text-white mb-2">Archive project?</h3>
          <p className="text-xs text-gray-400">
            <span className="text-gray-200 font-medium">{project.name}</span> will be archived and hidden from the dashboard.
            It can be restored later from the archived projects list.
          </p>
          {isMulti && units.length > 0 && (
            <div className="mt-3 rounded-lg border border-amber-700/50 bg-amber-900/10 px-3 py-2">
              <p className="text-xs text-amber-300 font-medium mb-1">This will also archive {units.length} module{units.length > 1 ? 's' : ''}:</p>
              <ul className="text-[10px] text-amber-200/70 space-y-0.5">
                {units.map(u => (
                  <li key={u.id}>{u.unitName || u.name} ({u.code})</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 px-6 pb-5">
          <button onClick={onCancel} className="rounded-lg px-4 py-2 text-xs text-gray-400 hover:text-gray-200 transition-colors">
            Cancel
          </button>
          <button onClick={onConfirm} className="rounded-lg bg-red-700 hover:bg-red-600 px-4 py-2 text-xs font-medium text-white transition-colors">
            Archive{isMulti && units.length > 0 ? ` (${units.length + 1} projects)` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
