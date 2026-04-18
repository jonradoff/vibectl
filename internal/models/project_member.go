package models

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// ProjectMember links a user to a project with a specific role.
type ProjectMember struct {
	ID        bson.ObjectID `json:"id" bson:"_id,omitempty"`
	ProjectCode string        `json:"projectCode" bson:"projectCode"`
	UserID    bson.ObjectID `json:"userId" bson:"userId"`
	Role      ProjectRole   `json:"role" bson:"role"`
	CreatedBy bson.ObjectID `json:"createdBy" bson:"createdBy"`
	CreatedAt time.Time     `json:"createdAt" bson:"createdAt"`
}

// ProjectMemberView includes the user record for display in the UI.
type ProjectMemberView struct {
	ProjectMember `bson:",inline"`
	User          *User `json:"user,omitempty" bson:"-"`
}

// UpsertProjectMemberRequest adds or updates a project member.
type UpsertProjectMemberRequest struct {
	UserID string      `json:"userId"`
	Role   ProjectRole `json:"role"`
}
