package models

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// GitBaseline stores the git state snapshot taken before a prompt, used to compute code deltas.
type GitBaseline struct {
	ID        bson.ObjectID `json:"id" bson:"_id,omitempty"`
	ProjectCode string      `json:"projectCode" bson:"projectCode"`
	CommitSHA string        `json:"commitSHA" bson:"commitSHA"`
	Numstat   string        `json:"numstat" bson:"numstat"`
	CreatedAt time.Time     `json:"createdAt" bson:"createdAt"`
}
