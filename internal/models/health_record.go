package models

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// HealthRecord stores a periodic health check snapshot for uptime tracking.
type HealthRecord struct {
	ID        bson.ObjectID       `json:"id" bson:"_id,omitempty"`
	ProjectID bson.ObjectID       `json:"projectId" bson:"projectId"`
	Results   []HealthCheckResult `json:"results" bson:"results"`
	CheckedAt time.Time           `json:"checkedAt" bson:"checkedAt"`
}
