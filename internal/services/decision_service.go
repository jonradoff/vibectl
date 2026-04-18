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

type DecisionService struct {
	collection *mongo.Collection
}

func NewDecisionService(db *mongo.Database) *DecisionService {
	return &DecisionService{
		collection: db.Collection("decisions"),
	}
}

func (s *DecisionService) EnsureIndexes(ctx context.Context) error {
	_, err := s.collection.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys: bson.D{{Key: "projectCode", Value: 1}, {Key: "timestamp", Value: -1}},
	})
	return err
}

// Record logs a new decision for a project.
func (s *DecisionService) Record(ctx context.Context, projectCode string, action, summary, issueKey string) error {
	d := models.Decision{
		ProjectCode: projectCode,
		Timestamp:   time.Now().UTC(),
		Action:      action,
		Summary:     summary,
		IssueKey:    issueKey,
	}
	_, err := s.collection.InsertOne(ctx, d)
	if err != nil {
		return fmt.Errorf("insert decision: %w", err)
	}
	return nil
}

// ListRecent returns the last N decisions for a project, newest first.
func (s *DecisionService) ListRecent(ctx context.Context, projectCode string, limit int) ([]models.Decision, error) {
	if limit <= 0 {
		limit = 20
	}

	filter := bson.D{{Key: "projectCode", Value: projectCode}}
	opts := options.Find().SetSort(bson.D{{Key: "timestamp", Value: -1}}).SetLimit(int64(limit))

	cursor, err := s.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, fmt.Errorf("find decisions: %w", err)
	}
	defer cursor.Close(ctx)

	var results []models.Decision
	if err := cursor.All(ctx, &results); err != nil {
		return nil, fmt.Errorf("decode decisions: %w", err)
	}
	if results == nil {
		results = []models.Decision{}
	}
	return results, nil
}
