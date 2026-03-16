import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { runHealthCheck, getHealthHistory } from '../../api/client';
import type { Project, HealthCheckResult, HealthRecord, HealthKPI } from '../../types';

interface HealthChecksTabProps {
  project: Project;
}

function HealthChecksTab({ project }: HealthChecksTabProps) {
  const [polling, setPolling] = useState(true);

  const monitorEnv = project.healthCheck?.monitorEnv;
  const isConfigured = !!monitorEnv;

  const {
    data: results,
    isLoading,
    error,
    dataUpdatedAt,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['healthcheck', project.id],
    queryFn: () => runHealthCheck(project.id),
    enabled: isConfigured,
    refetchInterval: polling ? 30_000 : false,
  });

  const { data: history } = useQuery({
    queryKey: ['healthHistory', project.id],
    queryFn: () => getHealthHistory(project.id),
    enabled: isConfigured,
    refetchInterval: 10 * 60 * 1000, // refresh every 10 minutes
  });

  if (!isConfigured) {
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-800 p-8 text-center text-gray-400">
        <p className="mb-2">Health checks are not configured.</p>
        <p className="text-sm">
          Go to the <span className="font-medium text-indigo-400">Settings</span> tab to configure
          health check URLs and select a monitoring environment.
        </p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(2)].map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-lg bg-gray-800" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded bg-red-900/30 p-4 text-red-400">
        Failed to run health checks: {(error as Error).message}
      </div>
    );
  }

  // Shorten long endpoint labels for compact display
  const displayName = (name: string) =>
    name === 'Frontend' ? 'Front' : name === 'Backend' ? 'Back' : name;

  const statusIcon = (status: string) => {
    if (status === 'up') {
      return (
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-green-600/20">
          <svg className="h-5 w-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </span>
      );
    }
    if (status === 'degraded') {
      return (
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-yellow-600/20">
          <svg className="h-5 w-5 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
        </span>
      );
    }
    return (
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-red-600/20">
        <svg className="h-5 w-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </span>
    );
  };

  // Detect KPIs that are identical (same name + same value) across all results that have KPIs.
  // These are hoisted to a shared section to avoid showing duplicate data on every card.
  const resultsWithKPIs = (results || []).filter((r: HealthCheckResult) => r.kpis && r.kpis.length > 0);
  const sharedKPINames = new Set<string>();
  const sharedKPIs: HealthKPI[] = [];
  if (resultsWithKPIs.length >= 2) {
    for (const kpi of resultsWithKPIs[0].kpis!) {
      const allMatch = resultsWithKPIs.every((r: HealthCheckResult) => {
        const match = r.kpis!.find((k) => k.name === kpi.name);
        return match !== undefined && match.value === kpi.value;
      });
      if (allMatch) {
        sharedKPIs.push(kpi);
        sharedKPINames.add(kpi.name);
      }
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-gray-300">
            Monitoring: <span className="text-white font-semibold uppercase">{monitorEnv}</span>
          </h3>
          {isFetching && (
            <span className="text-xs text-gray-500 animate-pulse">checking...</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setPolling(!polling)}
            className={`text-xs px-2.5 py-1 rounded transition-colors ${
              polling
                ? 'bg-green-600/20 text-green-400'
                : 'bg-gray-700 text-gray-400'
            }`}
          >
            {polling ? 'Auto-refresh on' : 'Auto-refresh off'}
          </button>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="text-xs px-2.5 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50 transition-colors"
          >
            Check now
          </button>
        </div>
      </div>

      {/* Results */}
      {results && results.length > 0 ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {results.map((r: HealthCheckResult) => {
              const cardKPIs = (r.kpis || []).filter((k) => !sharedKPINames.has(k.name));
              return (
                <div
                  key={r.name}
                  className={`rounded-lg border p-4 ${
                    r.status === 'up'
                      ? 'border-green-800/50 bg-green-900/10'
                      : r.status === 'degraded'
                        ? 'border-yellow-800/50 bg-yellow-900/10'
                        : 'border-red-800/50 bg-red-900/10'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {statusIcon(r.status)}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-white">{displayName(r.name)}</p>
                      <p className="truncate text-xs text-gray-400">{r.url}</p>
                    </div>
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-mono font-medium ${
                        r.status === 'up'
                          ? 'bg-green-600/20 text-green-400'
                          : r.status === 'degraded'
                            ? 'bg-yellow-600/20 text-yellow-400'
                            : 'bg-red-600/20 text-red-400'
                      }`}
                    >
                      {r.status === 'up' ? `${r.code}` : r.status === 'degraded' ? `${r.code}` : 'DOWN'}
                    </span>
                  </div>
                  {r.error && (
                    <p className={`mt-2 rounded px-2 py-1 text-xs break-all ${
                      r.status === 'degraded'
                        ? 'bg-yellow-900/20 text-yellow-500'
                        : 'bg-red-900/20 text-red-400'
                    }`}>
                      {r.error}
                    </p>
                  )}
                  {/* Per-endpoint KPIs (shared ones shown below) */}
                  {cardKPIs.length > 0 && (
                    <div className="mt-3 grid grid-cols-3 gap-1.5">
                      {cardKPIs.map((kpi) => (
                        <div key={kpi.name} className="rounded bg-gray-900/50 px-2 py-1 text-center">
                          <div className="text-sm font-semibold text-white tabular-nums">
                            {kpi.value % 1 === 0 ? kpi.value.toFixed(0) : kpi.value.toFixed(1)}
                          </div>
                          <div className="text-[10px] text-gray-500 truncate">{kpi.name.replace(/_/g, ' ')}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Software name + version */}
                  {(r.softwareName || r.version) && (
                    <div className="mt-2 flex items-center gap-1.5">
                      {r.softwareName && (
                        <span className="text-[11px] font-medium text-gray-400">{r.softwareName}</span>
                      )}
                      {r.version && (
                        <span className="text-[10px] font-mono text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded">
                          v{r.version}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Shared metrics (same value reported by all endpoints — shown once) */}
          {sharedKPIs.length > 0 && (
            <div className="rounded-lg border border-gray-700 bg-gray-800/50 px-4 py-3">
              <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-gray-500">Metrics</p>
              <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
                {sharedKPIs.map((kpi) => (
                  <div key={kpi.name} className="rounded bg-gray-900/50 px-2 py-1 text-center">
                    <div className="text-sm font-semibold text-white tabular-nums">
                      {kpi.value % 1 === 0 ? kpi.value.toFixed(0) : kpi.value.toFixed(1)}
                    </div>
                    <div className="text-[10px] text-gray-500 truncate">{kpi.name.replace(/_/g, ' ')}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-gray-700 bg-gray-800 p-6 text-center text-gray-400 text-sm">
          No endpoints configured for the <span className="font-semibold">{monitorEnv}</span> environment.
          Add URLs in Settings.
        </div>
      )}

      {/* Uptime Timeline (last 24 hours) */}
      {history && history.length > 0 && <UptimeTimeline history={history} />}

      {/* Last checked */}
      {dataUpdatedAt > 0 && (
        <p className="text-xs text-gray-500 text-right">
          Last checked: {new Date(dataUpdatedAt).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}

function UptimeTimeline({ history }: { history: HealthRecord[] }) {
  // Collect all unique endpoint names from history
  const endpointNames = Array.from(
    new Set(history.flatMap((r) => r.results.map((res) => res.name)))
  );

  // Compute overall uptime percentage per endpoint
  const uptimeByEndpoint: Record<string, { up: number; total: number }> = {};
  for (const name of endpointNames) {
    uptimeByEndpoint[name] = { up: 0, total: 0 };
  }
  for (const record of history) {
    for (const res of record.results) {
      if (uptimeByEndpoint[res.name]) {
        uptimeByEndpoint[res.name].total++;
        if (res.status === 'up') {
          uptimeByEndpoint[res.name].up++;
        }
      }
    }
  }

  // Get the status color for a single check
  const getStatusColor = (record: HealthRecord, endpointName: string): string => {
    const res = record.results.find((r) => r.name === endpointName);
    if (!res) return 'bg-gray-700'; // no data
    if (res.status === 'up') return 'bg-green-500';
    if (res.status === 'down') return 'bg-red-500';
    return 'bg-yellow-500';
  };

  const formatTime = (dateStr: string) => {
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-800 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-gray-300">Uptime (last 24 hours)</h4>
        <span className="text-xs text-gray-500">{history.length} checks recorded</span>
      </div>

      <div className={`grid gap-4 ${endpointNames.length >= 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {endpointNames.map((name) => {
          const stats = uptimeByEndpoint[name];
          const pct = stats.total > 0 ? ((stats.up / stats.total) * 100).toFixed(1) : '—';
          return (
            <div key={name} className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-gray-400">{name === 'Frontend' ? 'Front' : name === 'Backend' ? 'Back' : name}</span>
                <span
                  className={`text-xs font-mono font-medium ${
                    pct === '100.0'
                      ? 'text-green-400'
                      : pct === '—'
                        ? 'text-gray-500'
                        : Number(pct) >= 99
                          ? 'text-yellow-400'
                          : 'text-red-400'
                  }`}
                >
                  {pct}%
                </span>
              </div>
              <div className="flex gap-px" title={`${history.length} checks`}>
                {history.map((record) => (
                  <div
                    key={record.id}
                    className={`h-5 flex-1 rounded-sm ${getStatusColor(record, name)} opacity-80 hover:opacity-100 transition-opacity cursor-default`}
                    title={`${formatTime(record.checkedAt)}: ${
                      record.results.find((r) => r.name === name)?.status ?? 'no data'
                    }`}
                  />
                ))}
              </div>
              <div className="flex justify-between text-[10px] text-gray-600">
                <span>{formatTime(history[0].checkedAt)}</span>
                <span>{formatTime(history[history.length - 1].checkedAt)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default HealthChecksTab;
