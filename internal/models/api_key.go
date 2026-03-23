package models

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// APIKey represents a named, long-lived token for programmatic access.
// The raw token is shown once on creation and never stored; only the SHA-256 hash is persisted.
// Tokens are prefixed with "vk_" so the middleware can distinguish them from session tokens.
type APIKey struct {
	ID         bson.ObjectID `json:"id" bson:"_id,omitempty"`
	UserID     bson.ObjectID `json:"userId" bson:"userId"`
	Name       string        `json:"name" bson:"name"`
	TokenHash  string        `json:"-" bson:"tokenHash"`
	LastUsedAt *time.Time    `json:"lastUsedAt,omitempty" bson:"lastUsedAt,omitempty"`
	CreatedAt  time.Time     `json:"createdAt" bson:"createdAt"`
}

// APIKeyView is the API response — never includes the hash.
type APIKeyView struct {
	ID         bson.ObjectID `json:"id"`
	Name       string        `json:"name"`
	LastUsedAt *time.Time    `json:"lastUsedAt,omitempty"`
	CreatedAt  time.Time     `json:"createdAt"`
}
