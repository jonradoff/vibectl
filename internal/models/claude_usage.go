package models

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// ClaudeUsageRecord captures token usage from a single Claude Code response event.
type ClaudeUsageRecord struct {
	ID                   bson.ObjectID `json:"id" bson:"_id,omitempty"`
	TokenHash            string        `json:"tokenHash" bson:"tokenHash"`                       // SHA256 of OAuth token — stable identity per login
	ProjectID            string        `json:"projectId" bson:"projectId"`                       // which project generated the usage
	SessionID            string        `json:"sessionId,omitempty" bson:"sessionId,omitempty"`    // Claude session ID
	Model                string        `json:"model,omitempty" bson:"model,omitempty"`            // e.g. "claude-opus-4-6"
	InputTokens          int64         `json:"inputTokens" bson:"inputTokens"`                   // prompt tokens
	OutputTokens         int64         `json:"outputTokens" bson:"outputTokens"`                 // completion tokens
	CacheReadTokens      int64         `json:"cacheReadTokens" bson:"cacheReadTokens"`           // cache-read tokens (billed at 10%)
	CacheCreationTokens  int64         `json:"cacheCreationTokens" bson:"cacheCreationTokens"`   // cache-creation tokens
	RecordedAt           time.Time     `json:"recordedAt" bson:"recordedAt"`
}

// ClaudeUsageConfig stores user-configured limits per login identity.
type ClaudeUsageConfig struct {
	ID               bson.ObjectID `json:"id" bson:"_id,omitempty"`
	TokenHash        string        `json:"tokenHash" bson:"tokenHash"`                           // same hash as records
	LoginLabel       string        `json:"loginLabel" bson:"loginLabel"`                         // user-friendly name ("Jon's Max")
	WeeklyTokenLimit int64         `json:"weeklyTokenLimit" bson:"weeklyTokenLimit"`             // user-configured weekly cap
	AlertThreshold   int           `json:"alertThreshold" bson:"alertThreshold"`                 // percentage (default 70)
	UpdatedAt        time.Time     `json:"updatedAt" bson:"updatedAt"`
}

// ClaudeUsageSummary is the API response for a single login's current usage.
type ClaudeUsageSummary struct {
	TokenHash           string            `json:"tokenHash"`
	LoginLabel          string            `json:"loginLabel"`
	WeeklyTokenLimit    int64             `json:"weeklyTokenLimit"`
	AlertThreshold      int               `json:"alertThreshold"`
	TotalInputTokens    int64             `json:"totalInputTokens"`
	TotalOutputTokens   int64             `json:"totalOutputTokens"`
	TotalCacheRead      int64             `json:"totalCacheRead"`
	TotalCacheCreation  int64             `json:"totalCacheCreation"`
	TotalTokens         int64             `json:"totalTokens"`          // input + output (what counts toward limit)
	UsagePercent        float64           `json:"usagePercent"`         // 0-100
	WeekStartedAt       time.Time         `json:"weekStartedAt"`
	WeekResetsAt        time.Time         `json:"weekResetsAt"`
	ByProject           []ProjectUsage    `json:"byProject"`
	ByModel             []ModelUsage      `json:"byModel"`
	DailyUsage          []DailyUsage      `json:"dailyUsage"`
}

// ProjectUsage is per-project token breakdown within a period.
type ProjectUsage struct {
	ProjectID    string `json:"projectId"`
	InputTokens  int64  `json:"inputTokens"`
	OutputTokens int64  `json:"outputTokens"`
	TotalTokens  int64  `json:"totalTokens"`
}

// ModelUsage is per-model token breakdown within a period.
type ModelUsage struct {
	Model        string `json:"model"`
	InputTokens  int64  `json:"inputTokens"`
	OutputTokens int64  `json:"outputTokens"`
	TotalTokens  int64  `json:"totalTokens"`
}

// DailyUsage is per-day token breakdown.
type DailyUsage struct {
	Date         string `json:"date"`           // "2026-04-09"
	InputTokens  int64  `json:"inputTokens"`
	OutputTokens int64  `json:"outputTokens"`
	TotalTokens  int64  `json:"totalTokens"`
}
