package mcp

import (
	"context"
	"fmt"
	"time"

	"github.com/jonradoff/vibectl/internal/agents"
	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/services"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// MongoBackend implements Backend using MongoDB-backed services.
type MongoBackend struct {
	projects      *services.ProjectService
	issues        *services.IssueService
	feedback      *services.FeedbackService
	decisions     *services.DecisionService
	sessions      *services.SessionService
	healthRecords *services.HealthRecordService
	prompts       *services.PromptService
	vibectlMd     *services.VibectlMdService
	triageAgent   *agents.TriageAgent
}

func NewMongoBackend(
	ps *services.ProjectService,
	is *services.IssueService,
	fs *services.FeedbackService,
	ds *services.DecisionService,
	ss *services.SessionService,
	hrs *services.HealthRecordService,
	proms *services.PromptService,
	vm *services.VibectlMdService,
) *MongoBackend {
	return &MongoBackend{
		projects: ps, issues: is, feedback: fs,
		decisions: ds, sessions: ss, healthRecords: hrs,
		prompts: proms, vibectlMd: vm,
	}
}

// SetTriageAgent injects the triage agent (optional — only available when ANTHROPIC_API_KEY is set).
func (b *MongoBackend) SetTriageAgent(ta *agents.TriageAgent) {
	b.triageAgent = ta
}

func (b *MongoBackend) ListProjects(ctx context.Context) ([]models.Project, error) {
	return b.projects.List(ctx)
}

func (b *MongoBackend) GetProjectByCode(ctx context.Context, code string) (*models.Project, error) {
	return b.projects.GetByCode(ctx, code)
}

func (b *MongoBackend) ListIssues(ctx context.Context, projectID string, filters map[string]string) ([]models.Issue, error) {
	return b.issues.ListByProject(ctx, projectID, filters)
}

func (b *MongoBackend) GetIssueByKey(ctx context.Context, key string) (*models.Issue, error) {
	return b.issues.GetByKey(ctx, key)
}

func (b *MongoBackend) SearchIssues(ctx context.Context, query, projectID string) ([]models.Issue, error) {
	return b.issues.Search(ctx, query, projectID)
}

func (b *MongoBackend) CreateIssue(ctx context.Context, projectID string, req *models.CreateIssueRequest) (*models.Issue, error) {
	return b.issues.Create(ctx, projectID, req)
}

func (b *MongoBackend) UpdateIssueStatus(ctx context.Context, issueKey, newStatus string) (*models.Issue, error) {
	return b.issues.TransitionStatus(ctx, issueKey, newStatus)
}

func (b *MongoBackend) UpdateIssue(ctx context.Context, issueKey string, req *models.UpdateIssueRequest) (*models.Issue, error) {
	return b.issues.Update(ctx, issueKey, req)
}

func (b *MongoBackend) CountIssuesByProject(ctx context.Context, projectID bson.ObjectID) (map[string]int, error) {
	return b.issues.CountByProject(ctx, projectID)
}

func (b *MongoBackend) CountIssuesByPriority(ctx context.Context, projectID bson.ObjectID) (map[string]int, error) {
	return b.issues.CountByPriority(ctx, projectID)
}

func (b *MongoBackend) ListSessions(ctx context.Context, projectID string) ([]models.SessionLog, error) {
	return b.sessions.ListByProject(ctx, projectID)
}

func (b *MongoBackend) GetLatestSession(ctx context.Context, projectID string) (*models.SessionLog, error) {
	return b.sessions.GetLatest(ctx, projectID)
}

func (b *MongoBackend) GetHealthHistory(ctx context.Context, projectID string, window time.Duration) ([]models.HealthRecord, error) {
	return b.healthRecords.GetHistory(ctx, projectID, window)
}

func (b *MongoBackend) ListRecentDecisions(ctx context.Context, projectID string, limit int) ([]models.Decision, error) {
	return b.decisions.ListRecent(ctx, projectID, limit)
}

func (b *MongoBackend) RecordDecision(ctx context.Context, projectID bson.ObjectID, decisionType, summary, issueKey string) error {
	return b.decisions.Record(ctx, projectID, decisionType, summary, issueKey)
}

func (b *MongoBackend) ListPromptsByProject(ctx context.Context, projectID string) ([]models.Prompt, error) {
	return b.prompts.ListByProject(ctx, projectID, nil)
}

func (b *MongoBackend) ListAllPrompts(ctx context.Context) ([]models.Prompt, error) {
	return b.prompts.ListAll(ctx, nil)
}

func (b *MongoBackend) GetPromptByID(ctx context.Context, id string) (*models.Prompt, error) {
	return b.prompts.GetByID(ctx, id)
}

func (b *MongoBackend) GenerateVibectlMd(ctx context.Context, projectID string) (string, error) {
	return b.vibectlMd.Generate(ctx, projectID)
}

func (b *MongoBackend) WriteVibectlMdToProject(ctx context.Context, projectID string) error {
	return b.vibectlMd.WriteToProject(ctx, projectID)
}

func (b *MongoBackend) ListFeedbackByProject(ctx context.Context, projectID string) ([]models.FeedbackItem, error) {
	return b.feedback.ListByProject(ctx, projectID)
}

func (b *MongoBackend) CreateFeedback(ctx context.Context, req *models.CreateFeedbackRequest) (*models.FeedbackItem, error) {
	return b.feedback.Create(ctx, req)
}

func (b *MongoBackend) TriageFeedbackItem(ctx context.Context, feedbackID string) (*models.AIAnalysis, error) {
	if b.triageAgent == nil {
		return nil, fmt.Errorf("triage agent not configured (ANTHROPIC_API_KEY missing)")
	}
	analysis, err := b.triageAgent.TriageItem(ctx, feedbackID)
	if err != nil {
		return nil, err
	}
	_ = b.feedback.SetTriaged(ctx, feedbackID)
	return analysis, nil
}

func (b *MongoBackend) ReviewFeedback(ctx context.Context, feedbackID string, req *models.ReviewFeedbackRequest) (*models.FeedbackItem, error) {
	return b.feedback.Review(ctx, feedbackID, req)
}

func (b *MongoBackend) CreateIssueFromFeedback(ctx context.Context, item *models.FeedbackItem, req *models.ReviewFeedbackRequest) (*models.Issue, error) {
	if item.ProjectID == nil {
		return nil, fmt.Errorf("feedback has no project")
	}
	projectID := item.ProjectID.Hex()

	title := req.IssueTitle
	description := req.IssueDescription
	issueType := models.IssueType(req.IssueType)
	priority := models.Priority(req.IssuePriority)
	reproSteps := ""

	if item.AIAnalysis != nil && item.AIAnalysis.ProposedIssue != nil {
		p := item.AIAnalysis.ProposedIssue
		if title == "" {
			title = p.Title
		}
		if description == "" {
			description = p.Description
		}
		if issueType == "" {
			issueType = models.IssueType(p.Type)
		}
		if priority == "" {
			priority = models.Priority(p.Priority)
		}
		if p.ReproSteps != "" {
			reproSteps = p.ReproSteps
		}
	}

	if title == "" {
		title = item.RawContent
		if len(title) > 100 {
			title = title[:100]
		}
	}
	if description == "" {
		description = item.RawContent
	}
	if !models.ValidIssueType(string(issueType)) {
		issueType = models.IssueTypeIdea
	}
	if !models.ValidPriority(string(priority)) {
		priority = models.PriorityP3
	}

	createReq := &models.CreateIssueRequest{
		Title:            title,
		Description:      description,
		Type:             issueType,
		Priority:         priority,
		Source:           "feedback",
		SourceFeedbackID: item.ID.Hex(),
		ReproSteps:       reproSteps,
		CreatedBy:        item.SubmittedBy,
	}
	issue, err := b.issues.Create(ctx, projectID, createReq)
	if err != nil {
		return nil, err
	}
	_ = b.feedback.LinkToIssue(ctx, item.ID.Hex(), issue.IssueKey)
	return issue, nil
}

func (b *MongoBackend) LinkFeedbackToIssue(ctx context.Context, feedbackID, issueKey string) error {
	return b.feedback.LinkToIssue(ctx, feedbackID, issueKey)
}
