package models

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// ClientInstance represents a developer's local vibectl instance registered
// with a remote standalone server.  It stores metadata and per-project local
// path overrides so the remote server knows how to reference paths on that machine.
type ClientInstance struct {
	ID           bson.ObjectID      `bson:"_id,omitempty"       json:"id"`
	UserID       bson.ObjectID      `bson:"userId"              json:"userId"`
	Name         string             `bson:"name"                json:"name"`         // e.g. "Jon's MacBook"
	Description  string             `bson:"description,omitempty" json:"description,omitempty"`
	LastSeenAt   *time.Time         `bson:"lastSeenAt,omitempty" json:"lastSeenAt,omitempty"`
	ProjectPaths []ProjectPathEntry `bson:"projectPaths,omitempty" json:"projectPaths,omitempty"`
	CreatedAt    time.Time          `bson:"createdAt"           json:"createdAt"`
	UpdatedAt    time.Time          `bson:"updatedAt"           json:"updatedAt"`
}

// ProjectPathEntry maps a project to its local filesystem path on this client.
type ProjectPathEntry struct {
	ProjectID bson.ObjectID `bson:"projectId" json:"projectId"`
	LocalPath string        `bson:"localPath" json:"localPath"`
}

// CreateClientInstanceRequest is the request body for registering a new client instance.
type CreateClientInstanceRequest struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// UpdateClientInstanceRequest supports partial updates (name, description, project paths).
type UpdateClientInstanceRequest struct {
	Name         string             `json:"name,omitempty"`
	Description  string             `json:"description,omitempty"`
	ProjectPaths []ProjectPathEntry `json:"projectPaths,omitempty"`
}
