package models

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

type IssueComment struct {
	ID        bson.ObjectID `json:"id" bson:"_id,omitempty"`
	IssueKey  string        `json:"issueKey" bson:"issueKey"`
	ProjectCode string        `json:"projectCode" bson:"projectCode"`
	Body      string        `json:"body" bson:"body"`
	Author    string        `json:"author" bson:"author"`
	CreatedAt time.Time     `json:"createdAt" bson:"createdAt"`
	UpdatedAt time.Time     `json:"updatedAt" bson:"updatedAt"`
}
