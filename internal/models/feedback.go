package models

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

type TriageStatus string

const (
	TriageStatusPending   TriageStatus = "pending"
	TriageStatusReviewed  TriageStatus = "reviewed"
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
	ID           bson.ObjectID  `json:"id" bson:"_id,omitempty"`
	ProjectID    *bson.ObjectID `json:"projectId,omitempty" bson:"projectId,omitempty"`
	SourceType   string         `json:"sourceType" bson:"sourceType"`
	SourceURL    string         `json:"sourceUrl,omitempty" bson:"sourceUrl,omitempty"`
	RawContent   string         `json:"rawContent" bson:"rawContent"`
	SubmittedBy  string         `json:"submittedBy,omitempty" bson:"submittedBy,omitempty"`
	SubmittedAt  time.Time      `json:"submittedAt" bson:"submittedAt"`
	TriageStatus TriageStatus   `json:"triageStatus" bson:"triageStatus"`
	AIAnalysis   *AIAnalysis    `json:"aiAnalysis,omitempty" bson:"aiAnalysis,omitempty"`
	ReviewedAt   *time.Time     `json:"reviewedAt,omitempty" bson:"reviewedAt,omitempty"`
}

type CreateFeedbackRequest struct {
	ProjectID   string `json:"projectId,omitempty"`
	SourceType  string `json:"sourceType"`
	SourceURL   string `json:"sourceUrl,omitempty"`
	RawContent  string `json:"rawContent"`
	SubmittedBy string `json:"submittedBy,omitempty"`
}

type ReviewFeedbackRequest struct {
	Action      string `json:"action"` // "accept" or "dismiss"
	CreateIssue bool   `json:"createIssue,omitempty"`
}
