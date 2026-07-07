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

// ChatHistoryService manages archived chat sessions for historical viewing.
type ChatHistoryService struct {
	collection *mongo.Collection
}

// NewChatHistoryService creates a new service backed by the chat_history collection.
func NewChatHistoryService(db *mongo.Database) *ChatHistoryService {
	return &ChatHistoryService{
		collection: db.Collection("chat_history"),
	}
}

// EnsureIndexes creates indexes for efficient querying.
func (s *ChatHistoryService) EnsureIndexes(ctx context.Context) error {
	_, err := s.collection.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "projectCode", Value: 1}, {Key: "endedAt", Value: -1}}},
	})
	return err
}

// Archive stores a completed chat session in history.
func (s *ChatHistoryService) Archive(ctx context.Context, projectCode, claudeSessionID string, messages []json.RawMessage, startedAt time.Time, userID *bson.ObjectID, userName string) error {
	if len(messages) == 0 {
		return nil // nothing to archive
	}

	entry := models.ChatHistoryEntry{
		ProjectCode:     projectCode,
		ClaudeSessionID: claudeSessionID,
		UserID:          userID,
		UserName:        userName,
		Messages:        messages,
		MessageCount:    len(messages),
		StartedAt:       startedAt,
		EndedAt:         time.Now().UTC(),
	}

	_, err := s.collection.InsertOne(ctx, entry)
	if err != nil {
		return fmt.Errorf("insert chat history: %w", err)
	}
	return nil
}

// ListByProject returns history summaries for a project, newest first (without messages).
func (s *ChatHistoryService) ListByProject(ctx context.Context, projectCode string) ([]models.ChatHistorySummary, error) {
	filter := bson.D{{Key: "projectCode", Value: projectCode}}
	opts := options.Find().SetSort(bson.D{{Key: "endedAt", Value: -1}}).
		SetProjection(bson.D{
			{Key: "projectCode", Value: 1},
			{Key: "claudeSessionId", Value: 1},
			{Key: "messageCount", Value: 1},
			{Key: "startedAt", Value: 1},
			{Key: "endedAt", Value: 1},
		})

	cursor, err := s.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, fmt.Errorf("find chat history: %w", err)
	}
	defer cursor.Close(ctx)

	var results []models.ChatHistorySummary
	if err := cursor.All(ctx, &results); err != nil {
		return nil, fmt.Errorf("decode chat history: %w", err)
	}
	return results, nil
}

// RecentSessionIDs returns the last `limit` archived Claude session IDs for
// this project (newest first). Used as a fallback path when the DB has no
// active/resumable record but the user *has* worked on this project before —
// the caller can try each ID against the on-disk JSONLs and resume the
// newest one that still exists on disk.
func (s *ChatHistoryService) RecentSessionIDs(ctx context.Context, projectCode string, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 10
	}
	filter := bson.D{
		{Key: "projectCode", Value: projectCode},
		{Key: "claudeSessionId", Value: bson.D{{Key: "$ne", Value: ""}}},
	}
	opts := options.Find().
		SetSort(bson.D{{Key: "endedAt", Value: -1}}).
		SetLimit(int64(limit)).
		SetProjection(bson.D{{Key: "claudeSessionId", Value: 1}})
	cursor, err := s.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, fmt.Errorf("find recent session ids: %w", err)
	}
	defer cursor.Close(ctx)
	var rows []struct {
		ClaudeSessionID string `bson:"claudeSessionId"`
	}
	if err := cursor.All(ctx, &rows); err != nil {
		return nil, fmt.Errorf("decode recent session ids: %w", err)
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		if r.ClaudeSessionID == "" || seen[r.ClaudeSessionID] {
			continue
		}
		seen[r.ClaudeSessionID] = true
		out = append(out, r.ClaudeSessionID)
	}
	return out, nil
}

// GetByID returns a full history entry with messages.
func (s *ChatHistoryService) GetByID(ctx context.Context, id string) (*models.ChatHistoryEntry, error) {
	objID, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return nil, fmt.Errorf("invalid history id: %w", err)
	}

	var entry models.ChatHistoryEntry
	err = s.collection.FindOne(ctx, bson.D{{Key: "_id", Value: objID}}).Decode(&entry)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, fmt.Errorf("find chat history entry: %w", err)
	}
	return &entry, nil
}
