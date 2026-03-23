package models

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// CodeCheckout represents an exclusive lock on a project's codebase for Claude Code execution.
// Only one user can hold the checkout for a project at a time.
type CodeCheckout struct {
	ID             bson.ObjectID `json:"id" bson:"_id,omitempty"`
	ProjectID      bson.ObjectID `json:"projectId" bson:"projectId"`
	UserID         bson.ObjectID `json:"userId" bson:"userId"`
	CheckedOutAt   time.Time     `json:"checkedOutAt" bson:"checkedOutAt"`
	LastActivityAt time.Time     `json:"lastActivityAt" bson:"lastActivityAt"`
	ExpiresAt      time.Time     `json:"expiresAt" bson:"expiresAt"`
}

// CheckoutStatus is the API response for checkout state.
type CheckoutStatus struct {
	Checkout    *CodeCheckout `json:"checkout,omitempty"`
	HeldByUser  *User         `json:"heldByUser,omitempty"`
	IsAvailable bool          `json:"isAvailable"`
	IsYours     bool          `json:"isYours"` // true if the requesting user holds it
}
