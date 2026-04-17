import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getDelegationStatus, testDelegation, enableDelegation, disableDelegation } from '../../api/client'

export default function DelegationSection() {
  const queryClient = useQueryClient()
  const [url, setUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [testResult, setTestResult] = useState<{ valid?: boolean; userName?: string; error?: string } | null>(null)
  const [showConfig, setShowConfig] = useState(false)

  const { data: status } = useQuery({
    queryKey: ['delegationStatus'],
    queryFn: getDelegationStatus,
    refetchInterval: 30_000,
  })

  const testMutation = useMutation({
    mutationFn: () => testDelegation({ url, apiKey }),
    onSuccess: (result) => setTestResult(result),
  })

  const enableMutation = useMutation({
    mutationFn: () => enableDelegation({ url, apiKey }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['delegationStatus'] })
      setShowConfig(false)
      setUrl('')
      setApiKey('')
      setTestResult(null)
    },
  })

  const disableMutation = useMutation({
    mutationFn: disableDelegation,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['delegationStatus'] })
    },
  })

  const isActive = status?.enabled

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-4">
      <h3 className="text-sm font-semibold text-white mb-1">Delegation</h3>
      <p className="text-xs text-gray-400 mb-3">
        Connect this instance to a remote VibeCtl server. Sessions and terminals stay local; projects, issues, and feedback are managed on the remote.
      </p>

      {isActive ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${status?.healthy ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`} />
            <span className="text-xs text-gray-300">
              {status?.healthy ? 'Connected' : 'Remote unreachable'} — {status?.url}
            </span>
          </div>
          <div className="text-xs text-gray-400">
            Connected as: <span className="text-gray-200 font-medium">{status?.user}</span>
          </div>
          {status?.verifiedAt && (
            <div className="text-[10px] text-gray-500">
              Last verified: {new Date(status.verifiedAt).toLocaleString()}
            </div>
          )}
          <button
            onClick={() => disableMutation.mutate()}
            disabled={disableMutation.isPending}
            className="rounded bg-red-900/40 border border-red-800/50 px-3 py-1 text-xs font-medium text-red-400 hover:bg-red-900/60 disabled:opacity-50 transition-colors"
          >
            {disableMutation.isPending ? 'Disconnecting...' : 'Disconnect'}
          </button>
          <p className="text-[10px] text-gray-600">
            Disconnecting returns to isolated mode. Local session data is preserved. Delegated project data will no longer be visible until reconnected.
          </p>
        </div>
      ) : showConfig ? (
        <div className="space-y-3">
          <div>
            <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Remote Server URL</label>
            <input
              value={url}
              onChange={(e) => { setUrl(e.target.value); setTestResult(null) }}
              placeholder="https://vibectl.fly.dev"
              className="w-full rounded border border-gray-600 bg-gray-700 px-2 py-1 text-xs text-gray-200 focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[10px] font-medium text-gray-500 mb-0.5">API Key</label>
            <input
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setTestResult(null) }}
              placeholder="vk_..."
              type="password"
              className="w-full rounded border border-gray-600 bg-gray-700 px-2 py-1 text-xs text-gray-200 font-mono focus:border-indigo-500 focus:outline-none"
            />
          </div>

          {testResult && (
            <div className={`rounded px-3 py-2 text-xs ${testResult.valid ? 'bg-green-900/30 border border-green-700/40 text-green-300' : 'bg-red-900/30 border border-red-700/40 text-red-300'}`}>
              {testResult.valid
                ? `Connected! User: ${testResult.userName}`
                : `Failed: ${testResult.error}`}
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => testMutation.mutate()}
              disabled={!url || !apiKey || testMutation.isPending}
              className="rounded bg-gray-700 px-3 py-1 text-xs font-medium text-gray-300 hover:bg-gray-600 disabled:opacity-50 transition-colors"
            >
              {testMutation.isPending ? 'Testing...' : 'Test Connection'}
            </button>
            <button
              onClick={() => enableMutation.mutate()}
              disabled={!testResult?.valid || enableMutation.isPending}
              className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
            >
              {enableMutation.isPending ? 'Activating...' : 'Activate Delegation'}
            </button>
            <button
              onClick={() => { setShowConfig(false); setUrl(''); setApiKey(''); setTestResult(null) }}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="w-2 h-2 rounded-full bg-gray-600" />
            <span className="text-xs text-gray-400">Isolated mode — all data is local</span>
          </div>
          <button
            onClick={() => setShowConfig(true)}
            className="rounded bg-gray-700 px-3 py-1 text-xs font-medium text-gray-300 hover:bg-gray-600 transition-colors"
          >
            Connect to Remote Server
          </button>
        </div>
      )}
    </div>
  )
}
