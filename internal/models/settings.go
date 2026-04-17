package models

import "time"

type Settings struct {
	VibectlMdAutoRegen bool      `json:"vibectlMdAutoRegen" bson:"vibectlMdAutoRegen"`
	VibectlMdSchedule  string    `json:"vibectlMdSchedule" bson:"vibectlMdSchedule"` // "hourly", "daily", "weekly", "" (off)
	UpdatedAt          time.Time `json:"updatedAt" bson:"updatedAt"`

	// Experimental features — all off by default.
	ExperimentalShell bool `json:"experimentalShell" bson:"experimentalShell"`

	// Stale project detection
	StaleProjectReminderDays int        `json:"staleProjectReminderDays" bson:"staleProjectReminderDays"` // default 7
	StaleProjectSnoozeUntil  *time.Time `json:"staleProjectSnoozeUntil,omitempty" bson:"staleProjectSnoozeUntil,omitempty"`
	ShowInactiveProjects     bool       `json:"showInactiveProjects" bson:"showInactiveProjects"`
}
