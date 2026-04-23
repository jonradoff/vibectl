package models

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// FileChange records per-file line counts from a git diff.
type FileChange struct {
	Path         string `json:"path" bson:"path"`
	LinesAdded   int64  `json:"linesAdded" bson:"linesAdded"`
	LinesRemoved int64  `json:"linesRemoved" bson:"linesRemoved"`
}

// CodeDelta records the code change metrics between prompt completions.
type CodeDelta struct {
	ID           bson.ObjectID  `json:"id" bson:"_id,omitempty"`
	ProjectCode  string         `json:"projectCode,omitempty" bson:"projectCode,omitempty"`
	SessionID    string         `json:"sessionId,omitempty" bson:"sessionId,omitempty"`
	UserID       *bson.ObjectID `json:"userId,omitempty" bson:"userId,omitempty"`
	UserName     string         `json:"userName,omitempty" bson:"userName,omitempty"`
	LinesAdded   int64          `json:"linesAdded" bson:"linesAdded"`
	LinesRemoved int64          `json:"linesRemoved" bson:"linesRemoved"`
	BytesDelta   int64          `json:"bytesDelta" bson:"bytesDelta"`
	FilesChanged int            `json:"filesChanged" bson:"filesChanged"`
	Files        []FileChange   `json:"files,omitempty" bson:"files,omitempty"`
	RecordedAt   time.Time      `json:"recordedAt" bson:"recordedAt"`
}
