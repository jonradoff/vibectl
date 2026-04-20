package ingestion

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/services"
)

// DelegationChecker provides read-only access to delegation state for the sweeper.
type DelegationChecker interface {
	IsEnabled() bool
	IsHealthy() bool
	GetAPIKey() string
	GetRemoteURL() string
}

// GitHubSweeper fetches issue/PR comments from GitHub repos linked to projects
// and creates FeedbackItems for each new comment.
type GitHubSweeper struct {
	projectService  *services.ProjectService
	feedbackService *services.FeedbackService
	token           string
	httpClient      *http.Client
	delegation      DelegationChecker
}

func NewGitHubSweeper(ps *services.ProjectService, fs *services.FeedbackService, token string) *GitHubSweeper {
	return &GitHubSweeper{
		projectService:  ps,
		feedbackService: fs,
		token:           token,
		httpClient:      &http.Client{Timeout: 30 * time.Second},
	}
}

// SetDelegation sets the delegation checker for pushing feedback to the remote server.
func (s *GitHubSweeper) SetDelegation(d DelegationChecker) {
	s.delegation = d
}

// repoPattern extracts owner/repo from a GitHub URL.
var repoPattern = regexp.MustCompile(`github\.com/([^/]+/[^/]+)`)

// Sweep iterates all projects with a githubUrl, fetches recent issue comments,
// and creates feedback items for any not already ingested.
func (s *GitHubSweeper) Sweep(ctx context.Context) (int, error) {
	projects, err := s.projectService.List(ctx)
	if err != nil {
		return 0, fmt.Errorf("list projects: %w", err)
	}

	total := 0
	for _, p := range projects {
		if p.Links.GitHubURL == "" {
			continue
		}
		matches := repoPattern.FindStringSubmatch(p.Links.GitHubURL)
		if len(matches) < 2 {
			continue
		}
		repo := strings.TrimSuffix(matches[1], ".git")

		count, err := s.sweepRepo(ctx, p.Code, repo)
		if err != nil {
			slog.Error("github sweep failed for repo", "repo", repo, "error", err)
			continue
		}
		total += count
	}
	return total, nil
}

type ghComment struct {
	ID        int       `json:"id"`
	Body      string    `json:"body"`
	HTMLURL   string    `json:"html_url"`
	CreatedAt time.Time `json:"created_at"`
	User      struct {
		Login string `json:"login"`
	} `json:"user"`
}

func (s *GitHubSweeper) sweepRepo(ctx context.Context, projectCode string, repo string) (int, error) {
	// Fetch comments from the last 24 hours.
	since := time.Now().Add(-24 * time.Hour).UTC().Format(time.RFC3339)
	url := fmt.Sprintf("https://api.github.com/repos/%s/issues/comments?since=%s&sort=created&direction=desc&per_page=100", repo, since)

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	if s.token != "" {
		req.Header.Set("Authorization", "Bearer "+s.token)
	}

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return 0, fmt.Errorf("github api request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("github api returned %d", resp.StatusCode)
	}

	var comments []ghComment
	if err := json.NewDecoder(resp.Body).Decode(&comments); err != nil {
		return 0, fmt.Errorf("decode github response: %w", err)
	}

	created := 0
	for _, c := range comments {
		if c.Body == "" {
			continue
		}

		// Deduplicate by sourceUrl.
		existing, _ := s.feedbackService.FindBySourceURL(ctx, c.HTMLURL)
		if existing != nil {
			continue
		}

		feedbackReq := &models.CreateFeedbackRequest{
			ProjectCode: projectCode,
			SourceType:  "github",
			SourceURL:   c.HTMLURL,
			RawContent:  c.Body,
			SubmittedBy: c.User.Login,
		}

		if _, err := s.feedbackService.Create(ctx, feedbackReq); err != nil {
			slog.Error("failed to create feedback from github comment", "url", c.HTMLURL, "error", err)
			continue
		}

		// Push to remote server when delegation is active
		s.pushToRemote(ctx, feedbackReq)

		created++
	}

	if created > 0 {
		slog.Info("github sweep imported comments", "repo", repo, "count", created)
	}
	return created, nil
}

// pushToRemote POSTs a feedback item to the remote server if delegation is active and healthy.
func (s *GitHubSweeper) pushToRemote(ctx context.Context, req *models.CreateFeedbackRequest) {
	if s.delegation == nil || !s.delegation.IsEnabled() || !s.delegation.IsHealthy() {
		return
	}

	body, err := json.Marshal(req)
	if err != nil {
		slog.Error("github sweep: marshal feedback for remote", "error", err)
		return
	}

	remoteURL := s.delegation.GetRemoteURL() + "/api/v1/feedback"
	httpReq, err := http.NewRequestWithContext(ctx, "POST", remoteURL, bytes.NewReader(body))
	if err != nil {
		slog.Error("github sweep: create remote request", "error", err)
		return
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+s.delegation.GetAPIKey())

	resp, err := s.httpClient.Do(httpReq)
	if err != nil {
		slog.Warn("github sweep: push to remote failed", "error", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusConflict {
		// Duplicate on remote — that's fine
		return
	}
	if resp.StatusCode >= 300 {
		slog.Warn("github sweep: remote returned error", "status", resp.StatusCode)
	}
}
