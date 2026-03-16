import type { SessionLog } from '../../types'

interface SessionBannerProps {
  session: SessionLog
}

export default function SessionBanner({ session }: SessionBannerProps) {
  if (!session.summary) return null

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-t-lg px-4 py-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-medium text-gray-400">Last Session Summary</span>
        <span className="text-xs text-gray-500">
          {new Date(session.startedAt).toLocaleDateString()}
        </span>
        {session.issuesWorkedOn?.length > 0 && (
          <span className="text-xs text-indigo-400">
            Issues: {session.issuesWorkedOn.join(', ')}
          </span>
        )}
      </div>
      <p className="text-sm text-gray-300">{session.summary}</p>
    </div>
  )
}
