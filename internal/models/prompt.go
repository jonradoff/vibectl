package models

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

type Prompt struct {
	ID          bson.ObjectID  `json:"id" bson:"_id,omitempty"`
	ProjectCode string         `json:"projectCode,omitempty" bson:"projectCode,omitempty"` // empty = global prompt (all projects)
	Global      bool           `json:"global" bson:"global"`                           // true = applies to all projects
	Name        string         `json:"name" bson:"name"`
	Body        string         `json:"body" bson:"body"`
	CreatedBy   *bson.ObjectID `json:"createdBy,omitempty" bson:"createdBy,omitempty"`
	CreatorName string         `json:"creatorName,omitempty" bson:"creatorName,omitempty"`
	Shared      bool           `json:"shared" bson:"shared"` // true = visible to all users; false = personal (only visible to creator)
	CreatedAt   time.Time      `json:"createdAt" bson:"createdAt"`
	UpdatedAt   time.Time      `json:"updatedAt" bson:"updatedAt"`
}

type CreatePromptRequest struct {
	Name   string `json:"name"`
	Body   string `json:"body"`
	Shared bool   `json:"shared"`
}

type UpdatePromptRequest struct {
	Name   string `json:"name,omitempty"`
	Body   string `json:"body,omitempty"`
	Shared *bool  `json:"shared,omitempty"`
}
