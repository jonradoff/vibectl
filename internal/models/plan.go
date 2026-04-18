package models

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// Plan represents a Claude Code plan captured from a chat session.
type Plan struct {
	ID              bson.ObjectID  `json:"id" bson:"_id,omitempty"`
	ProjectCode     string         `json:"projectCode,omitempty" bson:"projectCode,omitempty"`
	ClaudeSessionID string         `json:"claudeSessionId,omitempty" bson:"claudeSessionId,omitempty"`
	RequestID       string         `json:"requestId" bson:"requestId"`                                 // control_request ID from Claude Code
	PlanText        string         `json:"planText" bson:"planText"`                                   // the markdown plan content
	Status          string         `json:"status" bson:"status"`                                       // "pending", "accepted", "rejected", "completed", "abandoned"
	Feedback        string         `json:"feedback,omitempty" bson:"feedback,omitempty"`                // user feedback when rejecting/iterating
	CompletedAt     *time.Time     `json:"completedAt,omitempty" bson:"completedAt,omitempty"`          // when the plan was marked completed
	CreatedAt       time.Time      `json:"createdAt" bson:"createdAt"`
	UpdatedAt       time.Time      `json:"updatedAt" bson:"updatedAt"`
}
