package models

type ProjectSummary struct {
	Project          Project           `json:"project"`
	OpenIssueCount   int               `json:"openIssueCount"`
	IssuesByPriority map[string]int    `json:"issuesByPriority"`
	IssuesByStatus   map[string]int    `json:"issuesByStatus"`
	IssuesByType     map[string]int    `json:"issuesByType"`
	LastSession      *SessionLog       `json:"lastSession,omitempty"`
}

type GlobalDashboard struct {
	TotalProjects      int              `json:"totalProjects"`
	TotalOpenIssues    int              `json:"totalOpenIssues"`
	PendingFeedback    int              `json:"pendingFeedback"`
	ProjectSummaries   []ProjectSummary `json:"projectSummaries"`
}

type PMReviewResult struct {
	ID               string            `json:"id" bson:"_id,omitempty"`
	ProjectID        string            `json:"projectId" bson:"projectId"`
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
