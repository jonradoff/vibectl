package models

import (
	"encoding/json"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// ChatHistoryEntry is an archived chat session preserved for viewing past interactions.
type ChatHistoryEntry struct {
	ID              bson.ObjectID     `json:"id" bson:"_id,omitempty"`
	ProjectCode     string            `json:"projectCode" bson:"projectCode"`
	ClaudeSessionID string            `json:"claudeSessionId" bson:"claudeSessionId"`
	Messages        []json.RawMessage `json:"messages" bson:"messages"`
	MessageCount    int               `json:"messageCount" bson:"messageCount"`
	StartedAt       time.Time         `json:"startedAt" bson:"startedAt"`
	EndedAt         time.Time         `json:"endedAt" bson:"endedAt"`
}

// ChatHistorySummary is the list view (without full messages).
type ChatHistorySummary struct {
	ID              bson.ObjectID `json:"id" bson:"_id,omitempty"`
	ProjectCode     string        `json:"projectCode" bson:"projectCode"`
	ClaudeSessionID string        `json:"claudeSessionId" bson:"claudeSessionId"`
	MessageCount    int           `json:"messageCount" bson:"messageCount"`
	StartedAt       time.Time     `json:"startedAt" bson:"startedAt"`
	EndedAt         time.Time     `json:"endedAt" bson:"endedAt"`
}
