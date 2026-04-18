package models

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// PRLink tracks a GitHub PR linked to an intent.
type PRLink struct {
	URL      string     `json:"url" bson:"url"`
	Number   int        `json:"number" bson:"number"`
	Repo     string     `json:"repo" bson:"repo"`
	State    string     `json:"state" bson:"state"` // open, merged, closed
	MergedAt *time.Time `json:"mergedAt,omitempty" bson:"mergedAt,omitempty"`
}

// Intent represents a developer intent extracted from one or more chat sessions.
type Intent struct {
	ID             bson.ObjectID `json:"id" bson:"_id,omitempty"`
	ProjectCode    string        `json:"projectCode" bson:"projectCode"`
	SessionIDs     []string      `json:"sessionIds" bson:"sessionIds"`
	Title          string        `json:"title" bson:"title"`
	Description    string        `json:"description" bson:"description"`
	Category       string        `json:"category" bson:"category"`             // UI | API | infra | data | test | docs | bugfix | refactor
	TechTags       []string      `json:"techTags" bson:"techTags"`             // e.g. ["react", "typescript"]
	UXJudgment     string        `json:"uxJudgment" bson:"uxJudgment"`         // low | medium | high
	Size           string        `json:"size" bson:"size"`                     // S | M | L | XL
	SizePoints     int           `json:"sizePoints" bson:"sizePoints"`         // 1 | 3 | 5 | 8
	Status         string        `json:"status" bson:"status"`                 // delivered | partial | abandoned | deferred
	StatusEvidence string        `json:"statusEvidence" bson:"statusEvidence"`
	FilesChanged   []string      `json:"filesChanged" bson:"filesChanged"`
	CommitCount    int           `json:"commitCount" bson:"commitCount"`
	PromptCount    int           `json:"promptCount" bson:"promptCount"`
	TokensInput    int64         `json:"tokensInput" bson:"tokensInput"`
	TokensOutput   int64         `json:"tokensOutput" bson:"tokensOutput"`
	WallClockSecs  int64         `json:"wallClockSecs" bson:"wallClockSecs"`
	AnalysisModel  string        `json:"analysisModel" bson:"analysisModel"`
	StartedAt      time.Time     `json:"startedAt" bson:"startedAt"`
	CompletedAt    time.Time     `json:"completedAt" bson:"completedAt"`
	ExtractedAt    time.Time     `json:"extractedAt" bson:"extractedAt"`
	PRLinks        []PRLink      `json:"prLinks,omitempty" bson:"prLinks,omitempty"`
	BranchName     string        `json:"branchName,omitempty" bson:"branchName,omitempty"`
	MergeCount     int           `json:"mergeCount,omitempty" bson:"mergeCount,omitempty"`
	MergedAt       *time.Time    `json:"mergedAt,omitempty" bson:"mergedAt,omitempty"`
}
