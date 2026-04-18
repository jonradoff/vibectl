import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { listIssues, listArchivedIssues, restoreIssue, permanentDeleteIssue, updateIssue, deleteIssue } from '../../api/client';
import type { IssueType, Priority, Issue } from '../../types';
import { priorityColors, typeColors } from '../../types';
import StatusBadge from './StatusBadge';

interface IssueTableProps {
  projectCode: string;
  projectCode: string;
}

type SortField = 'issueKey' | 'title' | 'type' | 'priority' | 'status' | 'dueDate' | 'createdAt';
type SortDir = 'asc' | 'desc';
type ViewTab = 'active' | 'archived';

const priorityOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, P5: 5 };

function IssueTable({ projectCode, projectCode }: IssueTableProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [viewTab, setViewTab] = useState<ViewTab>('active');

  const { data: issues, isLoading, error } = useQuery({
    queryKey: ['issues', projectId],
    queryFn: () => listIssues(projectId),
  });

  const { data: archivedIssues, isLoading: archivedLoading } = useQuery({
    queryKey: ['issues-archived', projectId],
    queryFn: () => listArchivedIssues(projectId),
    enabled: viewTab === 'archived',
  });

  const [filterType, setFilterType] = useState<string>('all');
  const [filterPriority, setFilterPriority] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [sortField, setSortField] = useState<SortField>('createdAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Bulk selection state
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const sortIndicator = (field: SortField) => {
    if (sortField !== field) return null;
    return <span className="ml-1">{sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>;
  };

  const toggleSelect = (issueKey: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(issueKey)) next.delete(issueKey);
      else next.add(issueKey);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedKeys.size === filtered.length) {
      setSelectedKeys(new Set());
    } else {
      setSelectedKeys(new Set(filtered.map((i) => i.issueKey)));
    }
  };

  const handleBulkPriority = async (priority: Priority) => {
    setBulkLoading(true);
    try {
      await Promise.all([...selectedKeys].map((k) => updateIssue(k, { priority })));
      queryClient.invalidateQueries({ queryKey: ['issues', projectId] });
      setSelectedKeys(new Set());
    } finally {
      setBulkLoading(false);
    }
  };

  const handleBulkArchive = async () => {
    setBulkLoading(true);
    try {
      await Promise.all([...selectedKeys].map((k) => deleteIssue(k)));
      queryClient.invalidateQueries({ queryKey: ['issues', projectId] });
      queryClient.invalidateQueries({ queryKey: ['issues-archived', projectId] });
      setSelectedKeys(new Set());
    } finally {
      setBulkLoading(false);
    }
  };

  const filtered = useMemo(() => {
    if (!issues) return [];
    let result = [...issues];

    if (filterType !== 'all') result = result.filter((i) => i.type === filterType);
    if (filterPriority !== 'all') result = result.filter((i) => i.priority === filterPriority);
    if (filterStatus !== 'all') result = result.filter((i) => i.status === filterStatus);

    result.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'issueKey':
          cmp = a.number - b.number;
          break;
        case 'title':
          cmp = a.title.localeCompare(b.title);
          break;
        case 'type':
          cmp = a.type.localeCompare(b.type);
          break;
        case 'priority':
          cmp = (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9);
          break;
        case 'status':
          cmp = a.status.localeCompare(b.status);
          break;
        case 'dueDate':
          cmp = (a.dueDate ?? '').localeCompare(b.dueDate ?? '');
          break;
        case 'createdAt':
          cmp = a.createdAt.localeCompare(b.createdAt);
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return result;
  }, [issues, filterType, filterPriority, filterStatus, sortField, sortDir]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-12 animate-pulse rounded bg-gray-700" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded bg-red-900/30 p-4 text-red-400">
        Failed to load issues: {(error as Error).message}
      </div>
    );
  }

  const statuses = Array.from(new Set(issues?.map((i) => i.status) ?? []));
  const archivedCount = archivedIssues?.length ?? 0;

  return (
    <div>
      {/* View tabs */}
      <div className="mb-4 flex items-center gap-4 border-b border-gray-700 pb-3">
        <button
          onClick={() => setViewTab('active')}
          className={`text-sm font-medium transition-colors ${
            viewTab === 'active' ? 'text-white' : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          Active Issues
        </button>
        <button
          onClick={() => setViewTab('archived')}
          className={`text-sm font-medium transition-colors ${
            viewTab === 'archived' ? 'text-white' : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          Archived
          {viewTab === 'archived' && archivedCount > 0 && (
            <span className="ml-1.5 rounded-full bg-gray-700 px-1.5 py-0.5 text-xs text-gray-400">
              {archivedCount}
            </span>
          )}
        </button>
      </div>

      {viewTab === 'active' ? (
        <>
          {/* Filter bar */}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="rounded border border-gray-600 bg-gray-700 px-3 py-1.5 text-sm text-gray-200"
            >
              <option value="all">All Types</option>
              <option value="bug">Bug</option>
              <option value="feature">Feature</option>
              <option value="idea">Idea</option>
            </select>

            <select
              value={filterPriority}
              onChange={(e) => setFilterPriority(e.target.value)}
              className="rounded border border-gray-600 bg-gray-700 px-3 py-1.5 text-sm text-gray-200"
            >
              <option value="all">All Priorities</option>
              {(['P0', 'P1', 'P2', 'P3', 'P4', 'P5'] as Priority[]).map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>

            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="rounded border border-gray-600 bg-gray-700 px-3 py-1.5 text-sm text-gray-200"
            >
              <option value="all">All Statuses</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                </option>
              ))}
            </select>

            <div className="ml-auto">
              <Link
                to={`/projects/${projectCode}/issues/new`}
                className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
              >
                New Issue
              </Link>
            </div>
          </div>

          {/* Bulk action toolbar */}
          {selectedKeys.size > 0 && (
            <div className="mb-3 flex items-center gap-3 rounded-lg border border-indigo-700/50 bg-indigo-900/20 px-4 py-2.5">
              <span className="text-sm font-medium text-indigo-300">
                {selectedKeys.size} {selectedKeys.size === 1 ? 'issue' : 'issues'} selected
              </span>
              <span className="text-gray-600">|</span>
              <span className="text-xs text-gray-400">Change priority:</span>
              {(['P0', 'P1', 'P2', 'P3', 'P4', 'P5'] as Priority[]).map((p) => (
                <button
                  key={p}
                  onClick={() => handleBulkPriority(p)}
                  disabled={bulkLoading}
                  className={`rounded px-2 py-0.5 text-xs font-bold ${priorityColors[p]} opacity-80 hover:opacity-100 disabled:opacity-40`}
                >
                  {p}
                </button>
              ))}
              <span className="text-gray-600">|</span>
              <button
                onClick={handleBulkArchive}
                disabled={bulkLoading}
                className="rounded bg-red-900/40 border border-red-800/50 px-3 py-1 text-xs font-medium text-red-400 hover:bg-red-900/60 disabled:opacity-40"
              >
                {bulkLoading ? '...' : 'Archive selected'}
              </button>
              <button
                onClick={() => setSelectedKeys(new Set())}
                className="ml-auto text-xs text-gray-500 hover:text-gray-300"
              >
                Clear
              </button>
            </div>
          )}

          {/* Table */}
          {filtered.length === 0 ? (
            <div className="rounded-lg border border-gray-700 bg-gray-800 p-8 text-center text-gray-400">
              No issues match the current filters.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-gray-700">
              <table className="w-full text-left text-sm text-gray-300">
                <thead className="border-b border-gray-700 bg-gray-800 text-xs uppercase text-gray-400">
                  <tr>
                    <th className="px-3 py-3">
                      <input
                        type="checkbox"
                        checked={filtered.length > 0 && selectedKeys.size === filtered.length}
                        onChange={toggleSelectAll}
                        className="cursor-pointer rounded border-gray-600 bg-gray-700 text-indigo-600"
                        title="Select all"
                      />
                    </th>
                    {([
                      ['issueKey', 'Key'],
                      ['title', 'Title'],
                      ['type', 'Type'],
                      ['priority', 'Priority'],
                      ['status', 'Status'],
                      ['dueDate', 'Due Date'],
                      ['createdAt', 'Created'],
                    ] as [SortField, string][]).map(([field, label]) => (
                      <th
                        key={field}
                        className="cursor-pointer px-4 py-3 hover:text-gray-200"
                        onClick={() => handleSort(field)}
                      >
                        {label}
                        {sortIndicator(field)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((issue) => (
                    <tr
                      key={issue.id}
                      className={`cursor-pointer border-b border-gray-700/50 bg-gray-800 hover:bg-gray-700/50 ${
                        selectedKeys.has(issue.issueKey) ? 'bg-indigo-900/20' : ''
                      }`}
                      onClick={() => navigate(`/projects/${projectCode}/issues/${issue.issueKey}`)}
                    >
                      <td className="px-3 py-3" onClick={(e) => toggleSelect(issue.issueKey, e)}>
                        <input
                          type="checkbox"
                          checked={selectedKeys.has(issue.issueKey)}
                          onChange={() => {}}
                          className="cursor-pointer rounded border-gray-600 bg-gray-700 text-indigo-600"
                        />
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-gray-400">
                        {issue.issueKey}
                      </td>
                      <td className="px-4 py-3 font-medium text-white">{issue.title}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded border px-2 py-0.5 text-xs font-medium ${typeColors[issue.type as IssueType] ?? ''}`}
                        >
                          {issue.type}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded px-2 py-0.5 text-xs font-medium ${priorityColors[issue.priority as Priority] ?? ''}`}
                        >
                          {issue.priority}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={issue.status} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-gray-400">
                        {issue.dueDate
                          ? new Date(issue.dueDate).toLocaleDateString()
                          : '\u2014'}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-gray-400">
                        {new Date(issue.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <ArchivedIssueList
          projectId={projectCode}
          projectCode={projectCode}
          issues={archivedIssues ?? []}
          isLoading={archivedLoading}
          onMutate={() => {
            queryClient.invalidateQueries({ queryKey: ['issues-archived', projectId] });
            queryClient.invalidateQueries({ queryKey: ['issues', projectId] });
          }}
        />
      )}
    </div>
  );
}

function ArchivedIssueList({
  projectCode,
  issues,
  isLoading,
  onMutate,
}: {
  projectCode: string;
  projectCode: string;
  issues: Issue[];
  isLoading: boolean;
  onMutate: () => void;
}) {
  const [confirmKey, setConfirmKey] = useState<string | null>(null);

  const restoreMutation = useMutation({
    mutationFn: (issueKey: string) => restoreIssue(issueKey),
    onSuccess: () => onMutate(),
  });

  const permDeleteMutation = useMutation({
    mutationFn: (issueKey: string) => permanentDeleteIssue(issueKey),
    onSuccess: () => {
      setConfirmKey(null);
      onMutate();
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-12 animate-pulse rounded bg-gray-700" />
        ))}
      </div>
    );
  }

  if (issues.length === 0) {
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-800 p-8 text-center text-gray-400">
        No archived issues.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {issues.map((issue) => (
        <div
          key={issue.id}
          className="flex items-center gap-3 rounded-lg border border-gray-700 bg-gray-800 px-4 py-3"
        >
          <span className="font-mono text-xs text-gray-500">{issue.issueKey}</span>
          <Link
            to={`/projects/${projectCode}/issues/${issue.issueKey}`}
            className="flex-1 text-sm text-gray-300 hover:text-white truncate"
          >
            {issue.title}
          </Link>
          <span
            className={`rounded border px-2 py-0.5 text-[10px] font-medium ${typeColors[issue.type as IssueType] ?? ''}`}
          >
            {issue.type}
          </span>
          <span
            className={`rounded px-2 py-0.5 text-[10px] font-medium ${priorityColors[issue.priority as Priority] ?? ''}`}
          >
            {issue.priority}
          </span>
          {issue.archivedAt && (
            <span className="text-[10px] text-gray-500">
              Archived {new Date(issue.archivedAt).toLocaleDateString()}
            </span>
          )}

          <button
            onClick={() => restoreMutation.mutate(issue.issueKey)}
            disabled={restoreMutation.isPending}
            className="rounded bg-indigo-600/80 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
          >
            Restore
          </button>

          {confirmKey === issue.issueKey ? (
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => permDeleteMutation.mutate(issue.issueKey)}
                disabled={permDeleteMutation.isPending}
                className="rounded bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
              >
                {permDeleteMutation.isPending ? '...' : 'Confirm'}
              </button>
              <button
                onClick={() => setConfirmKey(null)}
                className="text-xs text-gray-400 hover:text-gray-200 px-1"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmKey(issue.issueKey)}
              className="rounded bg-red-900/40 border border-red-800/50 px-2.5 py-1 text-xs font-medium text-red-400 hover:bg-red-900/60 transition-colors"
            >
              Delete
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export default IssueTable;
