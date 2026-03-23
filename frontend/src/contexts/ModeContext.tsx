import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { getModeInfo, pingRemote } from '../api/client';
import type { ModeInfo, DisplayMode } from '../types';

interface ModeContextValue {
  mode: ModeInfo | null;
  displayMode: DisplayMode;
  isClientMode: boolean;
  isConfigured: boolean;     // false only when client mode has no REMOTE_SERVER_URL
  remoteReachable: boolean;  // meaningful only in client mode
  loading: boolean;
}

const ModeContext = createContext<ModeContextValue>({
  mode: null,
  displayMode: 'dev-standalone',
  isClientMode: false,
  isConfigured: true,
  remoteReachable: true,
  loading: true,
});

function deriveDisplayMode(info: ModeInfo): DisplayMode {
  if (info.mode === 'client') return 'client';
  // Standalone: distinguish production server from local dev by BASE_URL
  const base = info.baseURL ?? '';
  const isLocal = base.includes('localhost') || base.includes('127.0.0.1') || base === '';
  return isLocal ? 'dev-standalone' : 'server';
}

export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ModeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [remoteReachable, setRemoteReachable] = useState(true);

  useEffect(() => {
    getModeInfo()
      .then(setMode)
      .catch(() => setMode({ mode: 'standalone', version: '' }))
      .finally(() => setLoading(false));
  }, []);

  const checkReachability = useCallback(async () => {
    try {
      const result = await pingRemote();
      setRemoteReachable(result.reachable);
    } catch {
      setRemoteReachable(false);
    }
  }, []);

  // In client mode, poll remote reachability every 30s.
  useEffect(() => {
    if (!mode || mode.mode !== 'client' || !mode.remoteServerURL) return;
    checkReachability();
    const interval = setInterval(checkReachability, 30_000);
    return () => clearInterval(interval);
  }, [mode, checkReachability]);

  const isClientMode = mode?.mode === 'client';
  const isConfigured = !isClientMode || !!mode?.remoteServerURL;
  const displayMode: DisplayMode = mode ? deriveDisplayMode(mode) : 'dev-standalone';

  return (
    <ModeContext.Provider value={{
      mode,
      displayMode,
      isClientMode,
      isConfigured,
      remoteReachable,
      loading,
    }}>
      {children}
    </ModeContext.Provider>
  );
}

export function useMode() {
  return useContext(ModeContext);
}
