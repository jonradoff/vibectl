package models

import "time"

type Settings struct {
	VibectlMdAutoRegen bool      `json:"vibectlMdAutoRegen" bson:"vibectlMdAutoRegen"`
	VibectlMdSchedule  string    `json:"vibectlMdSchedule" bson:"vibectlMdSchedule"` // "hourly", "daily", "weekly", "" (off)
	UpdatedAt          time.Time `json:"updatedAt" bson:"updatedAt"`

	// DefaultModel is the Claude model passed to every Claude Code spawn that
	// doesn't have a project-level override (Project.Model). Empty = let Claude
	// Code use its own default (whatever ~/.claude/settings.json or account default says).
	DefaultModel string `json:"defaultModel,omitempty" bson:"defaultModel,omitempty"`

	// Experimental features — all off by default.
	ExperimentalShell bool `json:"experimentalShell" bson:"experimentalShell"`

	// Stale project detection
	StaleProjectReminderDays int        `json:"staleProjectReminderDays" bson:"staleProjectReminderDays"` // default 7
	StaleProjectSnoozeUntil  *time.Time `json:"staleProjectSnoozeUntil,omitempty" bson:"staleProjectSnoozeUntil,omitempty"`
	ShowInactiveProjects     bool       `json:"showInactiveProjects" bson:"showInactiveProjects"`

	// Delegation — proxy non-session routes to a remote vibectl server
	DelegationEnabled  bool      `json:"delegationEnabled" bson:"delegationEnabled"`
	DelegationURL      string    `json:"delegationUrl,omitempty" bson:"delegationUrl,omitempty"`
	DelegationAPIKey   string    `json:"-" bson:"delegationApiKey,omitempty"`
	DelegationUser     string    `json:"delegationUser,omitempty" bson:"delegationUser,omitempty"`
	DelegationVerified time.Time `json:"delegationVerifiedAt,omitempty" bson:"delegationVerifiedAt,omitempty"`
}
