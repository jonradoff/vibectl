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
  recurringThemes?: RecurringTheme[];
  architectureSummary?: string;
  architectureUpdatedAt?: string;
  vibectlMdGeneratedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppSettings {
  vibectlMdAutoRegen: boolean;
  vibectlMdSchedule: string;
  updatedAt: string;
}

export type IssueType = 'bug' | 'feature' | 'idea';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5';
export type TriageStatus = 'pending' | 'reviewed' | 'accepted' | 'dismissed';
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
  issuesByPriority: Record<string, number>;
  issuesByStatus: Record<string, number>;
  issuesByType: Record<string, number>;
  lastSession?: SessionLog;
}

export interface GlobalDashboard {
  totalProjects: number;
  totalOpenIssues: number;
  pendingFeedback: number;
  projectSummaries: ProjectSummary[];
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
  createdAt: string;
  updatedAt: string;
}

export interface ActivityLogEntry {
  id: string;
  projectId?: string;
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

// Color maps
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
