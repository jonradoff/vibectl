package models

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

type Prompt struct {
	ID        bson.ObjectID  `json:"id" bson:"_id,omitempty"`
	ProjectID *bson.ObjectID `json:"projectId,omitempty" bson:"projectId,omitempty"` // nil = global prompt (all projects)
	Global    bool           `json:"global" bson:"global"`                           // true = applies to all projects
	Name      string         `json:"name" bson:"name"`
	Body      string         `json:"body" bson:"body"`
	CreatedAt time.Time      `json:"createdAt" bson:"createdAt"`
	UpdatedAt time.Time      `json:"updatedAt" bson:"updatedAt"`
}

type CreatePromptRequest struct {
	Name string `json:"name"`
	Body string `json:"body"`
}

type UpdatePromptRequest struct {
	Name string `json:"name,omitempty"`
	Body string `json:"body,omitempty"`
}
