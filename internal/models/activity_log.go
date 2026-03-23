package models

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// ActivityLog represents a system activity log entry.
type ActivityLog struct {
	ID        bson.ObjectID  `json:"id" bson:"_id,omitempty"`
	ProjectID *bson.ObjectID `json:"projectId,omitempty" bson:"projectId,omitempty"` // nil for system-level events
	UserID    *bson.ObjectID `json:"userId,omitempty" bson:"userId,omitempty"`
	UserName  string         `json:"userName,omitempty" bson:"userName,omitempty"`
	Type      string         `json:"type" bson:"type"` // "backend_start", "prompt_sent", "file_edit", "settings_change", "issue_created", "issue_status", "prompt_created", "prompt_edited"
	Message   string         `json:"message" bson:"message"`
	Snippet   string         `json:"snippet,omitempty" bson:"snippet,omitempty"` // short excerpt for prompt_sent
	Metadata  bson.M         `json:"metadata,omitempty" bson:"metadata,omitempty"`
	Timestamp time.Time      `json:"timestamp" bson:"timestamp"`
}
