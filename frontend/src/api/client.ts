import type {
  Project,
  Issue,
  FeedbackItem,
  SessionLog,
  ProjectSummary,
  GlobalDashboard,
  AIAnalysis,
  PMReviewResult,
  HealthCheckResult,
  HealthRecord,
  Attachment,
  ChatHistorySummary,
  ChatHistoryEntry,
  Decision,
  Prompt,
  ActivityLogResponse,
} from '../types';

const BASE = '/api/v1';

export const TOKEN_KEY = 'vibectl_token';
export const getStoredToken = () => localStorage.getItem(TOKEN_KEY);
export const setStoredToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearStoredToken = () => localStorage.removeItem(TOKEN_KEY);

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getStoredToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    headers: { ...headers, ...(options?.headers as Record<string, string>) },
    ...options,
  });
  if (!res.ok) {
    if (res.status === 401) {
      clearStoredToken();
      window.dispatchEvent(new CustomEvent('vibectl:unauthorized'));
    }
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// Projects
export const listProjects = () => request<Project[]>('/projects');
export const createProject = (data: Partial<Project>) =>
  request<Project>('/projects', { method: 'POST', body: JSON.stringify(data) });
export const getProject = (id: string) => request<Project>(`/projects/${id}`);
export const getProjectByCode = (code: string) =>
  request<Project>(`/projects/code/${code}`);
export const updateProject = (id: string, data: Partial<Project>) =>
  request<Project>(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteProject = (id: string) =>
  request<void>(`/projects/${id}`, { method: 'DELETE' });
export const archiveProject = (id: string) =>
  request<void>(`/projects/${id}/archive`, { method: 'POST' });
export const unarchiveProject = (id: string) =>
  request<void>(`/projects/${id}/unarchive`, { method: 'POST' });
export const listArchivedProjects = () =>
  request<Project[]>('/projects/archived');
export const getProjectDashboard = (id: string) =>
  request<ProjectSummary>(`/projects/${id}/dashboard`);

// Issues
export const listIssues = (projectId: string, params?: Record<string, string>) => {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return request<Issue[]>(`/projects/${projectId}/issues${qs}`);
};
export const createIssue = (projectId: string, data: Partial<Issue>) =>
  request<Issue>(`/projects/${projectId}/issues`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
export const getIssue = (issueKey: string) =>
  request<Issue>(`/issues/${issueKey}`);
export const updateIssue = (issueKey: string, data: Partial<Issue>) =>
  request<Issue>(`/issues/${issueKey}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
export const transitionIssueStatus = (issueKey: string, status: string) =>
  request<Issue>(`/issues/${issueKey}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
export const deleteIssue = (issueKey: string) =>
  request<void>(`/issues/${issueKey}`, { method: 'DELETE' });
export const restoreIssue = (issueKey: string) =>
  request<void>(`/issues/${issueKey}/restore`, { method: 'POST' });
export const permanentDeleteIssue = (issueKey: string) =>
  request<void>(`/issues/${issueKey}/permanent`, { method: 'DELETE' });
export const listArchivedIssues = (projectId: string) =>
  request<Issue[]>(`/projects/${projectId}/issues/archived`);
export const searchIssues = (q: string, projectId?: string) => {
  const params = new URLSearchParams({ q });
  if (projectId) params.set('projectId', projectId);
  return request<Issue[]>(`/issues/search?${params}`);
};

// Feedback
export const listFeedback = (params?: Record<string, string>) => {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return request<FeedbackItem[]>(`/feedback${qs}`);
};
export const createFeedback = (data: Partial<FeedbackItem>) =>
  request<FeedbackItem>('/feedback', { method: 'POST', body: JSON.stringify(data) });
export const reviewFeedback = (id: string, action: string, createIssue = false) =>
  request<FeedbackItem>(`/feedback/${id}/review`, {
    method: 'PATCH',
    body: JSON.stringify({ action, createIssue }),
  });
export const listProjectFeedback = (projectId: string) =>
  request<FeedbackItem[]>(`/projects/${projectId}/feedback`);

// Sessions
export const listSessions = (projectId: string) =>
  request<SessionLog[]>(`/projects/${projectId}/sessions`);
export const getLatestSession = (projectId: string) =>
  request<SessionLog>(`/projects/${projectId}/sessions/latest`);
export const createSession = (projectId: string) =>
  request<SessionLog>(`/projects/${projectId}/sessions`, { method: 'POST' });

// Uploads
export const uploadFiles = async (files: File[]): Promise<Attachment[]> => {
  const form = new FormData();
  files.forEach((f) => form.append('files', f));
  const res = await fetch(`${BASE}/uploads`, { method: 'POST', body: form });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || res.statusText);
  }
  return res.json();
};

// Health Checks
export const runHealthCheck = (projectId: string) =>
  request<HealthCheckResult[]>(`/projects/${projectId}/healthcheck`);

export const getHealthHistory = (projectId: string) =>
  request<HealthRecord[]>(`/projects/${projectId}/healthcheck/history`);

// Chat History
export const listChatHistory = (projectId: string) =>
  request<ChatHistorySummary[]>(`/projects/${projectId}/chat-history`);
export const getChatHistoryEntry = (historyId: string) =>
  request<ChatHistoryEntry>(`/chat-history/${historyId}`);

// VIBECTL.md
export const generateVibectlMd = (projectId: string) =>
  request<{ generated: boolean }>(`/projects/${projectId}/vibectl-md/generate`, { method: 'POST' });
export const getVibectlMd = async (projectId: string): Promise<string> => {
  const res = await fetch(`${BASE}/projects/${projectId}/vibectl-md`);
  if (!res.ok) throw new Error('VIBECTL.md not found');
  return res.text();
};
export const previewVibectlMd = async (projectId: string): Promise<string> => {
  const res = await fetch(`${BASE}/projects/${projectId}/vibectl-md/preview`);
  if (!res.ok) throw new Error('Preview failed');
  return res.text();
};
export const listDecisions = (projectId: string, limit = 20) =>
  request<Decision[]>(`/projects/${projectId}/decisions?limit=${limit}`);

// Filesystem
export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  modTime?: string;
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
  mode: string;
}

export const listDirectory = (projectId: string, path = '.') =>
  request<FileEntry[]>(`/projects/${projectId}/files/list?path=${encodeURIComponent(path)}`);
export const readFile = (projectId: string, path: string) =>
  request<FileContent>(`/projects/${projectId}/files/read?path=${encodeURIComponent(path)}`);
export const writeFile = (projectId: string, path: string, content: string) =>
  request<{ saved: boolean }>(`/projects/${projectId}/files/write?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  });

// Prompts
export const listProjectPrompts = (projectId: string) =>
  request<Prompt[]>(`/projects/${projectId}/prompts`);
export const listAllPrompts = () =>
  request<Prompt[]>('/prompts');
export const createPrompt = (projectId: string, data: { name: string; body: string }) =>
  request<Prompt>(`/projects/${projectId}/prompts`, { method: 'POST', body: JSON.stringify(data) });
export const createGlobalPrompt = (data: { name: string; body: string }) =>
  request<Prompt>('/prompts', { method: 'POST', body: JSON.stringify(data) });
export const getPrompt = (promptId: string) =>
  request<Prompt>(`/prompts/${promptId}`);
export const updatePrompt = (promptId: string, data: { name?: string; body?: string }) =>
  request<Prompt>(`/prompts/${promptId}`, { method: 'PUT', body: JSON.stringify(data) });
export const deletePrompt = (promptId: string) =>
  request<void>(`/prompts/${promptId}`, { method: 'DELETE' });

// Activity Log
export const listActivityLog = (params?: { projectId?: string; type?: string; limit?: number; offset?: number }) => {
  const qs = params ? '?' + new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])
  ).toString() : '';
  return request<ActivityLogResponse>(`/activity-log${qs}`);
};

// Directory management
export const checkDir = (path: string) =>
  request<{ exists: boolean }>(`/check-dir?path=${encodeURIComponent(path)}`);
export const ensureDir = (path: string) =>
  request<{ created: boolean; exists: boolean }>('/ensure-dir', {
    method: 'POST',
    body: JSON.stringify({ path }),
  });

// Admin
export const getAuthStatus = async (): Promise<{ passwordSet: boolean; tokenValid: boolean }> => {
  const token = getStoredToken();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}/admin/auth-status`, { headers });
  if (!res.ok) throw new Error('auth-status failed');
  return res.json();
};
export const adminLogin = (password: string) =>
  request<{ token: string }>('/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
export const triggerRebuild = () =>
  request<{ status: string }>('/admin/rebuild', { method: 'POST' });
export const getSelfInfo = () =>
  request<{ sourceDir: string }>('/admin/self-info');

// Dashboard
export const getGlobalDashboard = () =>
  request<GlobalDashboard>('/dashboard');

// AI Agents
export const triageFeedback = (id: string) =>
  request<AIAnalysis>(`/feedback/${id}/triage`, { method: 'POST' });
export const triageAllPending = () =>
  request<{ triaged: number }>('/feedback/triage-batch', { method: 'POST' });
export const runPMReview = (projectId: string) =>
  request<PMReviewResult>(`/agents/pm-review/${projectId}`, { method: 'POST' });
