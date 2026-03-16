package models

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

type CustomLink struct {
	Label string `json:"label" bson:"label"`
	URL   string `json:"url" bson:"url"`
}

type ProjectLinks struct {
	LocalPath string       `json:"localPath,omitempty" bson:"localPath,omitempty"`
	GitHubURL string       `json:"githubUrl,omitempty" bson:"githubUrl,omitempty"`
	Custom    []CustomLink `json:"custom,omitempty" bson:"custom,omitempty"`
}

type HealthCheckEndpoint struct {
	DevURL  string `json:"devUrl,omitempty" bson:"devUrl,omitempty"`
	ProdURL string `json:"prodUrl,omitempty" bson:"prodUrl,omitempty"`
}

type HealthCheckConfig struct {
	Frontend   HealthCheckEndpoint `json:"frontend" bson:"frontend"`
	Backend    HealthCheckEndpoint `json:"backend" bson:"backend"`
	MonitorEnv string              `json:"monitorEnv" bson:"monitorEnv"` // "dev", "prod", or "" (off)
}

type HealthCheckResult struct {
	Name         string             `json:"name"`
	URL          string             `json:"url"`
	Status       string             `json:"status"` // "up", "down", "degraded", "unknown"
	Code         int                `json:"code,omitempty"`
	Error        string             `json:"error,omitempty"`
	SoftwareName string             `json:"softwareName,omitempty" bson:"softwareName,omitempty"` // from healthz "name" field
	Version      string             `json:"version,omitempty" bson:"version,omitempty"`
	Uptime       int                `json:"uptime,omitempty" bson:"uptime,omitempty"`
	Dependencies []HealthDependency `json:"dependencies,omitempty" bson:"dependencies,omitempty"`
	KPIs         []HealthKPI        `json:"kpis,omitempty" bson:"kpis,omitempty"`
}

type HealthDependency struct {
	Name    string `json:"name" bson:"name"`
	Status  string `json:"status" bson:"status"` // "healthy", "degraded", "unhealthy"
	Message string `json:"message,omitempty" bson:"message,omitempty"`
}

type HealthKPI struct {
	Name  string  `json:"name" bson:"name"`
	Value float64 `json:"value" bson:"value"`
	Unit  string  `json:"unit" bson:"unit"`
}

type DeploymentConfig struct {
	Provider    string `json:"provider,omitempty" bson:"provider,omitempty"`       // "flyio", "aws", "vercel", "manual", etc.
	StartDev    string `json:"startDev,omitempty" bson:"startDev,omitempty"`
	StopDev     string `json:"stopDev,omitempty" bson:"stopDev,omitempty"`
	DeployProd  string `json:"deployProd,omitempty" bson:"deployProd,omitempty"`
	RestartProd string `json:"restartProd,omitempty" bson:"restartProd,omitempty"`
	ViewLogs    string `json:"viewLogs,omitempty" bson:"viewLogs,omitempty"`
	FlyApp      string `json:"flyApp,omitempty" bson:"flyApp,omitempty"`
	FlyRegion   string `json:"flyRegion,omitempty" bson:"flyRegion,omitempty"`
	Notes       string `json:"notes,omitempty" bson:"notes,omitempty"`
}

type RecurringTheme struct {
	Theme         string    `json:"theme" bson:"theme"`
	FeedbackCount int       `json:"feedbackCount" bson:"feedbackCount"`
	RelatedIssues []string  `json:"relatedIssues" bson:"relatedIssues"`
	UpdatedAt     time.Time `json:"updatedAt" bson:"updatedAt"`
}

type Project struct {
	ID                    bson.ObjectID      `json:"id" bson:"_id,omitempty"`
	Name                  string             `json:"name" bson:"name"`
	Code                  string             `json:"code" bson:"code"`
	Description           string             `json:"description" bson:"description"`
	Links                 ProjectLinks       `json:"links" bson:"links"`
	Goals                 []string           `json:"goals" bson:"goals"`
	HealthCheck           *HealthCheckConfig `json:"healthCheck,omitempty" bson:"healthCheck,omitempty"`
	Deployment            *DeploymentConfig  `json:"deployment,omitempty" bson:"deployment,omitempty"`
	IssueCounter          int                `json:"issueCounter" bson:"issueCounter"`
	Archived              bool               `json:"archived" bson:"archived"`
	RecurringThemes       []RecurringTheme   `json:"recurringThemes,omitempty" bson:"recurringThemes,omitempty"`
	ArchitectureSummary   string             `json:"architectureSummary,omitempty" bson:"architectureSummary,omitempty"`
	ArchitectureUpdatedAt *time.Time         `json:"architectureUpdatedAt,omitempty" bson:"architectureUpdatedAt,omitempty"`
	VibectlMdGeneratedAt  *time.Time         `json:"vibectlMdGeneratedAt,omitempty" bson:"vibectlMdGeneratedAt,omitempty"`
	CreatedAt             time.Time          `json:"createdAt" bson:"createdAt"`
	UpdatedAt             time.Time          `json:"updatedAt" bson:"updatedAt"`
}

type CreateProjectRequest struct {
	Name        string       `json:"name"`
	Code        string       `json:"code"`
	Description string       `json:"description"`
	Links       ProjectLinks `json:"links"`
	Goals       []string     `json:"goals"`
}

type UpdateProjectRequest struct {
	Name        *string            `json:"name,omitempty"`
	Description *string            `json:"description,omitempty"`
	Links       *ProjectLinks      `json:"links,omitempty"`
	Goals       *[]string          `json:"goals,omitempty"`
	HealthCheck *HealthCheckConfig `json:"healthCheck,omitempty"`
	Deployment  *DeploymentConfig  `json:"deployment,omitempty"`
}
