package services

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/jonradoff/vibectl/internal/models"
)

// AICompleter is the interface for making Claude API calls (avoids circular import with agents).
type AICompleter interface {
	CompleteWithModel(ctx context.Context, prompt string, model string) (string, error)
}

// IntentDelegationPusher provides read-only delegation state for pushing intents to remote.
type IntentDelegationPusher interface {
	IsEnabled() bool
	IsHealthy() bool
	GetAPIKey() string
	GetRemoteURL() string
}

type IntentExtractor struct {
	intentService    *IntentService
	codeDeltaService *CodeDeltaService
	usageService     *ClaudeUsageService
	aiClient         AICompleter
	delegation       IntentDelegationPusher
}

func NewIntentExtractor(is *IntentService, cds *CodeDeltaService, us *ClaudeUsageService, ai AICompleter) *IntentExtractor {
	return &IntentExtractor{
		intentService:    is,
		codeDeltaService: cds,
		usageService:     us,
		aiClient:         ai,
	}
}

// SetDelegation sets the delegation pusher for sending intents to the remote server.
func (e *IntentExtractor) SetDelegation(d IntentDelegationPusher) {
	e.delegation = d
}

// pushIntentToRemote POSTs an intent to the remote server if delegation is active.
func (e *IntentExtractor) pushIntentToRemote(intent *models.Intent) {
	if e.delegation == nil || !e.delegation.IsEnabled() || !e.delegation.IsHealthy() {
		return
	}
	body, err := json.Marshal(intent)
	if err != nil {
		slog.Error("intent push: marshal failed", "error", err)
		return
	}
	remoteURL := e.delegation.GetRemoteURL() + "/api/v1/intents/ingest"
	req, err := http.NewRequest("POST", remoteURL, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+e.delegation.GetAPIKey())
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		slog.Warn("intent push: remote request failed", "error", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		slog.Warn("intent push: remote returned error", "status", resp.StatusCode)
	}
}

// sessionSummary is the condensed data sent to Haiku for analysis.
type sessionSummary struct {
	ProjectCode    string   `json:"projectCode"`
	SessionID      string   `json:"sessionId"`
	DurationSecs   int64    `json:"durationSecs"`
	UserPrompts    []string `json:"userPrompts"`
	ToolsUsed      []string `json:"toolsUsed"`
	FilesEdited    []string `json:"filesEdited"`
	BashCommands   []string `json:"bashCommands"`
	FilesFromDelta []string `json:"filesFromDelta"`
	TokensInput    int64    `json:"tokensInput"`
	TokensOutput   int64    `json:"tokensOutput"`
	HasCommits     bool     `json:"hasCommits"`
	HasPR          bool     `json:"hasPR"`
	BranchName     string   `json:"branchName"`
	PromptCount    int      `json:"promptCount"`
	PromptBatchID  string   `json:"-"` // extracted from <!-- prompt-batch:ID --> marker in user messages
}

// extractedIntent is the JSON structure expected from Haiku.
type extractedIntent struct {
	Title          string   `json:"title"`
	Description    string   `json:"description"`
	Category       string   `json:"category"`
	TechTags       []string `json:"techTags"`
	UXJudgment     string   `json:"uxJudgment"`
	Size           string   `json:"size"`
	Status         string   `json:"status"`
	StatusEvidence string   `json:"statusEvidence"`
	MergeWithID    string   `json:"mergeWithId,omitempty"` // if set, merge into existing intent instead of creating new
}

// ExtractFromSession analyzes a chat session and creates intent records.
func (e *IntentExtractor) ExtractFromSession(ctx context.Context, entry *models.ChatHistoryEntry) error {
	if e.aiClient == nil {
		return fmt.Errorf("no AI client configured")
	}

	slog.Info("extracting intent", "sessionID", entry.ClaudeSessionID, "projectCode", entry.ProjectCode, "messages", len(entry.Messages))

	summary := e.buildSummary(ctx, entry)
	if summary.PromptCount == 0 {
		slog.Info("skipping session — no user prompts, marking as analyzed", "sessionID", entry.ClaudeSessionID)
		// Create a minimal intent to mark this session as analyzed so it's not re-processed
		skip := &models.Intent{
			ProjectCode: entry.ProjectCode,
			UserID:      entry.UserID,
			UserName:    entry.UserName,
			SessionIDs:  []string{entry.ClaudeSessionID},
			Title:      "(no extractable content)",
			Status:     "abandoned",
			Size:       "S",
			SizePoints: 0,
			StartedAt:  entry.StartedAt,
			CompletedAt: entry.EndedAt,
			AnalysisModel: "skip",
		}
		e.intentService.Create(ctx, skip)
		return nil
	}

	// Fetch recent intents for merge detection
	var recentIntents []models.Intent
	if entry.ProjectCode != "" {
		recentIntents, _ = e.intentService.ListRecent(ctx, entry.ProjectCode, 7)
	}

	prompt := buildExtractionPrompt(summary, recentIntents)

	resp, err := e.aiClient.CompleteWithModel(ctx, prompt, "claude-haiku-4-5-20251001")
	if err != nil {
		return fmt.Errorf("haiku extraction: %w", err)
	}

	// Parse the JSON response — expect an array of intents
	var intents []extractedIntent
	// Try array first, then single object
	if err := json.Unmarshal([]byte(resp), &intents); err != nil {
		var single extractedIntent
		if err2 := json.Unmarshal([]byte(resp), &single); err2 != nil {
			// Try extracting JSON from markdown code block
			if idx := strings.Index(resp, "["); idx >= 0 {
				if end := strings.LastIndex(resp, "]"); end > idx {
					json.Unmarshal([]byte(resp[idx:end+1]), &intents)
				}
			}
			if len(intents) == 0 {
				if idx := strings.Index(resp, "{"); idx >= 0 {
					if end := strings.LastIndex(resp, "}"); end > idx {
						json.Unmarshal([]byte(resp[idx:end+1]), &single)
						if single.Title != "" {
							intents = []extractedIntent{single}
						}
					}
				}
			}
			if len(intents) == 0 {
				return fmt.Errorf("failed to parse extraction response")
			}
		} else {
			intents = []extractedIntent{single}
		}
	}

	// Convert to Intent models and store.
	// When multiple intents are extracted from one session, split tokens/duration
	// proportionally by size points so they don't all show the full session total.

	// Pre-compute total size points for proportional splitting
	totalPoints := 0
	sizePointsMap := make([]int, len(intents))
	for i, ei := range intents {
		sp := map[string]int{"S": 1, "M": 3, "L": 5, "XL": 8}[ei.Size]
		if sp == 0 {
			sp = 3
		}
		sizePointsMap[i] = sp
		totalPoints += sp
	}
	if totalPoints == 0 {
		totalPoints = 1
	}

	for i, ei := range intents {
		sizePoints := sizePointsMap[i]
		share := float64(sizePoints) / float64(totalPoints)

		tokensIn := int64(float64(summary.TokensInput) * share)
		tokensOut := int64(float64(summary.TokensOutput) * share)
		wallClock := int64(float64(summary.DurationSecs) * share)
		prompts := int(float64(summary.PromptCount)*share + 0.5)

		// Check if Haiku wants to merge with an existing intent
		if ei.MergeWithID != "" {
			mergeOID, mergeErr := bson.ObjectIDFromHex(ei.MergeWithID)
			if mergeErr == nil {
				if mergeErr = e.intentService.Merge(ctx, mergeOID, entry.ClaudeSessionID, tokensIn, tokensOut, wallClock, prompts, summary.FilesEdited); mergeErr == nil {
					slog.Info("merged intent", "existingID", ei.MergeWithID, "sessionID", entry.ClaudeSessionID)
					continue
				}
				slog.Warn("merge failed, creating new intent", "error", mergeErr)
			}
		}

		intent := &models.Intent{
			ProjectCode:    entry.ProjectCode,
			UserID:         entry.UserID,
			UserName:       entry.UserName,
			SessionIDs:     []string{entry.ClaudeSessionID},
			Title:          ei.Title,
			Description:    ei.Description,
			Category:       ei.Category,
			TechTags:       ei.TechTags,
			UXJudgment:     ei.UXJudgment,
			Size:           ei.Size,
			SizePoints:     sizePoints,
			Status:         ei.Status,
			StatusEvidence: ei.StatusEvidence,
			FilesChanged:   summary.FilesEdited,
			PromptCount:    prompts,
			TokensInput:    tokensIn,
			TokensOutput:   tokensOut,
			WallClockSecs:  wallClock,
			CommitCount:    boolToInt(summary.HasCommits),
			BranchName:     summary.BranchName,
			PromptBatchID:  summary.PromptBatchID,
			AnalysisModel:  "claude-haiku-4-5-20251001",
			StartedAt:      entry.StartedAt,
			CompletedAt:    entry.EndedAt,
		}
		if err := e.intentService.Create(ctx, intent); err != nil {
			slog.Error("failed to store intent", "title", ei.Title, "error", err)
		} else {
			go e.pushIntentToRemote(intent)
		}
	}

	return nil
}

// ExtractFromSessionAsync runs extraction in a background goroutine.
func (e *IntentExtractor) ExtractFromSessionAsync(entry *models.ChatHistoryEntry) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := e.ExtractFromSession(ctx, entry); err != nil {
			slog.Error("async intent extraction failed", "sessionID", entry.ClaudeSessionID, "error", err)
		} else {
			slog.Info("intent extraction complete", "sessionID", entry.ClaudeSessionID)
		}
	}()
}

func (e *IntentExtractor) buildSummary(ctx context.Context, entry *models.ChatHistoryEntry) sessionSummary {
	s := sessionSummary{
		ProjectCode:  entry.ProjectCode,
		SessionID:    entry.ClaudeSessionID,
		DurationSecs: int64(entry.EndedAt.Sub(entry.StartedAt).Seconds()),
	}

	// Walk messages to extract user prompts, tool calls, file edits
	toolSet := map[string]bool{}
	fileSet := map[string]bool{}
	for _, raw := range entry.Messages {
		// Messages may be stored as BSON Binary — find the JSON start
		data := []byte(raw)
		jsonStart := -1
		for i, b := range data {
			if b == '{' {
				jsonStart = i
				break
			}
		}
		if jsonStart < 0 {
			continue
		}
		if jsonStart > 0 {
			data = data[jsonStart:]
		}

		var msg struct {
			Type    string `json:"type"`
			Message struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(data, &msg) != nil {
			continue
		}

		if msg.Type == "user" || msg.Message.Role == "user" {
			// Try to extract text content
			var textContent []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			}
			if json.Unmarshal(msg.Message.Content, &textContent) == nil {
				for _, tc := range textContent {
					if tc.Type == "text" && tc.Text != "" {
						s.UserPrompts = append(s.UserPrompts, truncate(tc.Text, 500))
						s.PromptCount++
						// Detect feedback prompt batch marker
						if s.PromptBatchID == "" {
							if idx := strings.Index(tc.Text, "<!-- prompt-batch:"); idx >= 0 {
								start := idx + len("<!-- prompt-batch:")
								if end := strings.Index(tc.Text[start:], " -->"); end >= 0 {
									s.PromptBatchID = tc.Text[start : start+end]
								}
							}
						}
					}
				}
			}
		}

		if msg.Type == "assistant" || msg.Message.Role == "assistant" {
			var blocks []struct {
				Type  string          `json:"type"`
				Name  string          `json:"name"`
				Input json.RawMessage `json:"input"`
			}
			if json.Unmarshal(msg.Message.Content, &blocks) == nil {
				for _, block := range blocks {
					if block.Type != "tool_use" {
						continue
					}
					toolSet[block.Name] = true

					var input map[string]interface{}
					json.Unmarshal(block.Input, &input)

					// Extract file paths
					if fp, ok := input["file_path"].(string); ok {
						fileSet[fp] = true
					}
					// Extract bash commands (check for git commit, branches, PRs)
					if cmd, ok := input["command"].(string); ok {
						s.BashCommands = append(s.BashCommands, truncate(cmd, 200))
						if strings.Contains(cmd, "git commit") || strings.Contains(cmd, "git push") {
							s.HasCommits = true
						}
						// Detect branch creation
						for _, prefix := range []string{"git checkout -b ", "git switch -c "} {
							if idx := strings.Index(cmd, prefix); idx >= 0 {
								branch := strings.Fields(cmd[idx+len(prefix):])[0]
								if branch != "" {
									s.BranchName = branch
								}
							}
						}
						// Detect gh pr create
						if strings.Contains(cmd, "gh pr create") {
							s.HasPR = true
						}
					}
				}
			}
		}
	}

	for t := range toolSet {
		s.ToolsUsed = append(s.ToolsUsed, t)
	}
	for f := range fileSet {
		s.FilesEdited = append(s.FilesEdited, f)
	}

	// Enrich with code delta file data
	if deltas, err := e.codeDeltaService.ListRecent(ctx, "", 100); err == nil {
		for _, d := range deltas {
			if d.SessionID == entry.ClaudeSessionID {
				for _, fc := range d.Files {
					if !fileSet[fc.Path] {
						s.FilesFromDelta = append(s.FilesFromDelta, fc.Path)
						fileSet[fc.Path] = true
					}
				}
			}
		}
	}

	// Enrich with token usage
	if e.usageService != nil {
		// Sum usage records for this session
		records, err := e.usageService.GetBySessionID(ctx, entry.ClaudeSessionID)
		if err == nil {
			for _, r := range records {
				s.TokensInput += r.InputTokens
				s.TokensOutput += r.OutputTokens
			}
		}
	}

	// Cap user prompts for the prompt
	if len(s.UserPrompts) > 20 {
		s.UserPrompts = append(s.UserPrompts[:10], s.UserPrompts[len(s.UserPrompts)-10:]...)
	}

	return s
}

func buildExtractionPrompt(s sessionSummary, recentIntents []models.Intent) string {
	// Build file extensions summary
	extCounts := map[string]int{}
	allFiles := append(s.FilesEdited, s.FilesFromDelta...)
	for _, f := range allFiles {
		ext := filepath.Ext(f)
		if ext == "" {
			ext = filepath.Base(f)
		}
		extCounts[ext]++
	}
	extSummary := ""
	for ext, count := range extCounts {
		extSummary += fmt.Sprintf("%s(%d) ", ext, count)
	}

	promptsText := ""
	for i, p := range s.UserPrompts {
		promptsText += fmt.Sprintf("%d. %s\n", i+1, p)
	}

	bashText := ""
	for _, cmd := range s.BashCommands {
		bashText += "- " + cmd + "\n"
	}
	if bashText == "" {
		bashText = "(none)\n"
	}

	// Build recent intents context for merge detection
	recentIntentsText := ""
	if len(recentIntents) > 0 {
		recentIntentsText = "\n## Recent Intents (same project, last 7 days)\nIf any of these describe the SAME work being continued in this session, include `\"mergeWithId\": \"<id>\"` instead of creating a new intent. Only merge if clearly the same task.\n\n"
		for _, ri := range recentIntents {
			recentIntentsText += fmt.Sprintf("- ID: %s | %s | %s (%d pt) | %s\n", ri.ID.Hex(), ri.Title, ri.Size, ri.SizePoints, ri.Status)
		}
	}

	return fmt.Sprintf(`Analyze this developer chat session and extract the developer's intent(s). Return JSON only — no markdown, no explanation.

## Session Data
- Duration: %d seconds (%d user prompts)
- Files touched: %d (extensions: %s)
- Tools used: %s
- Git commits detected: %v
- Tokens consumed: %d input, %d output

## User Prompts (chronological):
%s
## Shell Commands:
%s
## File Paths Edited:
%s

## Instructions

Extract one or more developer intents from this session. For each intent, provide:

{
  "title": "short imperative title (e.g. 'Add pagination to users endpoint')",
  "description": "one-sentence summary of what was accomplished or attempted",
  "category": "one of: UI | API | infra | data | test | docs | bugfix | refactor",
  "techTags": ["language/framework tags, e.g. 'react', 'go', 'mongodb'"],
  "uxJudgment": "low | medium | high — how much visual/UX taste was required (low = pure logic, high = pixel-level UI work)",
  "size": "S | M | L | XL",
  "status": "delivered | partial | abandoned | deferred",
  "statusEvidence": "brief reason for the status assignment"
}

Size calibration:
- S (1 pt): Single-file change, config tweak, copy edit, simple bugfix
- M (3 pts): 2-5 files across one layer, moderate feature addition
- L (5 pts): Crosses multiple layers (frontend + backend), new API endpoint with UI, schema migration
- XL (8 pts): Major new feature, architectural change, new subsystem

Status rules:
- delivered: git commit detected, or clear completion signals in prompts
- partial: code written but session ended without commit or explicit "done"
- abandoned: session ends mid-error, "never mind", or topic switches completely
- deferred: explicit "I'll come back to this" or similar

If the session contains multiple distinct tasks, return an array. For a single task, return a single-element array.
If merging with an existing intent, include "mergeWithId" in the object and you can omit other fields.
Return ONLY the JSON array, no other text.
%s`,
		s.DurationSecs, s.PromptCount,
		len(allFiles), extSummary,
		strings.Join(s.ToolsUsed, ", "),
		s.HasCommits,
		s.TokensInput, s.TokensOutput,
		promptsText,
		bashText,
		strings.Join(allFiles, "\n"),
		recentIntentsText,
	)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
