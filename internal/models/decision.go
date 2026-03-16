package models

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

type Decision struct {
	ID        bson.ObjectID `json:"id" bson:"_id,omitempty"`
	ProjectID bson.ObjectID `json:"projectId" bson:"projectId"`
	Timestamp time.Time     `json:"timestamp" bson:"timestamp"`
	Action    string        `json:"action" bson:"action"`                             // "issue_created", "status_change", "feedback_accepted", etc.
	Summary   string        `json:"summary" bson:"summary"`                           // human-readable one-liner
	IssueKey  string        `json:"issueKey,omitempty" bson:"issueKey,omitempty"`
	Metadata  bson.M        `json:"metadata,omitempty" bson:"metadata,omitempty"`
}
