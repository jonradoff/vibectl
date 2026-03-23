package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jonradoff/vibectl/internal/models"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// APIBackend implements Backend by calling the VibeCtl REST API.
type APIBackend struct {
	baseURL    string
	apiToken   string
	httpClient *http.Client
}

func NewAPIBackend(baseURL, apiToken string) *APIBackend {
	return &APIBackend{
		baseURL:    strings.TrimRight(baseURL, "/"),
		apiToken:   apiToken,
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}
}

func (b *APIBackend) doGet(ctx context.Context, path string, out interface{}) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, b.baseURL+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+b.apiToken)
	req.Header.Set("Accept", "application/json")
	resp, err := b.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API error %d: %s", resp.StatusCode, string(body))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (b *APIBackend) doGetText(ctx context.Context, path string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, b.baseURL+path, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+b.apiToken)
	resp, err := b.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("API error %d: %s", resp.StatusCode, string(body))
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func (b *APIBackend) doPost(ctx context.Context, path string, in, out interface{}) error {
	body, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+b.apiToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := b.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API error %d: %s", resp.StatusCode, string(respBody))
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

func (b *APIBackend) doPut(ctx context.Context, path string, in, out interface{}) error {
	body, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, b.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+b.apiToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := b.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API error %d: %s", resp.StatusCode, string(respBody))
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

func (b *APIBackend) doPatch(ctx context.Context, path string, in, out interface{}) error {
	body, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPatch, b.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+b.apiToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := b.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API error %d: %s", resp.StatusCode, string(respBody))
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

// ListProjects calls GET /api/v1/projects/
func (b *APIBackend) ListProjects(ctx context.Context) ([]models.Project, error) {
	var projects []models.Project
	if err := b.doGet(ctx, "/api/v1/projects/", &projects); err != nil {
		return nil, err
	}
	return projects, nil
}

// GetProjectByCode calls GET /api/v1/projects/code/{code}
func (b *APIBackend) GetProjectByCode(ctx context.Context, code string) (*models.Project, error) {
	var project models.Project
	if err := b.doGet(ctx, "/api/v1/projects/code/"+url.PathEscape(code), &project); err != nil {
		return nil, err
	}
	return &project, nil
}

// ListIssues calls GET /api/v1/projects/{id}/issues with optional filter query params.
func (b *APIBackend) ListIssues(ctx context.Context, projectID string, filters map[string]string) ([]models.Issue, error) {
	path := "/api/v1/projects/" + url.PathEscape(projectID) + "/issues"
	if len(filters) > 0 {
		params := url.Values{}
		for k, v := range filters {
			params.Set(k, v)
		}
		path += "?" + params.Encode()
	}
	var issues []models.Issue
	if err := b.doGet(ctx, path, &issues); err != nil {
		return nil, err
	}
	return issues, nil
}

// GetIssueByKey calls GET /api/v1/issues/{issueKey}
func (b *APIBackend) GetIssueByKey(ctx context.Context, key string) (*models.Issue, error) {
	var issue models.Issue
	if err := b.doGet(ctx, "/api/v1/issues/"+url.PathEscape(key), &issue); err != nil {
		return nil, err
	}
	return &issue, nil
}

// SearchIssues calls GET /api/v1/issues/search?q={query}&projectId={projectID}
func (b *APIBackend) SearchIssues(ctx context.Context, query, projectID string) ([]models.Issue, error) {
	params := url.Values{}
	params.Set("q", query)
	if projectID != "" {
		params.Set("projectId", projectID)
	}
	var issues []models.Issue
	if err := b.doGet(ctx, "/api/v1/issues/search?"+params.Encode(), &issues); err != nil {
		return nil, err
	}
	return issues, nil
}

// CreateIssue calls POST /api/v1/projects/{id}/issues
func (b *APIBackend) CreateIssue(ctx context.Context, projectID string, req *models.CreateIssueRequest) (*models.Issue, error) {
	var issue models.Issue
	if err := b.doPost(ctx, "/api/v1/projects/"+url.PathEscape(projectID)+"/issues", req, &issue); err != nil {
		return nil, err
	}
	return &issue, nil
}

// UpdateIssueStatus calls PATCH /api/v1/issues/{issueKey}/status
func (b *APIBackend) UpdateIssueStatus(ctx context.Context, issueKey, newStatus string) (*models.Issue, error) {
	body := map[string]string{"status": newStatus}
	var issue models.Issue
	if err := b.doPatch(ctx, "/api/v1/issues/"+url.PathEscape(issueKey)+"/status", body, &issue); err != nil {
		return nil, err
	}
	return &issue, nil
}

// UpdateIssue calls PUT /api/v1/issues/{issueKey}
func (b *APIBackend) UpdateIssue(ctx context.Context, issueKey string, req *models.UpdateIssueRequest) (*models.Issue, error) {
	var issue models.Issue
	if err := b.doPut(ctx, "/api/v1/issues/"+url.PathEscape(issueKey), req, &issue); err != nil {
		return nil, err
	}
	return &issue, nil
}

// CountIssuesByProject computes status counts by fetching all issues.
func (b *APIBackend) CountIssuesByProject(ctx context.Context, projectID bson.ObjectID) (map[string]int, error) {
	issues, err := b.ListIssues(ctx, projectID.Hex(), nil)
	if err != nil {
		return nil, err
	}
	counts := map[string]int{}
	for _, issue := range issues {
		counts[string(issue.Status)]++
	}
	return counts, nil
}

// CountIssuesByPriority computes priority counts by fetching all issues.
func (b *APIBackend) CountIssuesByPriority(ctx context.Context, projectID bson.ObjectID) (map[string]int, error) {
	issues, err := b.ListIssues(ctx, projectID.Hex(), nil)
	if err != nil {
		return nil, err
	}
	counts := map[string]int{}
	for _, issue := range issues {
		counts[string(issue.Priority)]++
	}
	return counts, nil
}

// ListSessions calls GET /api/v1/projects/{id}/sessions
func (b *APIBackend) ListSessions(ctx context.Context, projectID string) ([]models.SessionLog, error) {
	var sessions []models.SessionLog
	if err := b.doGet(ctx, "/api/v1/projects/"+url.PathEscape(projectID)+"/sessions", &sessions); err != nil {
		return nil, err
	}
	return sessions, nil
}

// GetLatestSession calls GET /api/v1/projects/{id}/sessions/latest
func (b *APIBackend) GetLatestSession(ctx context.Context, projectID string) (*models.SessionLog, error) {
	var session models.SessionLog
	if err := b.doGet(ctx, "/api/v1/projects/"+url.PathEscape(projectID)+"/sessions/latest", &session); err != nil {
		return nil, err
	}
	return &session, nil
}

// GetHealthHistory calls GET /api/v1/projects/{id}/healthcheck/history
func (b *APIBackend) GetHealthHistory(ctx context.Context, projectID string, window time.Duration) ([]models.HealthRecord, error) {
	var records []models.HealthRecord
	if err := b.doGet(ctx, "/api/v1/projects/"+url.PathEscape(projectID)+"/healthcheck/history", &records); err != nil {
		return nil, err
	}
	return records, nil
}

// ListRecentDecisions calls GET /api/v1/projects/{id}/decisions?limit={limit}
func (b *APIBackend) ListRecentDecisions(ctx context.Context, projectID string, limit int) ([]models.Decision, error) {
	path := fmt.Sprintf("/api/v1/projects/%s/decisions?limit=%d", url.PathEscape(projectID), limit)
	var decisions []models.Decision
	if err := b.doGet(ctx, path, &decisions); err != nil {
		return nil, err
	}
	return decisions, nil
}

// RecordDecision is not supported via the REST API (no POST /decisions endpoint).
func (b *APIBackend) RecordDecision(ctx context.Context, projectID bson.ObjectID, decisionType, summary, issueKey string) error {
	return fmt.Errorf("RecordDecision is not supported in API mode: no POST /decisions endpoint available")
}

// ListPromptsByProject calls GET /api/v1/projects/{id}/prompts
func (b *APIBackend) ListPromptsByProject(ctx context.Context, projectID string) ([]models.Prompt, error) {
	var prompts []models.Prompt
	if err := b.doGet(ctx, "/api/v1/projects/"+url.PathEscape(projectID)+"/prompts", &prompts); err != nil {
		return nil, err
	}
	return prompts, nil
}

// ListAllPrompts calls GET /api/v1/prompts/
func (b *APIBackend) ListAllPrompts(ctx context.Context) ([]models.Prompt, error) {
	var prompts []models.Prompt
	if err := b.doGet(ctx, "/api/v1/prompts/", &prompts); err != nil {
		return nil, err
	}
	return prompts, nil
}

// GetPromptByID calls GET /api/v1/prompts/{promptId}
func (b *APIBackend) GetPromptByID(ctx context.Context, id string) (*models.Prompt, error) {
	var prompt models.Prompt
	if err := b.doGet(ctx, "/api/v1/prompts/"+url.PathEscape(id), &prompt); err != nil {
		return nil, err
	}
	return &prompt, nil
}

// GenerateVibectlMd calls GET /api/v1/projects/{id}/vibectl-md/preview (generates without writing).
func (b *APIBackend) GenerateVibectlMd(ctx context.Context, projectID string) (string, error) {
	return b.doGetText(ctx, "/api/v1/projects/"+url.PathEscape(projectID)+"/vibectl-md/preview")
}

// WriteVibectlMdToProject calls POST /api/v1/projects/{id}/vibectl-md/generate
func (b *APIBackend) WriteVibectlMdToProject(ctx context.Context, projectID string) error {
	return b.doPost(ctx, "/api/v1/projects/"+url.PathEscape(projectID)+"/vibectl-md/generate", nil, nil)
}

// ListFeedbackByProject calls GET /api/v1/projects/{id}/feedback
func (b *APIBackend) ListFeedbackByProject(ctx context.Context, projectID string) ([]models.FeedbackItem, error) {
	var items []models.FeedbackItem
	if err := b.doGet(ctx, "/api/v1/projects/"+url.PathEscape(projectID)+"/feedback", &items); err != nil {
		return nil, err
	}
	return items, nil
}

// CreateFeedback calls POST /api/v1/feedback
func (b *APIBackend) CreateFeedback(ctx context.Context, req *models.CreateFeedbackRequest) (*models.FeedbackItem, error) {
	var item models.FeedbackItem
	if err := b.doPost(ctx, "/api/v1/feedback", req, &item); err != nil {
		return nil, err
	}
	return &item, nil
}

// TriageFeedbackItem calls POST /api/v1/feedback/{id}/triage
func (b *APIBackend) TriageFeedbackItem(ctx context.Context, feedbackID string) (*models.AIAnalysis, error) {
	var analysis models.AIAnalysis
	if err := b.doPost(ctx, "/api/v1/feedback/"+url.PathEscape(feedbackID)+"/triage", nil, &analysis); err != nil {
		return nil, err
	}
	return &analysis, nil
}

// ReviewFeedback calls PATCH /api/v1/feedback/{id}/review
func (b *APIBackend) ReviewFeedback(ctx context.Context, feedbackID string, req *models.ReviewFeedbackRequest) (*models.FeedbackItem, error) {
	var item models.FeedbackItem
	if err := b.doPatch(ctx, "/api/v1/feedback/"+url.PathEscape(feedbackID)+"/review", req, &item); err != nil {
		return nil, err
	}
	return &item, nil
}

// CreateIssueFromFeedback reviews the feedback (accept+createIssue) via a single API call.
func (b *APIBackend) CreateIssueFromFeedback(ctx context.Context, item *models.FeedbackItem, req *models.ReviewFeedbackRequest) (*models.Issue, error) {
	// The REST API handles issue creation as part of the review endpoint when createIssue=true.
	// Re-call review with createIssue=true and parse the linked issue key from the response.
	reviewReq := *req
	reviewReq.Action = "accept"
	reviewReq.CreateIssue = true
	var updated models.FeedbackItem
	if err := b.doPatch(ctx, "/api/v1/feedback/"+url.PathEscape(item.ID.Hex())+"/review", reviewReq, &updated); err != nil {
		return nil, err
	}
	if updated.LinkedIssueKey == "" {
		return nil, fmt.Errorf("issue was not created")
	}
	return b.GetIssueByKey(ctx, updated.LinkedIssueKey)
}

// LinkFeedbackToIssue is not directly exposed via REST; no-op in API mode.
func (b *APIBackend) LinkFeedbackToIssue(_ context.Context, _, _ string) error {
	return nil
}
