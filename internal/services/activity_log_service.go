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
		{Keys: bson.D{{Key: "projectId", Value: 1}, {Key: "timestamp", Value: -1}}},
		{Keys: bson.D{{Key: "type", Value: 1}, {Key: "timestamp", Value: -1}}},
	})
	return err
}

// Log creates a new activity log entry.
func (s *ActivityLogService) Log(ctx context.Context, logType, message string, projectID *bson.ObjectID, snippet string, metadata bson.M) error {
	entry := models.ActivityLog{
		ProjectID: projectID,
		Type:      logType,
		Message:   message,
		Snippet:   snippet,
		Metadata:  metadata,
		Timestamp: time.Now().UTC(),
	}
	_, err := s.collection.InsertOne(ctx, entry)
	if err != nil {
		return fmt.Errorf("insert activity log: %w", err)
	}
	return nil
}

// LogAsync logs in a goroutine so it doesn't block the caller.
func (s *ActivityLogService) LogAsync(logType, message string, projectID *bson.ObjectID, snippet string, metadata bson.M) {
	go func() {
		s.Log(context.Background(), logType, message, projectID, snippet, metadata)
	}()
}

// List returns recent activity log entries with optional filtering.
func (s *ActivityLogService) List(ctx context.Context, projectID string, logType string, limit int, offset int) ([]models.ActivityLog, int64, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	filter := bson.D{}
	if projectID != "" {
		oid, err := bson.ObjectIDFromHex(projectID)
		if err != nil {
			return nil, 0, fmt.Errorf("invalid project ID: %w", err)
		}
		filter = append(filter, bson.E{Key: "projectId", Value: oid})
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
