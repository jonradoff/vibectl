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


type ActivityLogService struct {
	collection *mongo.Collection
}

func NewActivityLogService(db *mongo.Database) *ActivityLogService {
	return &ActivityLogService{collection: db.Collection("activity_logs")}
}

func (s *ActivityLogService) EnsureIndexes(ctx context.Context) error {
	_, err := s.collection.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "timestamp", Value: -1}}},
		{Keys: bson.D{{Key: "projectCode", Value: 1}, {Key: "timestamp", Value: -1}}},
		{Keys: bson.D{{Key: "type", Value: 1}, {Key: "timestamp", Value: -1}}},
	})
	return err
}

// Log creates a new activity log entry.
func (s *ActivityLogService) Log(ctx context.Context, logType, message string, projectCode string, snippet string, metadata bson.M) error {
	return s.LogWithUser(ctx, logType, message, projectCode, nil, "", snippet, metadata)
}

// LogWithUser creates a new activity log entry with user attribution.
func (s *ActivityLogService) LogWithUser(ctx context.Context, logType, message string, projectCode string, userID *bson.ObjectID, userName string, snippet string, metadata bson.M) error {
	entry := models.ActivityLog{
		ProjectCode: projectCode,
		UserID:      userID,
		UserName:    userName,
		Type:        logType,
		Message:     message,
		Snippet:     snippet,
		Metadata:    metadata,
		Timestamp:   time.Now().UTC(),
	}
	_, err := s.collection.InsertOne(ctx, entry)
	if err != nil {
		return fmt.Errorf("insert activity log: %w", err)
	}
	return nil
}

// LogAsync logs in a goroutine so it doesn't block the caller.
func (s *ActivityLogService) LogAsync(logType, message string, projectCode string, snippet string, metadata bson.M) {
	go func() {
		s.Log(context.Background(), logType, message, projectCode, snippet, metadata)
	}()
}

// LogAsyncWithUser logs with user attribution in a goroutine.
func (s *ActivityLogService) LogAsyncWithUser(logType, message string, projectCode string, userID *bson.ObjectID, userName string, snippet string, metadata bson.M) {
	go func() {
		s.LogWithUser(context.Background(), logType, message, projectCode, userID, userName, snippet, metadata)
	}()
}

// DailyActivityCounts returns activity counts per day for the last `days` days,
// oldest first. Zero-fills days with no activity.
func (s *ActivityLogService) DailyActivityCounts(ctx context.Context, projectCode string, days int) ([]int, error) {
	since := time.Now().UTC().AddDate(0, 0, -days)
	pipeline := bson.A{
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "projectCode", Value: projectCode},
			{Key: "timestamp", Value: bson.D{{Key: "$gte", Value: since}}},
		}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: bson.D{{Key: "$dateToString", Value: bson.D{
				{Key: "format", Value: "%Y-%m-%d"},
				{Key: "date", Value: "$timestamp"},
			}}}},
			{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
		}}},
	}

	cursor, err := s.collection.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, fmt.Errorf("aggregate activity counts: %w", err)
	}
	defer cursor.Close(ctx)

	type dayCount struct {
		ID    string `bson:"_id"`
		Count int    `bson:"count"`
	}
	countMap := map[string]int{}
	for cursor.Next(ctx) {
		var dc dayCount
		if err := cursor.Decode(&dc); err == nil {
			countMap[dc.ID] = dc.Count
		}
	}

	result := make([]int, days)
	now := time.Now().UTC()
	for i := 0; i < days; i++ {
		dayStr := now.AddDate(0, 0, -(days-1-i)).Format("2006-01-02")
		result[i] = countMap[dayStr]
	}
	return result, nil
}

// DeployCountSince returns the number of deploy-type activity log entries
// for a project in the last `days` days.
func (s *ActivityLogService) DeployCountSince(ctx context.Context, projectCode string, days int) (int, error) {
	since := time.Now().UTC().AddDate(0, 0, -days)
	filter := bson.D{
		{Key: "projectCode", Value: projectCode},
		{Key: "timestamp", Value: bson.D{{Key: "$gte", Value: since}}},
		{Key: "type", Value: bson.D{{Key: "$in", Value: bson.A{"deploy", "deploy_prod", "deploy_started", "deploy_complete", "deployment"}}}},
	}
	n, err := s.collection.CountDocuments(ctx, filter)
	return int(n), err
}

// PromptCountSince returns the number of prompt_sent activity log entries
// for a project in the last `days` days.
func (s *ActivityLogService) PromptCountSince(ctx context.Context, projectCode string, days int) (int, error) {
	since := time.Now().UTC().AddDate(0, 0, -days)
	filter := bson.D{
		{Key: "projectCode", Value: projectCode},
		{Key: "timestamp", Value: bson.D{{Key: "$gte", Value: since}}},
		{Key: "type", Value: "prompt_sent"},
	}
	n, err := s.collection.CountDocuments(ctx, filter)
	return int(n), err
}

// LastPromptAt returns the timestamp of the most recent prompt_sent entry for a project.
func (s *ActivityLogService) LastPromptAt(ctx context.Context, projectCode string) (*time.Time, error) {
	filter := bson.D{
		{Key: "projectCode", Value: projectCode},
		{Key: "type", Value: "prompt_sent"},
	}
	opts := options.FindOne().SetSort(bson.D{{Key: "timestamp", Value: -1}}).SetProjection(bson.D{{Key: "timestamp", Value: 1}})
	var entry models.ActivityLog
	err := s.collection.FindOne(ctx, filter, opts).Decode(&entry)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, err
	}
	t := entry.Timestamp
	return &t, nil
}

// LastActivityAt returns the timestamp of the most recent log entry for a project.
func (s *ActivityLogService) LastActivityAt(ctx context.Context, projectCode string) (*time.Time, error) {
	filter := bson.D{{Key: "projectCode", Value: projectCode}}
	opts := options.FindOne().SetSort(bson.D{{Key: "timestamp", Value: -1}}).SetProjection(bson.D{{Key: "timestamp", Value: 1}})
	var entry models.ActivityLog
	err := s.collection.FindOne(ctx, filter, opts).Decode(&entry)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, err
	}
	t := entry.Timestamp
	return &t, nil
}

// List returns recent activity log entries with optional filtering.
func (s *ActivityLogService) List(ctx context.Context, projectCode string, logType string, limit int, offset int) ([]models.ActivityLog, int64, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	filter := bson.D{}
	if projectCode != "" {
		filter = append(filter, bson.E{Key: "projectCode", Value: projectCode})
	}
	if logType != "" {
		filter = append(filter, bson.E{Key: "type", Value: logType})
	}

	total, err := s.collection.CountDocuments(ctx, filter)
	if err != nil {
		return nil, 0, fmt.Errorf("count activity logs: %w", err)
	}

	opts := options.Find().
		SetSort(bson.D{{Key: "timestamp", Value: -1}}).
		SetLimit(int64(limit)).
		SetSkip(int64(offset))

	cursor, err := s.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, 0, fmt.Errorf("find activity logs: %w", err)
	}
	defer cursor.Close(ctx)

	var results []models.ActivityLog
	if err := cursor.All(ctx, &results); err != nil {
		return nil, 0, fmt.Errorf("decode activity logs: %w", err)
	}
	if results == nil {
		results = []models.ActivityLog{}
	}
	return results, total, nil
}
