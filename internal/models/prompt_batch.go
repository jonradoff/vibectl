package models

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// PromptBatch tracks a set of accepted feedback items compiled into a prompt and dispatched to Claude Code.
type PromptBatch struct {
	ID          bson.ObjectID `json:"id" bson:"_id,omitempty"`
	ProjectCode string        `json:"projectCode" bson:"projectCode"`
	FeedbackIDs []string      `json:"feedbackIds" bson:"feedbackIds"`
	PromptText  string        `json:"promptText" bson:"promptText"`
	Status      string        `json:"status" bson:"status"` // dispatched | completed
	CreatedBy   string        `json:"createdBy,omitempty" bson:"createdBy,omitempty"`
	CreatedAt   time.Time     `json:"createdAt" bson:"createdAt"`
}
