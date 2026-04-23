import type {
  Project,
  UnitDefinition,
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
  IssueComment,
  AppSettings,
  User,
  ProjectMember,
  CheckoutStatus,
  CIStatus,
  AuthStatus,
  ModeInfo,
  ClientInstance,
  ProjectPathEntry,
  ProjectUniverseData,
  Plan,
  PlanListResponse,
} from '../types';

const BASE = '/api/v1';

export const TOKEN_KEY = 'vibectl_token';
export const getStoredToken = () => localStorage.getItem(TOKEN_KEY);
export const setStoredToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearStoredToken = () => localStorage.removeItem(TOKEN_KEY);

// View mode: when delegation is active, "local" forces requests to local handlers
const VIEW_MODE_KEY = 'vibectl_view_mode';
export const getViewMode = (): 'auto' | 'local' => (localStorage.getItem(VIEW_MODE_KEY) as 'auto' | 'local') || 'auto';
export const setViewMode = (mode: 'auto' | 'local') => { localStorage.setItem(VIEW_MODE_KEY, mode); window.dispatchEvent(new CustomEvent('vibectl:viewmode-changed')); };

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getStoredToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // Inject view mode header when forcing local view
  if (getViewMode() === 'local') headers['X-Vibectl-View'] = 'local';
  const res = await fetch(`${BASE}${path}`, {
    headers: { ...headers, ...(options?.headers as Record<string, string>) },
    ...options,
  });
  if (!res.ok) {
    if (res.status === 401) {
      clearStoredToken();
      window.dispatchEvent(new CustomEvent('vibectl:unauthorized'));
    }
    // Detect delegation permission errors
    const delegationError = res.headers.get('X-Delegation-Error');
    if (delegationError === 'permission_denied') {
      const body = await res.json().catch(() => ({ error: 'Permission denied' }));
      throw new Error(`Delegation permission denied: ${body.error || 'Your API key does not have sufficient permissions for this action. Check your project role on the remote server.'}`);
    }
    if (delegationError === 'auth_failed') {
      throw new Error('Delegation API key rejected by remote server. Update your API key in Settings > Delegation.');
    }
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// ---- Auth ----
export interface LoginResult {
  token: string;
  user: User;
  requirePasswordChange: boolean;
}

export const getAuthStatus = (): Promise<AuthStatus> =>
  request<AuthStatus>('/auth/status');

export const authLogin = (credentials: { email?: string; password: string }): Promise<LoginResult> =>
  request<LoginResult>('/auth/login', { method: 'POST', body: JSON.stringify(credentials) });

export const authMe = (): Promise<User> =>
  request<User>('/auth/me');

export const authLogout = (): Promise<void> =>
  request<void>('/auth/logout', { method: 'POST' });

export const authChangePassword = (currentPassword: string, newPassword: string): Promise<{ token: string }> =>
  request<{ token: string }>('/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });

// Legacy — preserved for backward compat with old CLI
export const adminLogin = (password: string) =>
  authLogin({ password }).then(r => ({ token: r.token }));

// ---- API Keys ----
export interface APIKeyView {
  id: string;
  name: string;
  lastUsedAt?: string;
  createdAt: string;
}

export const listAPIKeys = (): Promise<APIKeyView[]> =>
  request<APIKeyView[]>('/api-keys');

export const createAPIKey = (name: string): Promise<{ key: APIKeyView; token: string }> =>
  request<{ key: APIKeyView; token: string }>('/api-keys', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });

export const revokeAPIKey = (keyId: string): Promise<void> =>
  request<void>(`/api-keys/${keyId}`, { method: 'DELETE' });

// ---- Users (super_admin only) ----
export const listUsers = (): Promise<User[]> =>
  request<User[]>('/users');

// ---- User directory (any authenticated user) ----
export const listUsersDirectory = (): Promise<User[]> =>
  request<User[]>('/users/directory');

export const preAuthorizeUser = (data: { githubUsername: string; displayName?: string; globalRole?: string }): Promise<User> =>
  request<User>('/users', { method: 'POST', body: JSON.stringify(data) });

export const createEmailUser = (data: { email: string; displayName?: string; globalRole?: string }): Promise<{ user: User; temporaryPassword: string }> =>
  request<{ user: User; temporaryPassword: string }>('/users/email', { method: 'POST', body: JSON.stringify(data) });

export const setPasswordForUser = (userId: string, data: { email?: string }): Promise<{ temporaryPassword: string }> =>
  request<{ temporaryPassword: string }>(`/users/${userId}/set-password`, { method: 'POST', body: JSON.stringify(data) });

export const updateUser = (userId: string, data: Partial<Pick<User, 'displayName' | 'email' | 'globalRole' | 'disabled' | 'gitName' | 'gitEmail'>>): Promise<User> =>
  request<User>(`/users/${userId}`, { method: 'PUT', body: JSON.stringify(data) });

// ---- User self-profile ----
export const updateSelfProfile = (data: Partial<Pick<User, 'displayName' | 'email' | 'gitName' | 'gitEmail' | 'workspaceDir' | 'claudeCodeFontSize'>>): Promise<User> =>
  request<User>('/users/me', { method: 'PUT', body: JSON.stringify(data) });

export const setSelfAnthropicKey = (key: string): Promise<void> =>
  request<void>('/users/me/anthropic-key', { method: 'PUT', body: JSON.stringify({ key }) });

export const setSelfGitHubPAT = (pat: string): Promise<void> =>
  request<void>('/users/me/github-pat', { method: 'PUT', body: JSON.stringify({ pat }) });

// ---- Clone / remote dev ----
export interface CloneStatusResponse {
  cloneStatus: string;
  cloneError?: string;
  localPath?: string;
  updatedAt: string;
}

export const getCloneStatus = (projectId: string): Promise<CloneStatusResponse> =>
  request<CloneStatusResponse>(`/projects/${projectId}/clone-status`);

export const removeClone = (projectId: string): Promise<void> =>
  request<void>(`/projects/${projectId}/clone`, { method: 'DELETE' });

// cloneProject and pullProject return an EventSource URL (caller must open SSE).
// Token is passed as a query param because EventSource cannot set headers.
export const getCloneSSEUrl = (projectId: string): string => {
  const token = getStoredToken();
  return `/api/v1/projects/${projectId}/clone${token ? `?token=${encodeURIComponent(token)}` : ''}`;
};

export const getPullSSEUrl = (projectId: string): string => {
  const token = getStoredToken();
  return `/api/v1/projects/${projectId}/pull${token ? `?token=${encodeURIComponent(token)}` : ''}`;
};

export const getRestartDevStreamUrl = (projectId: string): string => {
  const token = getStoredToken();
  return `/api/v1/projects/${projectId}/ci/restart-dev-stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
};

export const getDeployAllStreamUrl = (projectId: string, commitMessage?: string): string => {
  const token = getStoredToken();
  const params = new URLSearchParams();
  if (token) params.set('token', token);
  if (commitMessage) params.set('commitMessage', commitMessage);
  const qs = params.toString();
  return `/api/v1/projects/${projectId}/ci/deploy-all-stream${qs ? `?${qs}` : ''}`;
};

export const getBulkStartProdStreamUrl = (): string => {
  const token = getStoredToken();
  return `/api/v1/ci/bulk-start-prod-stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
};

export const getBulkRestartProdStreamUrl = (): string => {
  const token = getStoredToken();
  return `/api/v1/ci/bulk-restart-prod-stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
};

export const changeOwnPassword = (currentPassword: string, newPassword: string): Promise<{ token: string }> =>
  request<{ token: string }>('/users/me/password', {
    method: 'PUT',
    body: JSON.stringify({ currentPassword, newPassword }),
  });

// ---- Project Members ----
export const listProjectMembers = (projectId: string): Promise<ProjectMember[]> =>
  request<ProjectMember[]>(`/projects/${projectId}/members`);

export const upsertProjectMember = (projectId: string, userId: string, role: string): Promise<ProjectMember> =>
  request<ProjectMember>(`/projects/${projectId}/members/${userId}`, {
    method: 'PUT',
    body: JSON.stringify({ role }),
  });

export const removeProjectMember = (projectId: string, userId: string): Promise<void> =>
  request<void>(`/projects/${projectId}/members/${userId}`, { method: 'DELETE' });

// ---- Code Checkout ----
export const getCheckoutStatus = (projectId: string): Promise<CheckoutStatus> =>
  request<CheckoutStatus>(`/projects/${projectId}/checkout`);

export const acquireCheckout = (projectId: string): Promise<CheckoutStatus> =>
  request<CheckoutStatus>(`/projects/${projectId}/checkout`, { method: 'POST' });

export const releaseCheckout = (projectId: string): Promise<void> =>
  request<void>(`/projects/${projectId}/checkout`, { method: 'DELETE' });

export const reclaimCheckout = (projectId: string): Promise<CheckoutStatus> =>
  request<CheckoutStatus>(`/projects/${projectId}/checkout/reclaim`, { method: 'POST' });

// ---- CI ----
export const getCIStatus = (projectId: string): Promise<CIStatus> =>
  request<CIStatus>(`/projects/${projectId}/ci/status`);

export const ciCommit = (projectId: string, message: string): Promise<{ status: string; output: string }> =>
  request<{ status: string; output: string }>(`/projects/${projectId}/ci/commit`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });

export const ciPush = (projectId: string): Promise<{ status: string; output: string; githubWarning?: string }> =>
  request<{ status: string; output: string; githubWarning?: string }>(`/projects/${projectId}/ci/push`, {
    method: 'POST',
  });

export const ciDeploy = (projectId: string): Promise<{ status: string; output: string }> =>
  request<{ status: string; output: string }>(`/projects/${projectId}/ci/deploy`, {
    method: 'POST',
  });

export const ciRestartDev = (projectId: string): Promise<{ status: string; output: string }> =>
  request<{ status: string; output: string }>(`/projects/${projectId}/ci/restart-dev`, {
    method: 'POST',
  });

export const ciRestartProd = (projectId: string): Promise<{ status: string; output: string }> =>
  request<{ status: string; output: string }>(`/projects/${projectId}/ci/restart-prod`, {
    method: 'POST',
  });

export const ciDeployAll = (projectId: string, commitMessage?: string): Promise<{ status: string; steps: { step: string; output: string }[]; error?: string }> =>
  request<{ status: string; steps: { step: string; output: string }[]; error?: string }>(`/projects/${projectId}/ci/deploy-all`, {
    method: 'POST',
    body: JSON.stringify({ commitMessage: commitMessage ?? '' }),
  });

export const ciStartProd = (projectId: string): Promise<{ status: string; output: string }> =>
  request<{ status: string; output: string }>(`/projects/${projectId}/ci/start-prod`, {
    method: 'POST',
  });

export const ciTogglePause = (projectId: string, paused: boolean): Promise<{ paused: boolean }> =>
  request<{ paused: boolean }>(`/projects/${projectId}/ci/pause`, {
    method: 'POST',
    body: JSON.stringify({ paused }),
  });

export const bulkStartProd = (): Promise<{ results: { projectId: string; projectName: string; status: string; output: string }[] }> =>
  request<{ results: { projectId: string; projectName: string; status: string; output: string }[] }>('/ci/bulk-start-prod', {
    method: 'POST',
  });

export const bulkRestartProd = (): Promise<{ results: { projectId: string; projectName: string; status: string; output: string }[] }> =>
  request<{ results: { projectId: string; projectName: string; status: string; output: string }[] }>('/ci/bulk-restart-prod', {
    method: 'POST',
  });

// ---- Projects ----
export const listProjects = () => request<Project[]>('/projects');
export const listAllTags = () => request<string[]>('/projects/tags');
export const listStaleProjects = (days?: number) =>
  request<Project[]>(`/projects/stale${days ? `?days=${days}` : ''}`);
export const setProjectInactive = (id: string) =>
  request<{ status: string }>(`/projects/${id}/set-inactive`, { method: 'POST' });
export const setProjectActive = (id: string) =>
  request<{ status: string }>(`/projects/${id}/set-active`, { method: 'POST' });

export interface ProductivityEntry {
  projectId: string;
  projectName: string;
  projectCode: string;
  tags?: string[];
  linesAdded: number;
  linesRemoved: number;
  bytesDelta: number;
  filesChanged: number;
  promptCount: number;
}
export const getProductivity = (days?: number) =>
  request<ProductivityEntry[]>(`/dashboard/productivity${days ? `?days=${days}` : ''}`);

// ---- Intents ----
export const listIntents = (params?: { projectId?: string; status?: string; category?: string; days?: number; limit?: number }) => {
  const qs = params ? '?' + new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])
  ).toString() : '';
  return request<import('../types').Intent[]>(`/intents${qs}`);
};
export const getIntentProductivity = (days?: number, userId?: string) => {
  const params: Record<string, string> = {};
  if (days) params.days = String(days);
  if (userId) params.userId = userId;
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : '';
  return request<import('../types').IntentProductivityStats[]>(`/intents/productivity${qs}`);
};
export const getIntentInsights = (params?: { days?: number; since?: string; tag?: string; userId?: string }) => {
  const qs = params ? '?' + new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])
  ).toString() : '';
  return request<import('../types').IntentInsights>(`/intents/insights${qs}`);
};
export const backfillIntents = () =>
  request<{ processing: number; remaining: number; message: string }>('/intents/backfill', { method: 'POST' });
export const getBackfillCount = () =>
  request<{ remaining: number }>('/intents/backfill-count');
export const patchIntent = (id: string, data: Partial<import('../types').Intent>) =>
  request<{ status: string }>(`/intents/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
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

// ---- Multi-module units ----
export const createMultiModuleProject = (data: {
  name: string; code: string; description: string;
  links: { localPath?: string; githubUrl?: string };
  goals?: string[]; projectType: 'multi'; units: UnitDefinition[];
}) =>
  request<{ parent: Project; units: Project[] }>('/projects', { method: 'POST', body: JSON.stringify(data) });

export const listUnits = (projectId: string) =>
  request<Project[]>(`/projects/${projectId}/units`);

export const addUnit = (projectId: string, unit: UnitDefinition) =>
  request<Project>(`/projects/${projectId}/units`, { method: 'POST', body: JSON.stringify(unit) });

export const detachUnit = (projectId: string, unitId: string) =>
  request<void>(`/projects/${projectId}/units/${unitId}/detach`, { method: 'POST' });

export const attachUnit = (projectId: string, existingProjectId: string) =>
  request<Project>(`/projects/${projectId}/units/attach`, { method: 'POST', body: JSON.stringify({ projectId: existingProjectId }) });

// ---- Issues ----
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

// ---- Feedback ----
export const listFeedback = (params?: Record<string, string>) => {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return request<FeedbackItem[]>(`/feedback${qs}`);
};
export const createFeedback = (data: Partial<FeedbackItem>) =>
  request<FeedbackItem>('/feedback', { method: 'POST', body: JSON.stringify(data) });
export const reviewFeedback = (
  id: string,
  action: string,
  createIssue = false,
  extras?: { issueTitle?: string; issueDescription?: string; issueType?: string; issuePriority?: string }
) =>
  request<FeedbackItem>(`/feedback/${id}/review`, {
    method: 'PATCH',
    body: JSON.stringify({ action, createIssue, ...extras }),
  });
export const bulkReviewFeedback = (items: { id: string; action: string }[]) =>
  request<{ processed: number; results: FeedbackItem[]; errors?: string[] }>('/feedback/bulk-review', {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
export const triggerTriage = (id: string) =>
  request<Record<string, unknown>>(`/feedback/${id}/triage`, { method: 'POST' });
export const triggerTriageBatch = () =>
  request<{ triaged: number }>('/feedback/triage-batch', { method: 'POST' });
export const listProjectFeedback = (projectId: string) =>
  request<FeedbackItem[]>(`/projects/${projectId}/feedback`);

// ---- Sessions ----
export const listSessions = (projectId: string) =>
  request<SessionLog[]>(`/projects/${projectId}/sessions`);
export const getLatestSession = (projectId: string) =>
  request<SessionLog>(`/projects/${projectId}/sessions/latest`);
export const createSession = (projectId: string) =>
  request<SessionLog>(`/projects/${projectId}/sessions`, { method: 'POST' });

// ---- Uploads ----
export const uploadFiles = async (files: File[]): Promise<Attachment[]> => {
  const form = new FormData();
  files.forEach((f) => form.append('files', f));
  const token = getStoredToken();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}/uploads`, { method: 'POST', body: form, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || res.statusText);
  }
  return res.json();
};

// ---- Health Checks ----
export const runHealthCheck = (projectId: string) =>
  request<HealthCheckResult[]>(`/projects/${projectId}/healthcheck`);

export const getHealthHistory = (projectId: string) =>
  request<HealthRecord[]>(`/projects/${projectId}/healthcheck/history`);

// ---- Chat History ----
export const listChatHistory = (projectId: string) =>
  request<ChatHistorySummary[]>(`/projects/${projectId}/chat-history`);
export const getChatHistoryEntry = (historyId: string) =>
  request<ChatHistoryEntry>(`/chat-history/${historyId}`);

// ---- VIBECTL.md ----
export const generateVibectlMd = (projectId: string) =>
  request<{ generated: boolean }>(`/projects/${projectId}/vibectl-md/generate`, { method: 'POST' });
export const getVibectlMd = async (projectId: string): Promise<string> => {
  const token = getStoredToken();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}/projects/${projectId}/vibectl-md`, { headers });
  if (!res.ok) throw new Error('VIBECTL.md not found');
  return res.text();
};
export const previewVibectlMd = async (projectId: string): Promise<string> => {
  const token = getStoredToken();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}/projects/${projectId}/vibectl-md/preview`, { headers });
  if (!res.ok) throw new Error('Preview failed');
  return res.text();
};
export const listDecisions = (projectId: string, limit = 20) =>
  request<Decision[]>(`/projects/${projectId}/decisions?limit=${limit}`);

// ---- Filesystem ----
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

// ---- Prompts ----
export const listProjectPrompts = (projectId: string) =>
  request<Prompt[]>(`/projects/${projectId}/prompts`);
export const listAllPrompts = () =>
  request<Prompt[]>('/prompts');
export const createPrompt = (projectId: string, data: { name: string; body: string; shared?: boolean }) =>
  request<Prompt>(`/projects/${projectId}/prompts`, { method: 'POST', body: JSON.stringify(data) });
export const createGlobalPrompt = (data: { name: string; body: string; shared?: boolean }) =>
  request<Prompt>('/prompts', { method: 'POST', body: JSON.stringify(data) });
export const getPrompt = (promptId: string) =>
  request<Prompt>(`/prompts/${promptId}`);
export const updatePrompt = (promptId: string, data: { name?: string; body?: string; shared?: boolean }) =>
  request<Prompt>(`/prompts/${promptId}`, { method: 'PUT', body: JSON.stringify(data) });
export const deletePrompt = (promptId: string) =>
  request<void>(`/prompts/${promptId}`, { method: 'DELETE' });

// ---- Plans ----
export const listPlans = (params?: { projectId?: string; status?: string; limit?: number; offset?: number }) => {
  const qs = params ? '?' + new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])
  ).toString() : '';
  return request<PlanListResponse>(`/plans${qs}`);
};
export const getPlan = (planId: string) =>
  request<Plan>(`/plans/${planId}`);
export const updatePlanStatus = (planId: string, status: string, feedback?: string) =>
  request<{ status: string }>(`/plans/${planId}/status`, {
    method: 'PUT',
    body: JSON.stringify({ status, feedback }),
  });

// ---- Activity Log ----
export const listActivityLog = (params?: { projectId?: string; type?: string; limit?: number; offset?: number }) => {
  const qs = params ? '?' + new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])
  ).toString() : '';
  return request<ActivityLogResponse>(`/activity-log${qs}`);
};

// ---- Directory management ----
export const checkDir = (path: string) =>
  request<{ exists: boolean }>(`/check-dir?path=${encodeURIComponent(path)}`);
export const ensureDir = (path: string) =>
  request<{ created: boolean; exists: boolean }>('/ensure-dir', {
    method: 'POST',
    body: JSON.stringify({ path }),
  });
export const detectGitRemote = (path: string) =>
  request<{ remoteUrl: string }>(`/detect-git-remote?path=${encodeURIComponent(path)}`);

export const detectFlyToml = (path: string) =>
  request<{ found: boolean; appName?: string; deployProd?: string; startProd?: string; restartProd?: string; viewLogs?: string }>(`/detect-fly-toml?path=${encodeURIComponent(path)}`);

export const detectStartSh = (path: string) =>
  request<{ found: boolean; preview?: string; command?: string }>(`/detect-start-sh?path=${encodeURIComponent(path)}`);

export interface DetectedScripts {
  deployShFound: boolean;
  startShFound: boolean;
  flyTomlFound: boolean;
  deployProd?: string;
  startDev?: string;
  startProd?: string;
  restartProd?: string;
  viewLogs?: string;
  flyAppName?: string;
}
export const detectProjectScripts = (path: string) =>
  request<DetectedScripts>(`/detect-project-scripts?path=${encodeURIComponent(path)}`);

export const suggestClonePath = (githubUrl: string) =>
  request<{ path: string }>(`/clone/suggest-path?url=${encodeURIComponent(githubUrl)}`);
export const suggestNewPath = (code: string) =>
  request<{ path: string }>(`/clone/new-path?code=${encodeURIComponent(code)}`);

// ---- Comments ----
export const listComments = (issueKey: string) =>
  request<IssueComment[]>(`/issues/${issueKey}/comments`);
export const createComment = (issueKey: string, data: { body: string; author: string }) =>
  request<IssueComment>(`/issues/${issueKey}/comments`, { method: 'POST', body: JSON.stringify(data) });
export const deleteComment = (issueKey: string, commentId: string) =>
  request<void>(`/issues/${issueKey}/comments/${commentId}`, { method: 'DELETE' });

// ---- Settings ----
export const getSettings = () => request<AppSettings>('/settings');
export const updateSettings = (data: Partial<AppSettings>) =>
  request<AppSettings>('/settings', { method: 'PUT', body: JSON.stringify(data) });

// ---- Admin ----
export const triggerRebuild = () =>
  request<{ status: string }>('/admin/rebuild', { method: 'POST' });
export const getSelfInfo = () =>
  request<{ sourceDir: string }>('/admin/self-info');
export const getClaudeAuthStatus = () =>
  request<{ loggedIn: boolean; error?: string; authMethod?: string; email?: string }>('/admin/claude-auth-status');
export const getClaudeLoginSSEUrl = () => `/api/v1/admin/claude-login`;
export const submitClaudeLoginCode = (code: string, codeVerifier: string, clientId: string, redirectUri: string, state: string) =>
  request<{ status: string }>('/admin/claude-login-code', {
    method: 'POST',
    body: JSON.stringify({ code, codeVerifier, clientId, redirectUri, state }),
  });
export const submitClaudeTokenDirect = (token: string) =>
  request<{ status: string }>('/admin/claude-token-direct', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });

// ---- MCP Servers ----
export interface MCPServerInfo {
  name: string;
  type: string;
  command?: string;
  url?: string;
  source: string;
  argsCount?: number;
}
export const listMCPServers = (projectPath?: string) => {
  const qs = projectPath ? `?projectPath=${encodeURIComponent(projectPath)}` : '';
  return request<{ servers: MCPServerInfo[] }>(`/admin/mcp-servers${qs}`);
};

// ---- Claude Subscription Usage ----
export interface UsageBucket {
  utilization: number;
  resetsAt: string;
}
export interface SubscriptionUsage {
  fiveHour: UsageBucket | null;
  sevenDay: UsageBucket | null;
  sevenDaySonnet?: UsageBucket | null;
  sevenDayOpus?: UsageBucket | null;
  extraUsage?: { isEnabled: boolean; monthlyLimit: number | null; usedCredits: number } | null;
  subscriptionType: string;
}
export const getSubscriptionUsage = () =>
  request<SubscriptionUsage>('/admin/subscription-usage');

// ---- Delegation ----
export const getDelegationStatus = () =>
  request<import('../types').DelegationStatus>('/delegation/status');
export const testDelegation = (data: { url: string; apiKey: string }) =>
  request<import('../types').DelegationTestResult>('/delegation/test', { method: 'POST', body: JSON.stringify(data) });
export const enableDelegation = (data: { url: string; apiKey: string }) =>
  request<{ status: string }>('/delegation/enable', { method: 'POST', body: JSON.stringify(data) });
export const disableDelegation = () =>
  request<{ status: string }>('/delegation/disable', { method: 'POST' });
export const exportProjectToRemote = (projectCode: string) =>
  request<{ status: string; message: string }>('/delegation/export-project', { method: 'POST', body: JSON.stringify({ projectCode }) });

// ---- Claude Usage ----
export const getClaudeUsageSummary = () =>
  request<import('../types').ClaudeUsageSummary[]>('/claude-usage/summary');

export const updateClaudeUsageConfig = (config: import('../types').ClaudeUsageConfig) =>
  request<import('../types').ClaudeUsageConfig>('/claude-usage/config', {
    method: 'PUT',
    body: JSON.stringify(config),
  });

// ---- Dashboard ----
export const getGlobalDashboard = () =>
  request<GlobalDashboard>('/dashboard');

export const getUniverseData = (days?: number) =>
  request<ProjectUniverseData[]>(`/dashboard/universe${days ? `?days=${days}` : ''}`);

// ---- AI Agents ----
export const triageFeedback = (id: string) =>
  request<AIAnalysis>(`/feedback/${id}/triage`, { method: 'POST' });
export const triageAllPending = () =>
  request<{ triaged: number }>('/feedback/triage-batch', { method: 'POST' });
export const generateFeedbackPrompt = (projectCode: string) =>
  request<import('../types').GeneratePromptResponse>('/feedback/generate-prompt', {
    method: 'POST', body: JSON.stringify({ projectCode }),
  });
export const submitFeedbackPrompt = (batchId: string, projectCode: string, promptText: string) =>
  request<{ submitted: number }>('/feedback/submit-prompt', {
    method: 'POST', body: JSON.stringify({ batchId, projectCode, promptText }),
  });
export const runPMReview = (projectId: string) =>
  request<PMReviewResult>(`/agents/pm-review/${projectId}`, { method: 'POST' });

// ---- Mode info (no auth required) ----
export const getModeInfo = (): Promise<ModeInfo> =>
  request<ModeInfo>('/mode');

export const pingRemote = (): Promise<{ reachable: boolean; reason?: string }> =>
  request<{ reachable: boolean; reason?: string }>('/client/ping');

// ---- Local path overrides (client mode only, always local) ----
export const getLocalPaths = (): Promise<Record<string, string>> =>
  request<Record<string, string>>('/local-paths');

export const setLocalPath = (projectId: string, localPath: string): Promise<void> =>
  request<void>(`/local-paths/${projectId}`, {
    method: 'PUT',
    body: JSON.stringify({ localPath }),
  });

export const deleteLocalPath = (projectId: string): Promise<void> =>
  request<void>(`/local-paths/${projectId}`, { method: 'DELETE' });

// ---- Client instances (remote server only) ----
export const listClientInstances = (): Promise<ClientInstance[]> =>
  request<ClientInstance[]>('/client-instances/');

export const createClientInstance = (name: string, description?: string): Promise<ClientInstance> =>
  request<ClientInstance>('/client-instances/', {
    method: 'POST',
    body: JSON.stringify({ name, description }),
  });

export const updateClientInstance = (
  id: string,
  updates: { name?: string; description?: string; projectPaths?: ProjectPathEntry[] }
): Promise<ClientInstance> =>
  request<ClientInstance>(`/client-instances/${id}/`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });

export const deleteClientInstance = (id: string): Promise<void> =>
  request<void>(`/client-instances/${id}/`, { method: 'DELETE' });
