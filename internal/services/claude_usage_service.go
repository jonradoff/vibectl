package services

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/jonradoff/vibectl/internal/models"
)

// ClaudeUsageService manages Claude Code token usage tracking.
type ClaudeUsageService struct {
	records *mongo.Collection
	configs *mongo.Collection
}

// NewClaudeUsageService creates the service backed by two MongoDB collections.
func NewClaudeUsageService(db *mongo.Database) *ClaudeUsageService {
	return &ClaudeUsageService{
		records: db.Collection("claude_usage_records"),
		configs: db.Collection("claude_usage_configs"),
	}
}

// EnsureIndexes creates indexes for efficient querying.
func (s *ClaudeUsageService) EnsureIndexes(ctx context.Context) error {
	_, err := s.records.Indexes().CreateMany(ctx, []mongo.IndexModel{
		// Query by login + time range
		{Keys: bson.D{
			{Key: "tokenHash", Value: 1},
			{Key: "recordedAt", Value: -1},
		}},
		// Query by project + time range
		{Keys: bson.D{
			{Key: "projectId", Value: 1},
			{Key: "recordedAt", Value: -1},
		}},
		// TTL: auto-delete records older than 90 days
		{
			Keys:    bson.D{{Key: "recordedAt", Value: 1}},
			Options: options.Index().SetExpireAfterSeconds(90 * 24 * 60 * 60),
		},
	})
	if err != nil {
		return fmt.Errorf("claude usage records indexes: %w", err)
	}

	// Unique config per login identity
	_, err = s.configs.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "tokenHash", Value: 1}},
		Options: options.Index().SetUnique(true),
	})
	if err != nil {
		return fmt.Errorf("claude usage configs index: %w", err)
	}

	return nil
}

// Record inserts a usage record.
func (s *ClaudeUsageService) Record(ctx context.Context, rec *models.ClaudeUsageRecord) error {
	rec.RecordedAt = time.Now().UTC()
	_, err := s.records.InsertOne(ctx, rec)
	if err != nil {
		return fmt.Errorf("insert claude usage record: %w", err)
	}
	return nil
}

// GetBySessionID returns all usage records for a given Claude session ID.
func (s *ClaudeUsageService) GetBySessionID(ctx context.Context, sessionID string) ([]models.ClaudeUsageRecord, error) {
	cursor, err := s.records.Find(ctx, bson.D{{Key: "sessionId", Value: sessionID}})
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	var results []models.ClaudeUsageRecord
	cursor.All(ctx, &results)
	if results == nil {
		results = []models.ClaudeUsageRecord{}
	}
	return results, nil
}

// GetConfig returns the config for a token hash, or a default if none exists.
func (s *ClaudeUsageService) GetConfig(ctx context.Context, tokenHash string) (*models.ClaudeUsageConfig, error) {
	var cfg models.ClaudeUsageConfig
	err := s.configs.FindOne(ctx, bson.D{{Key: "tokenHash", Value: tokenHash}}).Decode(&cfg)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return &models.ClaudeUsageConfig{
				TokenHash:        tokenHash,
				LoginLabel:       "",
				WeeklyTokenLimit: 0,
				AlertThreshold:   70,
			}, nil
		}
		return nil, fmt.Errorf("get claude usage config: %w", err)
	}
	return &cfg, nil
}

// UpsertConfig creates or updates config for a login identity.
func (s *ClaudeUsageService) UpsertConfig(ctx context.Context, cfg *models.ClaudeUsageConfig) error {
	cfg.UpdatedAt = time.Now().UTC()
	filter := bson.D{{Key: "tokenHash", Value: cfg.TokenHash}}
	update := bson.D{{Key: "$set", Value: cfg}}
	opts := options.UpdateOne().SetUpsert(true)
	_, err := s.configs.UpdateOne(ctx, filter, update, opts)
	if err != nil {
		return fmt.Errorf("upsert claude usage config: %w", err)
	}
	return nil
}

// weekBounds returns the start of the current ISO week (Monday 00:00 UTC) and next Monday.
func weekBounds(now time.Time) (time.Time, time.Time) {
	now = now.UTC()
	// Go's time.Weekday: Sunday=0, Monday=1, ...
	wd := now.Weekday()
	daysSinceMonday := int(wd+6) % 7
	start := time.Date(now.Year(), now.Month(), now.Day()-daysSinceMonday, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(0, 0, 7)
	return start, end
}

// GetSummary computes current-week usage summary for a given login identity.
func (s *ClaudeUsageService) GetSummary(ctx context.Context, tokenHash string) (*models.ClaudeUsageSummary, error) {
	cfg, err := s.GetConfig(ctx, tokenHash)
	if err != nil {
		return nil, err
	}

	weekStart, weekEnd := weekBounds(time.Now())

	filter := bson.D{
		{Key: "tokenHash", Value: tokenHash},
		{Key: "recordedAt", Value: bson.D{
			{Key: "$gte", Value: weekStart},
			{Key: "$lt", Value: weekEnd},
		}},
	}

	cursor, err := s.records.Find(ctx, filter)
	if err != nil {
		return nil, fmt.Errorf("find usage records: %w", err)
	}
	defer cursor.Close(ctx)

	var (
		totalInput, totalOutput, totalCacheRead, totalCacheCreation int64
		byProject = map[string]*models.ProjectUsage{}
		byModel   = map[string]*models.ModelUsage{}
		byDay     = map[string]*models.DailyUsage{}
	)

	for cursor.Next(ctx) {
		var rec models.ClaudeUsageRecord
		if err := cursor.Decode(&rec); err != nil {
			continue
		}

		totalInput += rec.InputTokens
		totalOutput += rec.OutputTokens
		totalCacheRead += rec.CacheReadTokens
		totalCacheCreation += rec.CacheCreationTokens

		// By project
		pu, ok := byProject[rec.ProjectID]
		if !ok {
			pu = &models.ProjectUsage{ProjectID: rec.ProjectID}
			byProject[rec.ProjectID] = pu
		}
		pu.InputTokens += rec.InputTokens
		pu.OutputTokens += rec.OutputTokens
		pu.TotalTokens += rec.InputTokens + rec.OutputTokens

		// By model
		mu, ok := byModel[rec.Model]
		if !ok {
			mu = &models.ModelUsage{Model: rec.Model}
			byModel[rec.Model] = mu
		}
		mu.InputTokens += rec.InputTokens
		mu.OutputTokens += rec.OutputTokens
		mu.TotalTokens += rec.InputTokens + rec.OutputTokens

		// By day
		dayStr := rec.RecordedAt.UTC().Format("2006-01-02")
		du, ok := byDay[dayStr]
		if !ok {
			du = &models.DailyUsage{Date: dayStr}
			byDay[dayStr] = du
		}
		du.InputTokens += rec.InputTokens
		du.OutputTokens += rec.OutputTokens
		du.TotalTokens += rec.InputTokens + rec.OutputTokens
	}

	totalTokens := totalInput + totalOutput

	var usagePercent float64
	if cfg.WeeklyTokenLimit > 0 {
		usagePercent = float64(totalTokens) / float64(cfg.WeeklyTokenLimit) * 100
		if usagePercent > 100 {
			usagePercent = 100
		}
	}

	// Convert maps to slices
	projectSlice := make([]models.ProjectUsage, 0, len(byProject))
	for _, pu := range byProject {
		projectSlice = append(projectSlice, *pu)
	}
	modelSlice := make([]models.ModelUsage, 0, len(byModel))
	for _, mu := range byModel {
		modelSlice = append(modelSlice, *mu)
	}

	// Build 7-day daily array
	dailySlice := make([]models.DailyUsage, 7)
	for i := 0; i < 7; i++ {
		dayStr := weekStart.AddDate(0, 0, i).Format("2006-01-02")
		if du, ok := byDay[dayStr]; ok {
			dailySlice[i] = *du
		} else {
			dailySlice[i] = models.DailyUsage{Date: dayStr}
		}
	}

	return &models.ClaudeUsageSummary{
		TokenHash:          tokenHash,
		LoginLabel:         cfg.LoginLabel,
		WeeklyTokenLimit:   cfg.WeeklyTokenLimit,
		AlertThreshold:     cfg.AlertThreshold,
		TotalInputTokens:   totalInput,
		TotalOutputTokens:  totalOutput,
		TotalCacheRead:     totalCacheRead,
		TotalCacheCreation: totalCacheCreation,
		TotalTokens:        totalTokens,
		UsagePercent:       usagePercent,
		WeekStartedAt:      weekStart,
		WeekResetsAt:       weekEnd,
		ByProject:          projectSlice,
		ByModel:            modelSlice,
		DailyUsage:         dailySlice,
	}, nil
}

// ListTokenHashes returns all distinct token hashes that have records.
func (s *ClaudeUsageService) ListTokenHashes(ctx context.Context) ([]string, error) {
	var results []string
	err := s.records.Distinct(ctx, "tokenHash", bson.D{}).Decode(&results)
	if err != nil {
		return nil, fmt.Errorf("distinct token hashes: %w", err)
	}
	// Filter out empty strings
	hashes := make([]string, 0, len(results))
	for _, h := range results {
		if h != "" {
			hashes = append(hashes, h)
		}
	}
	return hashes, nil
}

// GetAllSummaries returns usage summaries for all known login identities.
func (s *ClaudeUsageService) GetAllSummaries(ctx context.Context) ([]models.ClaudeUsageSummary, error) {
	hashes, err := s.ListTokenHashes(ctx)
	if err != nil {
		return nil, err
	}

	summaries := make([]models.ClaudeUsageSummary, 0, len(hashes))
	for _, h := range hashes {
		summary, err := s.GetSummary(ctx, h)
		if err != nil {
			continue
		}
		summaries = append(summaries, *summary)
	}
	return summaries, nil
}
