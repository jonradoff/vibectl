package services

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/jonradoff/vibectl/internal/models"
)

// ChatSessionService manages persisted chat session state for resume across restarts.
type ChatSessionService struct {
	collection *mongo.Collection
}

// NewChatSessionService creates a new service backed by the chat_sessions collection.
func NewChatSessionService(db *mongo.Database) *ChatSessionService {
	return &ChatSessionService{
		collection: db.Collection("chat_sessions"),
	}
}

// EnsureIndexes creates indexes on projectId (unique) and status.
func (s *ChatSessionService) EnsureIndexes(ctx context.Context) error {
	_, err := s.collection.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{
			Keys:    bson.D{{Key: "projectId", Value: 1}},
			Options: options.Index().SetUnique(true),
		},
		{Keys: bson.D{{Key: "status", Value: 1}}},
	})
	return err
}

// Upsert creates or updates the persisted chat session for a project.
func (s *ChatSessionService) Upsert(ctx context.Context, projectID, claudeSessionID, localPath string, messages []json.RawMessage) error {
	filter := bson.D{{Key: "projectId", Value: projectID}}
	update := bson.D{{Key: "$set", Value: bson.D{
		{Key: "projectId", Value: projectID},
		{Key: "claudeSessionId", Value: claudeSessionID},
		{Key: "localPath", Value: localPath},
		{Key: "messages", Value: messages},
		{Key: "status", Value: "active"},
		{Key: "updatedAt", Value: time.Now().UTC()},
	}}}
	opts := options.UpdateOne().SetUpsert(true)
	_, err := s.collection.UpdateOne(ctx, filter, update, opts)
	if err != nil {
		return fmt.Errorf("upsert chat session: %w", err)
	}
	return nil
}

// MarkResumable sets a session's status to "resumable" so it can be picked up after restart.
func (s *ChatSessionService) MarkResumable(ctx context.Context, projectID string) error {
	filter := bson.D{{Key: "projectId", Value: projectID}}
	update := bson.D{{Key: "$set", Value: bson.D{
		{Key: "status", Value: "resumable"},
		{Key: "updatedAt", Value: time.Now().UTC()},
	}}}
	_, err := s.collection.UpdateOne(ctx, filter, update)
	return err
}

// MarkDead sets a session's status to "dead" so it will not be resumed.
func (s *ChatSessionService) MarkDead(ctx context.Context, projectID string) error {
	filter := bson.D{{Key: "projectId", Value: projectID}}
	update := bson.D{{Key: "$set", Value: bson.D{
		{Key: "status", Value: "dead"},
		{Key: "updatedAt", Value: time.Now().UTC()},
	}}}
	_, err := s.collection.UpdateOne(ctx, filter, update)
	return err
}

// GetResumable returns the resumable session for a project, or nil if none exists.
func (s *ChatSessionService) GetResumable(ctx context.Context, projectID string) (*models.ChatSessionState, error) {
	filter := bson.D{
		{Key: "projectId", Value: projectID},
		{Key: "status", Value: "resumable"},
	}
	var state models.ChatSessionState
	err := s.collection.FindOne(ctx, filter).Decode(&state)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, fmt.Errorf("find resumable chat session: %w", err)
	}
	return &state, nil
}

// CleanupStale marks sessions older than maxAge as dead to prevent indefinite accumulation.
func (s *ChatSessionService) CleanupStale(ctx context.Context, maxAge time.Duration) (int64, error) {
	cutoff := time.Now().UTC().Add(-maxAge)
	filter := bson.D{
		{Key: "status", Value: "resumable"},
		{Key: "updatedAt", Value: bson.D{{Key: "$lt", Value: cutoff}}},
	}
	update := bson.D{{Key: "$set", Value: bson.D{
		{Key: "status", Value: "dead"},
		{Key: "updatedAt", Value: time.Now().UTC()},
	}}}
	result, err := s.collection.UpdateMany(ctx, filter, update)
	if err != nil {
		return 0, fmt.Errorf("cleanup stale chat sessions: %w", err)
	}
	return result.ModifiedCount, nil
}
