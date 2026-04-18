package models

type ProjectSummary struct {
	Project          Project           `json:"project"`
	OpenIssueCount   int               `json:"openIssueCount"`
	IssuesByPriority map[string]int    `json:"issuesByPriority"`
	IssuesByStatus   map[string]int    `json:"issuesByStatus"`
	IssuesByType     map[string]int    `json:"issuesByType"`
	LastSession          *SessionLog    `json:"lastSession,omitempty"`
	CurrentUserRole      string         `json:"currentUserRole"` // "owner" for super_admin; project role or "" for others
	PendingFeedbackCount int            `json:"pendingFeedbackCount"`
}

type GlobalDashboard struct {
	TotalProjects      int              `json:"totalProjects"`
	TotalOpenIssues    int              `json:"totalOpenIssues"`
	PendingFeedback    int              `json:"pendingFeedback"`
	ProjectSummaries   []ProjectSummary `json:"projectSummaries"`
}

// ProjectUniverseData is the per-project data returned by GET /api/v1/dashboard/universe.
type ProjectUniverseData struct {
	ProjectCode          string         `json:"projectCode"`
	ProjectName          string         `json:"projectName"`
	ActivityByDay        []int          `json:"activityByDay"`   // last 90 days, oldest first
	HealthByDay          []string       `json:"healthByDay"`     // last 7 days, oldest first: "up"/"down"/"degraded"/"unknown"
	OpenIssueCount       int            `json:"openIssueCount"`
	IssuesByStatus       map[string]int `json:"issuesByStatus"`
	CurrentHealth        string         `json:"currentHealth"`   // "up"/"down"/"degraded"/"unknown"/"none"
	PendingFeedbackCount int            `json:"pendingFeedbackCount"`
	LastActivityAt       *string        `json:"lastActivityAt,omitempty"`
	PromptCount          int            `json:"promptCount"`          // total prompts for this project
	LastPromptAt         *string        `json:"lastPromptAt,omitempty"` // RFC3339 timestamp of last prompt_sent
	ProjectType          string         `json:"projectType,omitempty"` // "multi" for multi-module projects
	ParentID             string         `json:"parentId,omitempty"`
	UnitName             string         `json:"unitName,omitempty"`
	Tags                 []string       `json:"tags,omitempty"`
	Inactive             bool           `json:"inactive,omitempty"`
}

type PMReviewResult struct {
	ID               string            `json:"id" bson:"_id,omitempty"`
	ProjectCode      string            `json:"projectCode" bson:"projectCode"`
	GoalAssessments  []GoalAssessment  `json:"goalAssessments" bson:"goalAssessments"`
	Gaps             []Gap             `json:"gaps" bson:"gaps"`
	Risks            []Risk            `json:"risks" bson:"risks"`
	Reprioritizations []Reprioritization `json:"reprioritizations" bson:"reprioritizations"`
	OverallAssessment string           `json:"overallAssessment" bson:"overallAssessment"`
	CreatedAt        string            `json:"createdAt" bson:"createdAt"`
}

type GoalAssessment struct {
	Goal     string `json:"goal" bson:"goal"`
	Coverage string `json:"coverage" bson:"coverage"`
	Notes    string `json:"notes" bson:"notes"`
}

type Gap struct {
	Description    string        `json:"description" bson:"description"`
	SuggestedIssue ProposedIssue `json:"suggestedIssue" bson:"suggestedIssue"`
}

type Risk struct {
	IssueKey string `json:"issueKey" bson:"issueKey"`
	Concern  string `json:"concern" bson:"concern"`
}

type Reprioritization struct {
	IssueKey          string `json:"issueKey" bson:"issueKey"`
	CurrentPriority   string `json:"currentPriority" bson:"currentPriority"`
	SuggestedPriority string `json:"suggestedPriority" bson:"suggestedPriority"`
	Reason            string `json:"reason" bson:"reason"`
}
