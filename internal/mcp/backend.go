package mcp

import (
	"context"
	"time"

	"github.com/jonradoff/vibectl/internal/models"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// Backend is the data access interface for the MCP server.
// It can be backed by MongoDB services (MongoBackend) or the VibeCtl HTTP API (APIBackend).
type Backend interface {
	// Projects
	ListProjects(ctx context.Context) ([]models.Project, error)
	GetProjectByCode(ctx context.Context, code string) (*models.Project, error)

	// Issues
	ListIssues(ctx context.Context, projectCode string, filters map[string]string) ([]models.Issue, error)
	GetIssueByKey(ctx context.Context, key string) (*models.Issue, error)
	SearchIssues(ctx context.Context, query, projectCode string) ([]models.Issue, error)
	CreateIssue(ctx context.Context, projectCode string, req *models.CreateIssueRequest) (*models.Issue, error)
	UpdateIssueStatus(ctx context.Context, issueKey, newStatus string) (*models.Issue, error)
	UpdateIssue(ctx context.Context, issueKey string, req *models.UpdateIssueRequest) (*models.Issue, error)
	CountIssuesByProject(ctx context.Context, projectCode string) (map[string]int, error)
	CountIssuesByPriority(ctx context.Context, projectCode string) (map[string]int, error)

	// Sessions
	ListSessions(ctx context.Context, projectCode string) ([]models.SessionLog, error)
	GetLatestSession(ctx context.Context, projectCode string) (*models.SessionLog, error)

	// Health records
	GetHealthHistory(ctx context.Context, projectCode string, window time.Duration) ([]models.HealthRecord, error)

	// Decisions
	ListRecentDecisions(ctx context.Context, projectCode string, limit int) ([]models.Decision, error)
	RecordDecision(ctx context.Context, projectCode string, decisionType, summary, issueKey string) error

	// Prompts
	ListPromptsByProject(ctx context.Context, projectCode string) ([]models.Prompt, error)
	ListAllPrompts(ctx context.Context) ([]models.Prompt, error)
	GetPromptByID(ctx context.Context, id string) (*models.Prompt, error)

	// Feedback
	ListFeedbackByProject(ctx context.Context, projectCode string) ([]models.FeedbackItem, error)
	CreateFeedback(ctx context.Context, req *models.CreateFeedbackRequest) (*models.FeedbackItem, error)
	TriageFeedbackItem(ctx context.Context, feedbackID string) (*models.AIAnalysis, error)
	ReviewFeedback(ctx context.Context, feedbackID string, req *models.ReviewFeedbackRequest) (*models.FeedbackItem, error)
	CreateIssueFromFeedback(ctx context.Context, item *models.FeedbackItem, req *models.ReviewFeedbackRequest) (*models.Issue, error)
	LinkFeedbackToIssue(ctx context.Context, feedbackID, issueKey string) error

	// VibectlMd
	GenerateVibectlMd(ctx context.Context, projectCode string) (string, error)
	WriteVibectlMdToProject(ctx context.Context, projectCode string) error

	// Intents
	ListIntents(ctx context.Context, projectCode, status, category string, days, limit int) ([]models.Intent, error)
	GetIntentByID(ctx context.Context, id string) (*models.Intent, error)
	UpdateIntent(ctx context.Context, id string, updates map[string]interface{}) error

	// Activity Log
	ListActivityLog(ctx context.Context, projectCode string, limit int) ([]models.ActivityLog, error)

	// Multi-module
	CreateMultiModuleProject(ctx context.Context, req *models.CreateProjectRequest) (*models.Project, []models.Project, error)
	ListUnits(ctx context.Context, parentID bson.ObjectID) ([]models.Project, error)
	AddUnit(ctx context.Context, parentID bson.ObjectID, unit models.UnitDefinition) (*models.Project, error)
	GetProjectByID(ctx context.Context, id string) (*models.Project, error)
}
