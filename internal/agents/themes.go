package agents

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/services"
)

// ThemesAgent analyzes feedback and issues to identify recurring themes.
type ThemesAgent struct {
	feedbackService *services.FeedbackService
	issueService    *services.IssueService
	projectService  *services.ProjectService
	aiClient        *AIClient
}

func NewThemesAgent(fs *services.FeedbackService, is *services.IssueService, ps *services.ProjectService, apiKey string) *ThemesAgent {
	return &ThemesAgent{
		feedbackService: fs,
		issueService:    is,
		projectService:  ps,
		aiClient:        NewAIClient(apiKey),
	}
}

// AnalyzeThemes generates recurring themes for a project from recent feedback and issues.
func (a *ThemesAgent) AnalyzeThemes(ctx context.Context, projectID string) ([]models.RecurringTheme, error) {
	project, err := a.projectService.GetByID(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("getting project: %w", err)
	}

	// Get feedback for this project
	feedback, err := a.feedbackService.ListByProject(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("listing feedback: %w", err)
	}
	if len(feedback) == 0 {
		return nil, nil
	}

	// Get open issues
	issues, _ := a.issueService.ListByProject(ctx, projectID, nil)

	prompt := buildThemesPrompt(project.Name, feedback, issues)
	response, err := a.aiClient.Complete(ctx, prompt)
	if err != nil {
		return nil, fmt.Errorf("AI completion: %w", err)
	}

	var themes []models.RecurringTheme
	if err := json.Unmarshal([]byte(response), &themes); err != nil {
		return nil, fmt.Errorf("parsing AI response: %w", err)
	}

	now := time.Now().UTC()
	for i := range themes {
		themes[i].UpdatedAt = now
	}

	return themes, nil
}

func buildThemesPrompt(projectName string, feedback []models.FeedbackItem, issues []models.Issue) string {
	type feedbackSummary struct {
		Content     string              `json:"content"`
		Source      string              `json:"source"`
		Analysis    *models.AIAnalysis  `json:"analysis,omitempty"`
	}
	var fbItems []feedbackSummary
	for _, fb := range feedback {
		fbItems = append(fbItems, feedbackSummary{
			Content:  fb.RawContent,
			Source:   fb.SourceType,
			Analysis: fb.AIAnalysis,
		})
	}

	type issueSummary struct {
		Key      string `json:"key"`
		Title    string `json:"title"`
		Type     string `json:"type"`
		Priority string `json:"priority"`
		Status   string `json:"status"`
	}
	var issItems []issueSummary
	for _, iss := range issues {
		issItems = append(issItems, issueSummary{
			Key:      iss.IssueKey,
			Title:    iss.Title,
			Type:     string(iss.Type),
			Priority: string(iss.Priority),
			Status:   iss.Status,
		})
	}

	fbJSON, _ := json.MarshalIndent(fbItems, "", "  ")
	issJSON, _ := json.MarshalIndent(issItems, "", "  ")

	return fmt.Sprintf(`You are analyzing patterns in user feedback for the project "%s".

Here are the recent feedback items with their triage analysis:
%s

Here are the current open issues:
%s

Identify 3-5 recurring themes — patterns where multiple pieces of feedback or issues cluster around the same area. For each theme, note:
- A concise description (one sentence)
- How many feedback items relate to it
- Which existing issues (by key) are related

Return as JSON array only (no markdown, no explanation):
[{"theme": "...", "feedbackCount": 1, "relatedIssues": ["KEY-0001"]}]`,
		projectName, string(fbJSON), string(issJSON))
}
