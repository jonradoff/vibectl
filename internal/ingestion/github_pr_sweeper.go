package ingestion

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/jonradoff/vibectl/internal/services"
)

// PRSweeper checks open GitHub PRs linked to intents and updates their state.
type PRSweeper struct {
	intentService *services.IntentService
	githubToken   string
	httpClient    *http.Client
}

func NewPRSweeper(is *services.IntentService, githubToken string) *PRSweeper {
	return &PRSweeper{
		intentService: is,
		githubToken:   githubToken,
		httpClient:    &http.Client{Timeout: 10 * time.Second},
	}
}

// Sweep checks all intents with open PRs and updates their state.
func (s *PRSweeper) Sweep(ctx context.Context) {
	if s.githubToken == "" {
		return
	}

	// Find intents with open PR links
	intents, err := s.intentService.ListWithOpenPRs(ctx)
	if err != nil {
		slog.Error("pr sweeper: failed to list intents with open PRs", "error", err)
		return
	}

	for _, intent := range intents {
		for i, pr := range intent.PRLinks {
			if pr.State != "open" {
				continue
			}
			newState, mergedAt := s.checkPRState(ctx, pr.Repo, pr.Number)
			if newState == "" || newState == pr.State {
				continue
			}

			// Update the PR link state
			intent.PRLinks[i].State = newState
			if mergedAt != nil {
				intent.PRLinks[i].MergedAt = mergedAt
			}

			updates := bson.D{{Key: "prLinks", Value: intent.PRLinks}}
			// Auto-transition to delivered if PR merged and intent is partial/deferred
			if newState == "merged" && (intent.Status == "partial" || intent.Status == "deferred") {
				updates = append(updates, bson.E{Key: "status", Value: "delivered"})
				updates = append(updates, bson.E{Key: "statusEvidence", Value: fmt.Sprintf("PR #%d merged on GitHub", pr.Number)})
				slog.Info("pr sweeper: auto-delivering intent", "intentID", intent.ID.Hex(), "pr", pr.URL)
			}
			s.intentService.Update(ctx, intent.ID, updates)
		}
	}
}

func (s *PRSweeper) checkPRState(ctx context.Context, repo string, number int) (string, *time.Time) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/pulls/%d", repo, number)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return "", nil
	}
	req.Header.Set("Authorization", "token "+s.githubToken)
	req.Header.Set("Accept", "application/vnd.github.v3+json")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return "", nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return "", nil
	}

	var pr struct {
		State    string `json:"state"`
		Merged   bool   `json:"merged"`
		MergedAt string `json:"merged_at"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&pr); err != nil {
		return "", nil
	}

	if pr.Merged {
		var mergedAt *time.Time
		if t, err := time.Parse(time.RFC3339, pr.MergedAt); err == nil {
			mergedAt = &t
		}
		return "merged", mergedAt
	}
	if pr.State == "closed" {
		return "closed", nil
	}
	return "open", nil
}
