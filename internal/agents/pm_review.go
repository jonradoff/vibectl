package agents

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/services"
)

type PMReviewAgent struct {
	projectService *services.ProjectService
	issueService   *services.IssueService
	aiClient       *AIClient
}

func NewPMReviewAgent(ps *services.ProjectService, is *services.IssueService, apiKey string) *PMReviewAgent {
	return &PMReviewAgent{
		projectService: ps,
		issueService:   is,
		aiClient:       NewAIClient(apiKey),
	}
}

func (a *PMReviewAgent) Review(ctx context.Context, projectID string) (*models.PMReviewResult, error) {
	project, err := a.projectService.GetByID(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("getting project: %w", err)
	}

	issues, err := a.issueService.ListByProject(ctx, projectID, map[string]string{})
	if err != nil {
		return nil, fmt.Errorf("listing issues: %w", err)
	}

	var openIssues, closedIssues []models.Issue
	cutoff := time.Now().AddDate(0, 0, -30)
	for _, issue := range issues {
		if issue.Status == "closed" {
			if issue.UpdatedAt.After(cutoff) {
				closedIssues = append(closedIssues, issue)
			}
		} else {
			openIssues = append(openIssues, issue)
		}
	}

	prompt := buildPMReviewPrompt(project, openIssues, closedIssues)

	response, err := a.aiClient.Complete(ctx, prompt)
	if err != nil {
		return nil, fmt.Errorf("AI completion: %w", err)
	}

	var result models.PMReviewResult
	if err := json.Unmarshal([]byte(response), &result); err != nil {
		return nil, fmt.Errorf("parsing AI response: %w", err)
	}

	result.ProjectCode = projectID
	result.CreatedAt = time.Now().UTC().Format(time.RFC3339)

	return &result, nil
}

func buildPMReviewPrompt(project *models.Project, openIssues, closedIssues []models.Issue) string {
	goalsJSON, _ := json.MarshalIndent(project.Goals, "", "  ")
	openJSON, _ := json.MarshalIndent(openIssues, "", "  ")
	closedJSON, _ := json.MarshalIndent(closedIssues, "", "  ")

	return fmt.Sprintf(`You are an expert product manager reviewing the project "%s" (%s).

Project goals:
%s

Current open issues:
%s

Recently closed issues (last 30 days):
%s

Perform a gap analysis:
1. For each goal, assess whether current issues adequately address it
2. Identify gaps — goals that have no corresponding issues or insufficient coverage
3. Identify risks — P0/P1 issues that have been open too long
4. Suggest new issues to fill gaps, with title, description, type, and priority
5. Suggest reprioritizations if any current priorities seem misaligned with goals

Return as JSON only:
{
  "goalAssessments": [{"goal": "...", "coverage": "good|partial|missing", "notes": "..."}],
  "gaps": [{"description": "...", "suggestedIssue": {"title": "", "description": "", "type": "", "priority": ""}}],
  "risks": [{"issueKey": "...", "concern": "..."}],
  "reprioritizations": [{"issueKey": "...", "currentPriority": "...", "suggestedPriority": "...", "reason": "..."}],
  "overallAssessment": "..."
}`,
		project.Name, project.Code,
		string(goalsJSON), string(openJSON), string(closedJSON),
	)
}
