package models

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

type TriageStatus string

const (
	TriageStatusPending   TriageStatus = "pending"
	TriageStatusTriaged   TriageStatus = "triaged"   // AI has analyzed; awaiting human review
	TriageStatusReviewed  TriageStatus = "reviewed"  // legacy alias — kept for backward compat
	TriageStatusAccepted  TriageStatus = "accepted"
	TriageStatusDismissed TriageStatus = "dismissed"
)

type ProposedIssue struct {
	Title       string `json:"title" bson:"title"`
	Description string `json:"description" bson:"description"`
	Type        string `json:"type" bson:"type"`
	Priority    string `json:"priority" bson:"priority"`
	ReproSteps  string `json:"reproSteps,omitempty" bson:"reproSteps,omitempty"`
}

type AIAnalysis struct {
	MatchedIssueKeys []string       `json:"matchedIssueKeys" bson:"matchedIssueKeys"`
	ProposedIssue    *ProposedIssue `json:"proposedIssue,omitempty" bson:"proposedIssue,omitempty"`
	Confidence       float64        `json:"confidence" bson:"confidence"`
	Reasoning        string         `json:"reasoning" bson:"reasoning"`
}

type FeedbackItem struct {
	ID              bson.ObjectID          `json:"id" bson:"_id,omitempty"`
	ProjectCode     string                 `json:"projectCode,omitempty" bson:"projectCode,omitempty"`
	SourceType      string                 `json:"sourceType" bson:"sourceType"`
	SourceURL       string                 `json:"sourceUrl,omitempty" bson:"sourceUrl,omitempty"`
	RawContent      string                 `json:"rawContent" bson:"rawContent"`
	SubmittedBy     string                 `json:"submittedBy,omitempty" bson:"submittedBy,omitempty"`
	SubmittedAt     time.Time              `json:"submittedAt" bson:"submittedAt"`
	TriageStatus    TriageStatus           `json:"triageStatus" bson:"triageStatus"`
	AIAnalysis      *AIAnalysis            `json:"aiAnalysis,omitempty" bson:"aiAnalysis,omitempty"`
	TriagedAt       *time.Time             `json:"triagedAt,omitempty" bson:"triagedAt,omitempty"`
	ReviewedAt      *time.Time             `json:"reviewedAt,omitempty" bson:"reviewedAt,omitempty"`
	LinkedIssueKey  string                 `json:"linkedIssueKey,omitempty" bson:"linkedIssueKey,omitempty"`
	Metadata        map[string]interface{} `json:"metadata,omitempty" bson:"metadata,omitempty"`       // structured context from external apps
	SubmittedViaKey string                 `json:"submittedViaKey,omitempty" bson:"submittedViaKey,omitempty"` // API key name that authorized this submission
}

type CreateFeedbackRequest struct {
	ProjectID       string                 `json:"projectId,omitempty"`
	ProjectCode     string                 `json:"projectCode,omitempty"`     // alternative to projectId — resolved to ID by handler
	SourceType      string                 `json:"sourceType"`
	SourceURL       string                 `json:"sourceUrl,omitempty"`
	RawContent      string                 `json:"rawContent"`
	SubmittedBy     string                 `json:"submittedBy,omitempty"`
	Metadata        map[string]interface{} `json:"metadata,omitempty"`        // structured context from external apps
	SubmittedViaKey string                 `json:"-"`                         // set by handler from auth context, not user-provided
}

type ReviewFeedbackRequest struct {
	Action      string `json:"action"` // "accept" or "dismiss"
	CreateIssue bool   `json:"createIssue,omitempty"`
	// Manual overrides when no AI proposal exists
	IssueTitle       string `json:"issueTitle,omitempty"`
	IssueDescription string `json:"issueDescription,omitempty"`
	IssueType        string `json:"issueType,omitempty"`
	IssuePriority    string `json:"issuePriority,omitempty"`
}

type BulkReviewRequest struct {
	Items []BulkReviewItem `json:"items"`
}

type BulkReviewItem struct {
	ID     string `json:"id"`
	Action string `json:"action"` // "accept" or "dismiss"
}
