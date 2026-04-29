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

type RoundService struct {
	collection *mongo.Collection
}

func NewRoundService(db *mongo.Database) *RoundService {
	return &RoundService{collection: db.Collection("rounds")}
}

func (s *RoundService) EnsureIndexes(ctx context.Context) error {
	_, err := s.collection.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "userId", Value: 1}, {Key: "completedAt", Value: -1}}},
	})
	return err
}

// Record persists a completed round summary.
func (s *RoundService) Record(ctx context.Context, summary *models.RoundSummary) error {
	summary.CompletedAt = time.Now().UTC()
	result, err := s.collection.InsertOne(ctx, summary)
	if err != nil {
		return fmt.Errorf("insert round: %w", err)
	}
	summary.ID = result.InsertedID.(bson.ObjectID)
	return nil
}

// ListRecent returns the most recent rounds for a user.
func (s *RoundService) ListRecent(ctx context.Context, userID *bson.ObjectID, limit int) ([]models.RoundSummary, error) {
	if limit <= 0 {
		limit = 10
	}
	filter := bson.D{}
	if userID != nil {
		filter = append(filter, bson.E{Key: "userId", Value: userID})
	}
	opts := options.Find().SetSort(bson.D{{Key: "completedAt", Value: -1}}).SetLimit(int64(limit))
	cursor, err := s.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, fmt.Errorf("list rounds: %w", err)
	}
	defer cursor.Close(ctx)
	var results []models.RoundSummary
	if err := cursor.All(ctx, &results); err != nil {
		return nil, fmt.Errorf("decode rounds: %w", err)
	}
	return results, nil
}
