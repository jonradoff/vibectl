package models

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

type SessionStatus string

const (
	SessionStatusActive    SessionStatus = "active"
	SessionStatusIdle      SessionStatus = "idle"
	SessionStatusCompleted SessionStatus = "completed"
)

type SessionLog struct {
	ID             bson.ObjectID `json:"id" bson:"_id,omitempty"`
	ProjectID      bson.ObjectID `json:"projectId" bson:"projectId"`
	StartedAt      time.Time     `json:"startedAt" bson:"startedAt"`
	EndedAt        *time.Time    `json:"endedAt,omitempty" bson:"endedAt,omitempty"`
	Summary        string        `json:"summary,omitempty" bson:"summary,omitempty"`
	IssuesWorkedOn []string      `json:"issuesWorkedOn" bson:"issuesWorkedOn"`
	Status         SessionStatus `json:"status" bson:"status"`
}

type CreateSessionRequest struct {
	// No fields needed — projectId comes from URL
}

type UpdateSessionRequest struct {
	Status         *SessionStatus `json:"status,omitempty"`
	Summary        *string        `json:"summary,omitempty"`
	IssuesWorkedOn *[]string      `json:"issuesWorkedOn,omitempty"`
}
