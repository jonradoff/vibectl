import { useMode } from '../../contexts/ModeContext';

export function ModeIndicator() {
  const { displayMode, mode, remoteReachable } = useMode();

  if (displayMode === 'dev-standalone') {
    return (
      <div className="mt-2 px-1">
        <span className="text-xs text-gray-500 font-medium">Dev Standalone</span>
      </div>
    );
  }

  if (displayMode === 'server') {
    const url = mode?.baseURL ?? '';
    return (
      <div className="mt-2 px-1">
        <div className="text-xs text-indigo-400 font-medium">Server</div>
        {url && (
          <div className="text-xs text-gray-500 truncate" title={url}>{url}</div>
        )}
      </div>
    );
  }

  if (displayMode === 'client') {
    const url = mode?.remoteServerURL ?? '';
    return (
      <div className="mt-2 px-1">
        <div className="flex items-center gap-1.5">
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${remoteReachable ? 'bg-green-400' : 'bg-red-500'}`}
            title={remoteReachable ? 'Remote reachable' : 'Remote unreachable'}
          />
          <span className="text-xs text-indigo-400 font-medium">Client</span>
        </div>
        {url && (
          <div className="text-xs text-gray-500 truncate" title={url}>{url}</div>
        )}
      </div>
    );
  }

  return null;
}
