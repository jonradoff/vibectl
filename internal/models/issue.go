package models

import (
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

type IssueType string

const (
	IssueTypeBug     IssueType = "bug"
	IssueTypeFeature IssueType = "feature"
	IssueTypeIdea    IssueType = "idea"
)

type Priority string

const (
	PriorityP0 Priority = "P0"
	PriorityP1 Priority = "P1"
	PriorityP2 Priority = "P2"
	PriorityP3 Priority = "P3"
	PriorityP4 Priority = "P4"
	PriorityP5 Priority = "P5"
)

// Valid status transitions by issue type
var StatusTransitions = map[IssueType]map[string][]string{
	IssueTypeBug: {
		"open":             {"fixed", "cannot_reproduce"},
		"fixed":            {"closed"},
		"cannot_reproduce": {"closed"},
	},
	IssueTypeFeature: {
		"open":        {"approved", "backlogged"},
		"approved":    {"implemented"},
		"implemented": {"closed"},
	},
	IssueTypeIdea: {
		"open": {"closed", "backlogged"},
	},
}

func ValidateStatusTransition(issueType IssueType, currentStatus, newStatus string) error {
	transitions, ok := StatusTransitions[issueType]
	if !ok {
		return fmt.Errorf("unknown issue type: %s", issueType)
	}
	validNext, ok := transitions[currentStatus]
	if !ok {
		return fmt.Errorf("no transitions from status %q for type %s", currentStatus, issueType)
	}
	for _, s := range validNext {
		if s == newStatus {
			return nil
		}
	}
	return fmt.Errorf("invalid transition from %q to %q for type %s", currentStatus, newStatus, issueType)
}

func ValidIssueType(t string) bool {
	switch IssueType(t) {
	case IssueTypeBug, IssueTypeFeature, IssueTypeIdea:
		return true
	}
	return false
}

func ValidPriority(p string) bool {
	switch Priority(p) {
	case PriorityP0, PriorityP1, PriorityP2, PriorityP3, PriorityP4, PriorityP5:
		return true
	}
	return false
}

type Attachment struct {
	ID       string `json:"id" bson:"id"`
	Filename string `json:"filename" bson:"filename"`
	URL      string `json:"url" bson:"url"`
	MimeType string `json:"mimeType" bson:"mimeType"`
	Size     int64  `json:"size" bson:"size"`
}

type Issue struct {
	ID          bson.ObjectID `json:"id" bson:"_id,omitempty"`
	ProjectID   bson.ObjectID `json:"projectId" bson:"projectId"`
	IssueKey    string        `json:"issueKey" bson:"issueKey"`
	Number      int           `json:"number" bson:"number"`
	Title       string        `json:"title" bson:"title"`
	Description string        `json:"description" bson:"description"`
	Type        IssueType     `json:"type" bson:"type"`
	Priority    Priority      `json:"priority" bson:"priority"`
	Status      string        `json:"status" bson:"status"`
	Source           string        `json:"source,omitempty" bson:"source,omitempty"`
	SourceFeedbackID string        `json:"sourceFeedbackId,omitempty" bson:"sourceFeedbackId,omitempty"`
	CreatedBy        string        `json:"createdBy" bson:"createdBy"`
	DueDate     *time.Time    `json:"dueDate,omitempty" bson:"dueDate,omitempty"`
	ReproSteps  string        `json:"reproSteps,omitempty" bson:"reproSteps,omitempty"`
	Attachments []Attachment  `json:"attachments,omitempty" bson:"attachments,omitempty"`
	Archived    bool          `json:"archived" bson:"archived"`
	ArchivedAt  *time.Time    `json:"archivedAt,omitempty" bson:"archivedAt,omitempty"`
	CreatedAt   time.Time     `json:"createdAt" bson:"createdAt"`
	UpdatedAt   time.Time     `json:"updatedAt" bson:"updatedAt"`
}

type CreateIssueRequest struct {
	Title            string       `json:"title"`
	Description      string       `json:"description"`
	Type             IssueType    `json:"type"`
	Priority         Priority     `json:"priority"`
	Source           string       `json:"source,omitempty"`
	SourceFeedbackID string       `json:"sourceFeedbackId,omitempty"`
	CreatedBy        string       `json:"createdBy"`
	DueDate          string       `json:"dueDate,omitempty"`
	ReproSteps       string       `json:"reproSteps,omitempty"`
	Attachments      []Attachment `json:"attachments,omitempty"`
}

type UpdateIssueRequest struct {
	Title       *string   `json:"title,omitempty"`
	Description *string   `json:"description,omitempty"`
	Priority    *Priority `json:"priority,omitempty"`
	Source      *string   `json:"source,omitempty"`
	DueDate     *string   `json:"dueDate,omitempty"`
	ReproSteps  *string   `json:"reproSteps,omitempty"`
}

type StatusTransitionRequest struct {
	Status string `json:"status"`
}
