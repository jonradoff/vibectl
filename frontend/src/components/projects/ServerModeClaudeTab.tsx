import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMode } from '../../contexts/ModeContext'

const REPO_URL = 'https://github.com/jonradoff/vibectl'

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      onClick={copy}
      className="shrink-0 text-[10px] text-gray-500 hover:text-gray-300 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded px-1.5 py-0.5 transition-colors"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  )
}


const DEFAULT_CLIENT_PORT = 4385

export default function ServerModeClaudeTab() {
  const { mode } = useMode()
  const serverURL = mode?.baseURL ?? window.location.origin

  const oneliner = `git clone ${REPO_URL} vibectl && cd vibectl && make setup-client SERVER_URL=${serverURL} API_KEY=YOUR_API_KEY PORT=${DEFAULT_CLIENT_PORT} && make client`

  return (
    <div className="flex flex-col h-full overflow-y-auto p-5 space-y-5">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <svg className="w-4 h-4 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m6.75 7.5 3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z" />
          </svg>
          <h3 className="text-sm font-semibold text-white">Claude Code — Local Setup Required</h3>
        </div>
        <p className="text-xs text-gray-400">
          Claude Code sessions run on your <strong className="text-gray-300">local machine</strong>, not on the production server.
          Set up a local VibeCtl instance that connects here and you'll have full Claude Code access for your projects.
        </p>
      </div>

      {/* Step 1: API key */}
      <div className="rounded-lg border border-gray-700 bg-gray-900 p-4 space-y-2">
        <p className="text-xs font-medium text-white">Step 1 — Get an API key</p>
        <p className="text-xs text-gray-400">
          Go to{' '}
          <Link to="/api-keys" className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2">
            API Keys
          </Link>{' '}
          and create a key. Copy it — you'll need it below.
        </p>
      </div>

      {/* Step 2: Clone + configure */}
      <div className="rounded-lg border border-gray-700 bg-gray-900 p-4 space-y-3">
        <p className="text-xs font-medium text-white">Step 2 — Clone &amp; run</p>
        <p className="text-xs text-gray-400">Run this on your local machine (replace the API key):</p>
        <div className="flex items-start justify-between gap-2 rounded bg-gray-950 border border-gray-800 p-3">
          <code className="text-green-300 text-[11px] font-mono break-all leading-relaxed">{oneliner}</code>
          <CopyButton text={oneliner} />
        </div>
      </div>

      {/* Step 3: Open local UI */}
      <div className="rounded-lg border border-gray-700 bg-gray-900 p-4 space-y-2">
        <p className="text-xs font-medium text-white">Step 3 — Open your local instance</p>
        <p className="text-xs text-gray-400">
          Once running, open{' '}
          <code className="text-indigo-300 text-[11px]">http://localhost:{DEFAULT_CLIENT_PORT}</code>{' '}
          in your browser. Log in and you'll see this server's projects with full Claude Code access.
        </p>
      </div>

      {/* Footer */}
      <p className="text-[10px] text-gray-600">
        Server: <span className="font-mono">{serverURL}</span> · Repo: <span className="font-mono">{REPO_URL}</span>
      </p>
    </div>
  )
}
