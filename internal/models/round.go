package models

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// RoundAction records what the user did for a single project during a round.
type RoundAction struct {
	ProjectCode string `json:"projectCode" bson:"projectCode"`
	Action      string `json:"action" bson:"action"` // prompt, note, snooze, skip, feedback
}

// RoundSummary is an audit record of a completed project round.
type RoundSummary struct {
	ID              bson.ObjectID  `json:"id" bson:"_id,omitempty"`
	UserID          *bson.ObjectID `json:"userId,omitempty" bson:"userId,omitempty"`
	ProjectsVisited int            `json:"projectsVisited" bson:"projectsVisited"`
	ProjectsTotal   int            `json:"projectsTotal" bson:"projectsTotal"`
	Actions         []RoundAction  `json:"actions" bson:"actions"`
	StartedAt       time.Time      `json:"startedAt" bson:"startedAt"`
	CompletedAt     time.Time      `json:"completedAt" bson:"completedAt"`
}
