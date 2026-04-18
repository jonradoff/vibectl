package models

import (
	"encoding/json"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// ChatSessionState persists chat session state so sessions can be resumed
// after a backend restart.
type ChatSessionState struct {
	ID              bson.ObjectID     `json:"id" bson:"_id,omitempty"`
	ProjectCode     string            `json:"projectCode" bson:"projectCode"`
	ClaudeSessionID string            `json:"claudeSessionId" bson:"claudeSessionId"`
	LocalPath       string            `json:"localPath" bson:"localPath"`
	Messages        []json.RawMessage `json:"messages" bson:"messages"`
	Status          string            `json:"status" bson:"status"` // "active", "resumable", "dead"
	UpdatedAt       time.Time         `json:"updatedAt" bson:"updatedAt"`
}
