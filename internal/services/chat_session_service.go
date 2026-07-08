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

// EnsureIndexes creates indexes on projectCode (unique) and status.
func (s *ChatSessionService) EnsureIndexes(ctx context.Context) error {
	_, err := s.collection.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{
			Keys:    bson.D{{Key: "projectCode", Value: 1}},
			Options: options.Index().SetUnique(true),
		},
		{Keys: bson.D{{Key: "status", Value: 1}}},
	})
	return err
}

// Upsert creates or updates the persisted chat session for a project.
func (s *ChatSessionService) Upsert(ctx context.Context, projectCode, claudeSessionID, localPath string, messages []json.RawMessage) error {
	filter := bson.D{{Key: "projectCode", Value: projectCode}}
	update := bson.D{
		{Key: "$set", Value: bson.D{
			{Key: "projectCode", Value: projectCode},
			{Key: "claudeSessionId", Value: claudeSessionID},
			{Key: "localPath", Value: localPath},
			{Key: "messages", Value: messages},
			{Key: "status", Value: "active"},
			{Key: "updatedAt", Value: time.Now().UTC()},
		}},
		// A live session was born — clear the user-reset noResume gate so
		// future resumable/reap flows can restore it normally.
		{Key: "$unset", Value: bson.D{{Key: "noResume", Value: ""}}},
	}
	opts := options.UpdateOne().SetUpsert(true)
	_, err := s.collection.UpdateOne(ctx, filter, update, opts)
	if err != nil {
		return fmt.Errorf("upsert chat session: %w", err)
	}
	return nil
}

// MarkResumable sets a session's status to "resumable" so it can be picked up after restart.
func (s *ChatSessionService) MarkResumable(ctx context.Context, projectCode string) error {
	filter := bson.D{{Key: "projectCode", Value: projectCode}}
	update := bson.D{{Key: "$set", Value: bson.D{
		{Key: "status", Value: "resumable"},
		{Key: "updatedAt", Value: time.Now().UTC()},
	}}}
	_, err := s.collection.UpdateOne(ctx, filter, update)
	return err
}

// MarkDead sets a session's status to "dead" so it will not be resumed.
func (s *ChatSessionService) MarkDead(ctx context.Context, projectCode string) error {
	filter := bson.D{{Key: "projectCode", Value: projectCode}}
	update := bson.D{{Key: "$set", Value: bson.D{
		{Key: "status", Value: "dead"},
		{Key: "updatedAt", Value: time.Now().UTC()},
	}}}
	_, err := s.collection.UpdateOne(ctx, filter, update)
	return err
}

// SessionRow is a tiny projection used by the on-disk consistency check.
type SessionRow struct {
	ProjectCode     string `bson:"projectCode"`
	ClaudeSessionID string `bson:"claudeSessionId"`
	LocalPath       string `bson:"localPath"`
}

// ListAllSessionRows returns every chat_sessions doc's (projectCode,
// claudeSessionId, localPath) tuple regardless of status. Used at startup
// to verify each session's on-disk log is where we expect it.
func (s *ChatSessionService) ListAllSessionRows(ctx context.Context) ([]SessionRow, error) {
	opts := options.Find().SetProjection(bson.D{
		{Key: "projectCode", Value: 1},
		{Key: "claudeSessionId", Value: 1},
		{Key: "localPath", Value: 1},
	})
	cursor, err := s.collection.Find(ctx, bson.D{}, opts)
	if err != nil {
		return nil, fmt.Errorf("list all session rows: %w", err)
	}
	defer cursor.Close(ctx)
	var out []SessionRow
	if err := cursor.All(ctx, &out); err != nil {
		return nil, fmt.Errorf("decode session rows: %w", err)
	}
	return out, nil
}

// GetLastSessionID returns whatever claudeSessionId is on the chat_sessions
// doc for this project regardless of status. Callers use this to attempt an
// on-disk fallback recovery even from a session that's been marked dead —
// the JSONL may still exist under an old/moved directory encoding.
func (s *ChatSessionService) GetLastSessionID(ctx context.Context, projectCode string) (string, error) {
	filter := bson.D{{Key: "projectCode", Value: projectCode}}
	opts := options.FindOne().SetProjection(bson.D{{Key: "claudeSessionId", Value: 1}})
	var row struct {
		ClaudeSessionID string `bson:"claudeSessionId"`
	}
	if err := s.collection.FindOne(ctx, filter, opts).Decode(&row); err != nil {
		if err == mongo.ErrNoDocuments {
			return "", nil
		}
		return "", err
	}
	return row.ClaudeSessionID, nil
}

// ClearSession marks dead AND removes claudeSessionId. Use when the persisted
// session ID is known to be orphaned (e.g. Claude Code reports "no conversation
// found with session ID"), so the next launch starts fresh instead of trying
// to resume the dead ID again.
//
// Also sets noResume: true so the resilience fallbacks in chat_handler
// (cross-dir session lookup, chat_history archive scan, latest-on-disk) skip
// this project until the next successful fresh spawn (Upsert clears the flag).
// Without this, a user-initiated Reset would immediately be undone by the
// fallbacks finding the just-abandoned session on disk and resuming it.
func (s *ChatSessionService) ClearSession(ctx context.Context, projectCode string) error {
	filter := bson.D{{Key: "projectCode", Value: projectCode}}
	update := bson.D{
		{Key: "$set", Value: bson.D{
			{Key: "status", Value: "dead"},
			{Key: "noResume", Value: true},
			{Key: "updatedAt", Value: time.Now().UTC()},
		}},
		{Key: "$unset", Value: bson.D{{Key: "claudeSessionId", Value: ""}}},
	}
	_, err := s.collection.UpdateOne(ctx, filter, update)
	return err
}

// IsResetFlagged reports whether ClearSession was called for this project
// and no fresh session has been born since (Upsert clears the flag). When
// true, the chat_handler skips all on-disk fallbacks and goes straight to
// a fresh spawn — the point of a user-initiated Reset is a clean slate.
func (s *ChatSessionService) IsResetFlagged(ctx context.Context, projectCode string) (bool, error) {
	filter := bson.D{{Key: "projectCode", Value: projectCode}}
	opts := options.FindOne().SetProjection(bson.D{{Key: "noResume", Value: 1}})
	var row struct {
		NoResume bool `bson:"noResume"`
	}
	if err := s.collection.FindOne(ctx, filter, opts).Decode(&row); err != nil {
		if err == mongo.ErrNoDocuments {
			return false, nil
		}
		return false, err
	}
	return row.NoResume, nil
}

// GetResumable returns the resumable session for a project, or nil if none exists.
// Matches both "resumable" (graceful shutdown) and "active" (server killed ungracefully).
func (s *ChatSessionService) GetResumable(ctx context.Context, projectCode string) (*models.ChatSessionState, error) {
	filter := bson.D{
		{Key: "projectCode", Value: projectCode},
		{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"resumable", "active"}}}},
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

// CleanupStale marks ACTIVE sessions older than maxAge as dead.
// Resumable sessions are preserved — they represent saved context the user may want to resume.
func (s *ChatSessionService) CleanupStale(ctx context.Context, maxAge time.Duration) (int64, error) {
	cutoff := time.Now().UTC().Add(-maxAge)
	filter := bson.D{
		{Key: "status", Value: "active"}, // only kill active sessions, not resumable
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
