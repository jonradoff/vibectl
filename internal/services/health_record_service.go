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

// HealthRecordService manages persisted health check records for uptime history.
type HealthRecordService struct {
	collection *mongo.Collection
}

// NewHealthRecordService creates a service backed by the health_records collection.
func NewHealthRecordService(db *mongo.Database) *HealthRecordService {
	return &HealthRecordService{
		collection: db.Collection("health_records"),
	}
}

// EnsureIndexes creates indexes for efficient querying.
func (s *HealthRecordService) EnsureIndexes(ctx context.Context) error {
	_, err := s.collection.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{
			{Key: "projectId", Value: 1},
			{Key: "checkedAt", Value: -1},
		}},
		// TTL index: auto-delete records older than 7 days
		{
			Keys:    bson.D{{Key: "checkedAt", Value: 1}},
			Options: options.Index().SetExpireAfterSeconds(7 * 24 * 60 * 60),
		},
	})
	return err
}

// Insert stores a new health check record.
func (s *HealthRecordService) Insert(ctx context.Context, projectID bson.ObjectID, results []models.HealthCheckResult) error {
	record := models.HealthRecord{
		ProjectID: projectID,
		Results:   results,
		CheckedAt: time.Now().UTC(),
	}
	_, err := s.collection.InsertOne(ctx, record)
	if err != nil {
		return fmt.Errorf("insert health record: %w", err)
	}
	return nil
}

// GetLatest returns the most recent health record for a project, or nil if none exists.
func (s *HealthRecordService) GetLatest(ctx context.Context, projectID bson.ObjectID) (*models.HealthRecord, error) {
	filter := bson.D{{Key: "projectId", Value: projectID}}
	opts := options.FindOne().SetSort(bson.D{{Key: "checkedAt", Value: -1}})

	var record models.HealthRecord
	err := s.collection.FindOne(ctx, filter, opts).Decode(&record)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, fmt.Errorf("get latest health record: %w", err)
	}
	return &record, nil
}

// DailyHealthStatus returns health status per day for the last `days` days, oldest first.
// Values are "up", "down", "degraded", or "unknown". Takes the worst status seen each day.
func (s *HealthRecordService) DailyHealthStatus(ctx context.Context, projectID bson.ObjectID, days int) ([]string, error) {
	since := time.Now().UTC().AddDate(0, 0, -days)
	filter := bson.D{
		{Key: "projectId", Value: projectID},
		{Key: "checkedAt", Value: bson.D{{Key: "$gte", Value: since}}},
	}
	cursor, err := s.collection.Find(ctx, filter, options.Find().SetSort(bson.D{{Key: "checkedAt", Value: 1}}))
	if err != nil {
		return nil, fmt.Errorf("find health records: %w", err)
	}
	defer cursor.Close(ctx)

	priority := map[string]int{"up": 3, "degraded": 2, "down": 1, "unknown": 0}
	dayStatus := map[string]string{}

	for cursor.Next(ctx) {
		var rec models.HealthRecord
		if err := cursor.Decode(&rec); err != nil {
			continue
		}
		dayStr := rec.CheckedAt.UTC().Format("2006-01-02")
		// Compute overall status: best across endpoints
		overallStatus := "unknown"
		for _, res := range rec.Results {
			if priority[res.Status] > priority[overallStatus] {
				overallStatus = res.Status
			}
		}
		// Keep worst status seen on this day
		if existing, ok := dayStatus[dayStr]; !ok || priority[overallStatus] < priority[existing] {
			dayStatus[dayStr] = overallStatus
		}
	}

	result := make([]string, days)
	now := time.Now().UTC()
	for i := 0; i < days; i++ {
		dayStr := now.AddDate(0, 0, -(days-1-i)).Format("2006-01-02")
		if s, ok := dayStatus[dayStr]; ok {
			result[i] = s
		} else {
			result[i] = "unknown"
		}
	}
	return result, nil
}

// GetHistory returns health records for a project within the given duration (e.g. last 24h).
func (s *HealthRecordService) GetHistory(ctx context.Context, projectID string, since time.Duration) ([]models.HealthRecord, error) {
	oid, err := bson.ObjectIDFromHex(projectID)
	if err != nil {
		return nil, fmt.Errorf("invalid project ID: %w", err)
	}

	cutoff := time.Now().UTC().Add(-since)
	filter := bson.D{
		{Key: "projectId", Value: oid},
		{Key: "checkedAt", Value: bson.D{{Key: "$gte", Value: cutoff}}},
	}
	opts := options.Find().SetSort(bson.D{{Key: "checkedAt", Value: 1}})

	cursor, err := s.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, fmt.Errorf("find health records: %w", err)
	}
	defer cursor.Close(ctx)

	var records []models.HealthRecord
	if err := cursor.All(ctx, &records); err != nil {
		return nil, fmt.Errorf("decode health records: %w", err)
	}
	if records == nil {
		records = []models.HealthRecord{}
	}
	return records, nil
}
