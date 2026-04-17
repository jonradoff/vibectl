package services

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/jonradoff/vibectl/internal/models"
)

type GitBaselineService struct {
	collection *mongo.Collection
}

func NewGitBaselineService(db *mongo.Database) *GitBaselineService {
	return &GitBaselineService{collection: db.Collection("git_baselines")}
}

func (s *GitBaselineService) EnsureIndexes(ctx context.Context) error {
	_, err := s.collection.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "projectId", Value: 1}},
		Options: options.Index().SetUnique(true),
	})
	return err
}

// Upsert stores or updates the baseline for a project.
func (s *GitBaselineService) Upsert(ctx context.Context, projectID, commitSHA, numstat string) error {
	filter := bson.D{{Key: "projectId", Value: projectID}}
	update := bson.D{{Key: "$set", Value: bson.D{
		{Key: "projectId", Value: projectID},
		{Key: "commitSHA", Value: commitSHA},
		{Key: "numstat", Value: numstat},
		{Key: "createdAt", Value: time.Now().UTC()},
	}}}
	opts := options.UpdateOne().SetUpsert(true)
	_, err := s.collection.UpdateOne(ctx, filter, update, opts)
	return err
}

// Get retrieves the baseline for a project.
func (s *GitBaselineService) Get(ctx context.Context, projectID string) (*models.GitBaseline, error) {
	var bl models.GitBaseline
	err := s.collection.FindOne(ctx, bson.D{{Key: "projectId", Value: projectID}}).Decode(&bl)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, err
	}
	return &bl, nil
}

// Delete removes the baseline for a project (consumed after recording).
func (s *GitBaselineService) Delete(ctx context.Context, projectID string) error {
	_, err := s.collection.DeleteOne(ctx, bson.D{{Key: "projectId", Value: projectID}})
	return err
}

// CleanupStale removes baselines older than maxAge (orphans from crashed sessions).
func (s *GitBaselineService) CleanupStale(ctx context.Context, maxAge time.Duration) (int, error) {
	cutoff := time.Now().UTC().Add(-maxAge)
	result, err := s.collection.DeleteMany(ctx, bson.D{
		{Key: "createdAt", Value: bson.D{{Key: "$lt", Value: cutoff}}},
	})
	if err != nil {
		return 0, err
	}
	return int(result.DeletedCount), nil
}
