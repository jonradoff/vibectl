package models

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// AuthSession is a per-user authentication session.
// The raw token is only returned to the client once; the DB stores a SHA-256 hash.
type AuthSession struct {
	ID        bson.ObjectID `json:"id" bson:"_id,omitempty"`
	UserID    bson.ObjectID `json:"userId" bson:"userId"`
	TokenHash string        `json:"-" bson:"tokenHash"`
	CreatedAt time.Time     `json:"createdAt" bson:"createdAt"`
	ExpiresAt time.Time     `json:"expiresAt" bson:"expiresAt"`
	UserAgent string        `json:"userAgent,omitempty" bson:"userAgent,omitempty"`
	IP        string        `json:"ip,omitempty" bson:"ip,omitempty"`
}
