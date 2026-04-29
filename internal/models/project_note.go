package models

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// ProjectNote is a developer's scratch note attached to a project, surfaced during rounds.
// One active note per project (upsert semantics).
type ProjectNote struct {
	ID          bson.ObjectID  `json:"id" bson:"_id,omitempty"`
	ProjectCode string         `json:"projectCode" bson:"projectCode"`
	Text        string         `json:"text" bson:"text"`
	CreatedBy   *bson.ObjectID `json:"createdBy,omitempty" bson:"createdBy,omitempty"`
	CreatedAt   time.Time      `json:"createdAt" bson:"createdAt"`
	UpdatedAt   time.Time      `json:"updatedAt" bson:"updatedAt"`
}
