import { useState, useEffect, useCallback } from 'react'

/**
 * RebuildOverlay listens for 'server_restarting' events (set globally by WS handlers)
 * and shows a full-screen overlay while the server rebuilds. Polls /healthz until it's back.
 */

// Global flag that any WS handler can set
let rebuildListeners: Array<(restarting: boolean) => void> = []

export function notifyServerRestarting() {
  rebuildListeners.forEach(fn => fn(true))
}

export default function RebuildOverlay() {
  const [restarting, setRestarting] = useState(false)
  const [dots, setDots] = useState('')
  const [phase, setPhase] = useState<'building' | 'restarting' | 'reconnecting'>('building')

  // Register as a listener
  useEffect(() => {
    const handler = (val: boolean) => setRestarting(val)
    rebuildListeners.push(handler)
    return () => {
      rebuildListeners = rebuildListeners.filter(fn => fn !== handler)
    }
  }, [])

  // Animate dots
  useEffect(() => {
    if (!restarting) return
    const interval = setInterval(() => {
      setDots(d => d.length >= 3 ? '' : d + '.')
    }, 500)
    return () => clearInterval(interval)
  }, [restarting])

  // Poll healthz to detect when server has restarted.
  // We use the 'uptime' field: after syscall.Exec the new process has a lower
  // uptime than the one we recorded before triggering the rebuild.
  const pollServer = useCallback(async () => {
    setPhase('restarting')

    // Snapshot the current uptime so we can detect when the process restarts.
    let uptimeBefore = Infinity
    try {
      const res = await fetch('/healthz', { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        const data = await res.json()
        uptimeBefore = typeof data.uptime === 'number' ? data.uptime : Infinity
      }
    } catch { /* server already down — any successful response means restart */ }

    setPhase('reconnecting')

    // Poll until the server is up with a lower uptime (restarted) or after seeing it go down.
    const maxAttempts = 120 // 60 seconds
    let seenDown = false
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const res = await fetch('/healthz', { signal: AbortSignal.timeout(2000) })
        if (res.ok) {
          const data = await res.json()
          const uptimeNow = typeof data.uptime === 'number' ? data.uptime : Infinity
          // Restart detected if: we saw it go down, OR uptime reset to below pre-rebuild value
          if (seenDown || uptimeNow < uptimeBefore) {
            setRestarting(false)
            window.location.reload()
            return
          }
        } else {
          seenDown = true
        }
      } catch {
        seenDown = true
      }
      await new Promise(r => setTimeout(r, 500))
    }

    // Timed out — dismiss overlay so user isn't stuck
    setRestarting(false)
  }, [])

  useEffect(() => {
    if (restarting) {
      setPhase('building')
      pollServer()
    }
  }, [restarting, pollServer])

  if (!restarting) return null

  const phaseText = {
    building: 'Building',
    restarting: 'Restarting server',
    reconnecting: 'Reconnecting',
  }[phase]

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-gray-950/90 backdrop-blur-sm">
      <div className="text-center space-y-4">
        {/* Spinning logo / icon */}
        <div className="flex justify-center">
          <svg className="w-12 h-12 text-indigo-400 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        <div className="space-y-1">
          <p className="text-lg font-medium text-white">
            VibeCtl is rebuilding
          </p>
          <p className="text-sm text-gray-400 font-mono">
            {phaseText}{dots}
          </p>
        </div>

        <p className="text-xs text-gray-600 max-w-xs mx-auto">
          The server is being rebuilt and restarted. This page will automatically reconnect when ready.
        </p>

        <button
          onClick={() => setRestarting(false)}
          className="text-xs text-gray-600 hover:text-gray-400 underline transition-colors"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
