package ingestion

import (
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
	"go.mongodb.org/mongo-driver/v2/bson"
)

// GitHubSweeper fetches issue/PR comments from GitHub repos linked to projects
// and creates FeedbackItems for each new comment.
type GitHubSweeper struct {
	projectService  *services.ProjectService
	feedbackService *services.FeedbackService
	token           string
	httpClient      *http.Client
}

func NewGitHubSweeper(ps *services.ProjectService, fs *services.FeedbackService, token string) *GitHubSweeper {
	return &GitHubSweeper{
		projectService:  ps,
		feedbackService: fs,
		token:           token,
		httpClient:      &http.Client{Timeout: 30 * time.Second},
	}
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

		count, err := s.sweepRepo(ctx, p.ID, repo)
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

func (s *GitHubSweeper) sweepRepo(ctx context.Context, projectID bson.ObjectID, repo string) (int, error) {
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

		pid := projectID
		feedbackReq := &models.CreateFeedbackRequest{
			ProjectID:   pid.Hex(),
			SourceType:  "github",
			SourceURL:   c.HTMLURL,
			RawContent:  c.Body,
			SubmittedBy: c.User.Login,
		}

		if _, err := s.feedbackService.Create(ctx, feedbackReq); err != nil {
			slog.Error("failed to create feedback from github comment", "url", c.HTMLURL, "error", err)
			continue
		}
		created++
	}

	if created > 0 {
		slog.Info("github sweep imported comments", "repo", repo, "count", created)
	}
	return created, nil
}
