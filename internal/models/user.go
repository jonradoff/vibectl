package models

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// GlobalRole is the system-wide access level for a user.
type GlobalRole string

const (
	GlobalRoleSuperAdmin GlobalRole = "super_admin"
	GlobalRoleMember     GlobalRole = "member"
)

// ProjectRole is the access level within a specific project.
type ProjectRole string

const (
	ProjectRoleOwner       ProjectRole = "owner"
	ProjectRoleDevOps      ProjectRole = "devops"
	ProjectRoleDeveloper   ProjectRole = "developer"
	ProjectRoleContributor ProjectRole = "contributor"
	ProjectRoleReporter    ProjectRole = "reporter"
	ProjectRoleViewer      ProjectRole = "viewer"
)

// ProjectRoleRank returns a numeric rank for role comparison (higher = more access).
func ProjectRoleRank(r ProjectRole) int {
	switch r {
	case ProjectRoleOwner:
		return 6
	case ProjectRoleDevOps:
		return 5
	case ProjectRoleDeveloper:
		return 4
	case ProjectRoleContributor:
		return 3
	case ProjectRoleReporter:
		return 2
	case ProjectRoleViewer:
		return 1
	default:
		return 0
	}
}

// User represents a VibeCtl user account.
type User struct {
	ID                    bson.ObjectID  `json:"id" bson:"_id,omitempty"`
	DisplayName           string         `json:"displayName" bson:"displayName"`
	Email                 string         `json:"email,omitempty" bson:"email,omitempty"`
	PasswordHash          string         `json:"-" bson:"passwordHash,omitempty"`
	IsDefaultPassword     bool           `json:"isDefaultPassword" bson:"isDefaultPassword"`
	GitHubID              string         `json:"githubId,omitempty" bson:"githubId,omitempty"`
	GitHubUsername        string         `json:"githubUsername,omitempty" bson:"githubUsername,omitempty"`
	GlobalRole            GlobalRole     `json:"globalRole" bson:"globalRole"`
	IsAdminFallback       bool           `json:"isAdminFallback" bson:"isAdminFallback"`
	AnthropicKeyEncrypted string         `json:"-" bson:"anthropicKeyEncrypted,omitempty"`
	HasAnthropicKey       bool           `json:"hasAnthropicKey" bson:"hasAnthropicKey"`
	GitHubPATEncrypted    string         `json:"-" bson:"githubPatEncrypted,omitempty"`
	HasGitHubPAT          bool           `json:"hasGitHubPAT" bson:"hasGitHubPAT"`
	GitName               string         `json:"gitName,omitempty" bson:"gitName,omitempty"`
	GitEmail              string         `json:"gitEmail,omitempty" bson:"gitEmail,omitempty"`
	Disabled              bool           `json:"disabled" bson:"disabled"`
	WorkspaceDir          string         `json:"workspaceDir,omitempty" bson:"workspaceDir,omitempty"`
	ClaudeCodeFontSize    int            `json:"claudeCodeFontSize,omitempty" bson:"claudeCodeFontSize,omitempty"` // 0 = default (14px)
	LastLoginAt           *time.Time     `json:"lastLoginAt,omitempty" bson:"lastLoginAt,omitempty"`
	CreatedBy             *bson.ObjectID `json:"createdBy,omitempty" bson:"createdBy,omitempty"`
	CreatedAt             time.Time      `json:"createdAt" bson:"createdAt"`
	UpdatedAt             time.Time      `json:"updatedAt" bson:"updatedAt"`
}

// UpdateUserRequest updates a user's profile fields.
type UpdateUserRequest struct {
	DisplayName    *string     `json:"displayName,omitempty"`
	Email          *string     `json:"email,omitempty"`
	GitName        *string     `json:"gitName,omitempty"`
	GitEmail       *string     `json:"gitEmail,omitempty"`
	GlobalRole     *GlobalRole `json:"globalRole,omitempty"`
	GitHubUsername *string     `json:"githubUsername,omitempty"`
	Disabled       *bool       `json:"disabled,omitempty"`
	WorkspaceDir       *string `json:"workspaceDir,omitempty"`
	ClaudeCodeFontSize *int    `json:"claudeCodeFontSize,omitempty"`
}
