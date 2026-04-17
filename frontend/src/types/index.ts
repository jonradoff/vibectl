export interface CustomLink {
  label: string;
  url: string;
}

export interface ProjectLinks {
  localPath?: string;
  githubUrl?: string;
  custom?: CustomLink[];
}

export interface HealthCheckEndpoint {
  devUrl?: string;
  prodUrl?: string;
}

export interface HealthCheckConfig {
  frontend: HealthCheckEndpoint;
  backend: HealthCheckEndpoint;
  monitorEnv: string; // "dev", "prod", or "" (off)
}

export interface HealthDependency {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  message?: string;
}

export interface HealthKPI {
  name: string;
  value: number;
  unit: string;
}

export interface HealthCheckResult {
  name: string;
  url: string;
  status: 'up' | 'down' | 'degraded' | 'unknown';
  code?: number;
  error?: string;
  softwareName?: string;
  version?: string;
  uptime?: number;
  dependencies?: HealthDependency[];
  kpis?: HealthKPI[];
}

export interface HealthRecord {
  id: string;
  projectId: string;
  results: HealthCheckResult[];
  checkedAt: string;
}

export interface IssueComment {
  id: string;
  issueKey: string;
  projectId: string;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookConfig {
  url: string;
  events: string[];
  secret?: string;
}

export interface Project {
  id: string;
  name: string;
  code: string;
  description: string;
  links: ProjectLinks;
  goals: string[];
  healthCheck?: HealthCheckConfig;
  deployment?: DeploymentConfig;
  webhooks?: WebhookConfig[];
  issueCounter: number;
  archived: boolean;
  paused?: boolean;
  cloneStatus?: '' | 'cloning' | 'cloned' | 'error';
  cloneError?: string;
  tags?: string[];
  inactive?: boolean;
  inactiveSince?: string;
  recurringThemes?: RecurringTheme[];
  architectureSummary?: string;
  architectureUpdatedAt?: string;
  vibectlMdGeneratedAt?: string;
  createdAt: string;
  updatedAt: string;

  // Multi-module fields
  projectType?: 'simple' | 'multi';
  parentId?: string;
  unitName?: string;
  unitPath?: string;
}

export interface UnitDefinition {
  name: string;
  code: string;
  path: string;
  description: string;
}

export interface AppSettings {
  vibectlMdAutoRegen: boolean;
  vibectlMdSchedule: string;
  updatedAt: string;
  dbName?: string;
  dbUser?: string;
  // Experimental features — all false by default
  experimentalShell: boolean;
}

export type IssueType = 'bug' | 'feature' | 'idea';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5';
export type TriageStatus = 'pending' | 'triaged' | 'reviewed' | 'accepted' | 'dismissed';
export type SessionStatus = 'active' | 'idle' | 'completed';

export interface Attachment {
  id: string;
  filename: string;
  url: string;
  mimeType: string;
  size: number;
}

export interface Issue {
  id: string;
  projectId: string;
  issueKey: string;
  number: number;
  title: string;
  description: string;
  type: IssueType;
  priority: Priority;
  status: string;
  source?: string;
  createdBy: string;
  dueDate?: string;
  reproSteps?: string;
  attachments?: Attachment[];
  archived?: boolean;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProposedIssue {
  title: string;
  description: string;
  type: string;
  priority: string;
  reproSteps?: string;
}

export interface AIAnalysis {
  matchedIssueKeys: string[];
  proposedIssue?: ProposedIssue;
  confidence: number;
  reasoning: string;
}

export interface FeedbackItem {
  id: string;
  projectId?: string;
  sourceType: string;
  sourceUrl?: string;
  rawContent: string;
  submittedBy?: string;
  submittedAt: string;
  triageStatus: TriageStatus;
  aiAnalysis?: AIAnalysis;
  reviewedAt?: string;
  triagedAt?: string;
  linkedIssueKey?: string;
  metadata?: Record<string, unknown>;
  submittedViaKey?: string;
}

export interface SessionLog {
  id: string;
  projectId: string;
  startedAt: string;
  endedAt?: string;
  summary?: string;
  issuesWorkedOn: string[];
  status: SessionStatus;
}

export interface ProjectSummary {
  project: Project;
  openIssueCount: number;
  pendingFeedbackCount?: number;
  issuesByPriority: Record<string, number>;
  issuesByStatus: Record<string, number>;
  issuesByType: Record<string, number>;
  lastSession?: SessionLog;
  currentUserRole?: string;
}

export interface GlobalDashboard {
  totalProjects: number;
  totalOpenIssues: number;
  pendingFeedback: number;
  projectSummaries: ProjectSummary[];
}

export interface ProjectUniverseData {
  projectId: string;
  projectName: string;
  projectCode: string;
  activityByDay: number[];   // last 90 days, oldest first
  healthByDay: string[];     // last 7 days, oldest first: "up"|"down"|"degraded"|"unknown"
  openIssueCount: number;
  issuesByStatus: Record<string, number>;
  currentHealth: string;     // "up"|"down"|"degraded"|"unknown"|"none"
  pendingFeedbackCount: number;
  deployCount?: number;
  lastActivityAt?: string;
  promptCount: number;
  lastPromptAt?: string;
  projectType?: string;
  parentId?: string;
  unitName?: string;
  tags?: string[];
  inactive?: boolean;
}

export interface GoalAssessment {
  goal: string;
  coverage: string;
  notes: string;
}

export interface Gap {
  description: string;
  suggestedIssue: ProposedIssue;
}

export interface Risk {
  issueKey: string;
  concern: string;
}

export interface Reprioritization {
  issueKey: string;
  currentPriority: string;
  suggestedPriority: string;
  reason: string;
}

export interface PMReviewResult {
  id: string;
  projectId: string;
  goalAssessments: GoalAssessment[];
  gaps: Gap[];
  risks: Risk[];
  reprioritizations: Reprioritization[];
  overallAssessment: string;
  createdAt: string;
}

export interface DeploymentConfig {
  provider?: string;
  startDev?: string;
  stopDev?: string;
  deployProd?: string;
  startProd?: string;
  restartProd?: string;
  viewLogs?: string;
  flyApp?: string;
  flyRegion?: string;
  notes?: string;
}

export interface Decision {
  id: string;
  projectId: string;
  timestamp: string;
  action: string;
  summary: string;
  issueKey?: string;
}

export interface RecurringTheme {
  theme: string;
  feedbackCount: number;
  relatedIssues: string[];
  updatedAt: string;
}

export interface ChatHistorySummary {
  id: string;
  projectId: string;
  claudeSessionId: string;
  messageCount: number;
  startedAt: string;
  endedAt: string;
}

export interface ChatHistoryEntry {
  id: string;
  projectId: string;
  claudeSessionId: string;
  messages: unknown[];
  messageCount: number;
  startedAt: string;
  endedAt: string;
}

export interface Prompt {
  id: string;
  projectId?: string;
  global: boolean;
  name: string;
  body: string;
  createdBy?: string;
  creatorName?: string;
  shared: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityLogEntry {
  id: string;
  projectId?: string;
  userId?: string;
  userName?: string;
  type: string;
  message: string;
  snippet?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface ActivityLogResponse {
  entries: ActivityLogEntry[];
  total: number;
  limit: number;
  offset: number;
}

// ---- Plans ----

export interface Plan {
  id: string;
  projectId?: string;
  claudeSessionId?: string;
  requestId: string;
  planText: string;
  status: 'pending' | 'accepted' | 'rejected' | 'completed' | 'abandoned';
  feedback?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ---- Intents ----

export interface Intent {
  id: string;
  projectId: string;
  sessionIds: string[];
  title: string;
  description: string;
  category: string;
  techTags: string[];
  uxJudgment: string;
  size: string;
  sizePoints: number;
  status: string;
  statusEvidence: string;
  filesChanged: string[];
  commitCount: number;
  promptCount: number;
  tokensInput: number;
  tokensOutput: number;
  wallClockSecs: number;
  analysisModel: string;
  startedAt: string;
  completedAt: string;
  extractedAt: string;
}

export interface IntentProductivityStats {
  projectId: string;
  projectName?: string;
  projectCode?: string;
  tags?: string[];
  pointsDelivered: number;
  intentCount: number;
  byStatus: Record<string, number>;
  byCategory: Record<string, number>;
  totalTokensIn: number;
  totalTokensOut: number;
  totalWallClock: number;
}

export interface IntentInsights {
  tokensByCategory: Record<string, { totalTokens: number; totalPoints: number; count: number }>;
  tokensByTechTag: Record<string, { totalTokens: number; totalPoints: number; count: number }>;
  tokensByUXLevel: Record<string, { totalTokens: number; totalPoints: number; count: number }>;
  dailyPoints: Record<string, number>;
  dailyByCategory: Record<string, { categories: Record<string, number>; total: number }>;
  byProject: Record<string, { name: string; code: string; points: number; count: number; tokens: number }>;
  funnel: Record<string, { count: number; points: number }>;
  totalIntents: number;
}

export interface PlanListResponse {
  plans: Plan[];
  total: number;
  limit: number;
  offset: number;
}

// ---- Multi-user types ----

export type GlobalRole = 'super_admin' | 'member';
export type ProjectRole = 'owner' | 'devops' | 'developer' | 'contributor' | 'reporter' | 'viewer';

export interface User {
  id: string;
  displayName: string;
  email?: string;
  isDefaultPassword: boolean;
  githubId?: string;
  githubUsername?: string;
  globalRole: GlobalRole;
  isAdminFallback: boolean;
  hasAnthropicKey: boolean;
  hasGitHubPAT: boolean;
  gitName?: string;
  gitEmail?: string;
  disabled: boolean;
  workspaceDir?: string;
  claudeCodeFontSize?: number;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMember {
  id: string;
  projectId: string;
  userId: string;
  role: ProjectRole;
  createdBy: string;
  createdAt: string;
  user?: User;
}

export interface CodeCheckout {
  id: string;
  projectId: string;
  userId: string;
  checkedOutAt: string;
  lastActivityAt: string;
  expiresAt: string;
}

export interface CheckoutStatus {
  checkout?: CodeCheckout;
  heldByUser?: User;
  isAvailable: boolean;
  isYours: boolean;
}

export interface GitCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  url: string;
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string;
  url: string;
}

export interface CIStatus {
  lastCommit?: GitCommit;
  checkRuns: CheckRun[];
  fetchedAt: string;
  githubError?: string;
}

export interface AuthStatus {
  usersExist: boolean;
  tokenValid: boolean;
  githubEnabled: boolean;
  githubTokenConfigured: boolean;
  anthropicEnabled: boolean;
}

// ---- Client mode types ----

export interface ModeInfo {
  mode: 'standalone' | 'client';
  version: string;
  remoteServerURL?: string; // only present in client mode
  baseURL?: string;          // the server's own BASE_URL (standalone mode)
}

export type DisplayMode = 'server' | 'client' | 'dev-standalone';

export interface ProjectPathEntry {
  projectId: string;
  localPath: string;
}

export interface ClientInstance {
  id: string;
  userId: string;
  name: string;
  description?: string;
  lastSeenAt?: string;
  projectPaths?: ProjectPathEntry[];
  createdAt: string;
  updatedAt: string;
}

// ---- Claude Usage ----

export interface ClaudeProjectUsage {
  projectId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ClaudeModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ClaudeDailyUsage {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ClaudeUsageSummary {
  tokenHash: string;
  loginLabel: string;
  weeklyTokenLimit: number;
  alertThreshold: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheCreation: number;
  totalTokens: number;
  usagePercent: number;
  weekStartedAt: string;
  weekResetsAt: string;
  byProject: ClaudeProjectUsage[];
  byModel: ClaudeModelUsage[];
  dailyUsage: ClaudeDailyUsage[];
}

export interface ClaudeUsageConfig {
  tokenHash: string;
  loginLabel: string;
  weeklyTokenLimit: number;
  alertThreshold: number;
}

// ---- Color maps
export const priorityColors: Record<Priority, string> = {
  P0: 'bg-red-600 text-white',
  P1: 'bg-orange-500 text-white',
  P2: 'bg-yellow-500 text-black',
  P3: 'bg-blue-500 text-white',
  P4: 'bg-gray-400 text-white',
  P5: 'bg-gray-300 text-gray-700',
};

export const typeColors: Record<IssueType, string> = {
  bug: 'bg-red-100 text-red-800 border-red-200',
  feature: 'bg-green-100 text-green-800 border-green-200',
  idea: 'bg-purple-100 text-purple-800 border-purple-200',
};

// Status transitions
export const statusTransitions: Record<IssueType, Record<string, string[]>> = {
  bug: {
    open: ['fixed', 'cannot_reproduce'],
    fixed: ['closed'],
    cannot_reproduce: ['closed'],
  },
  feature: {
    open: ['approved', 'backlogged'],
    approved: ['implemented'],
    implemented: ['closed'],
  },
  idea: {
    open: ['closed', 'backlogged'],
  },
};
