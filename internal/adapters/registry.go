package adapters

import (
	"log/slog"
	"sync"
)

// Adapter is the interface that all plugin adapters implement.
// Each method returns nil if the data is unavailable (plugin not installed,
// data file missing, etc.). Callers should always handle nil gracefully.
type Adapter interface {
	// Name returns a human-readable name for this adapter.
	Name() string

	// Detect returns true if the adapter's source plugin is installed and usable.
	Detect() bool

	// GetContextHealth returns the current context health for a session.
	// sessionID is the Claude Code session ID (UUID).
	GetContextHealth(sessionID string) *ContextHealth

	// GetSessionCosts returns cost data for recent sessions.
	GetSessionCosts(projectCode string, days int) []SessionCost

	// GetWasteFindings returns identified waste patterns.
	GetWasteFindings() []WasteFinding

	// GetActivityMode returns the current activity mode for a session.
	GetActivityMode(sessionID string) *ActivityMode
}

// Registry manages adapter discovery and provides a unified query interface.
// It auto-detects which adapters are available on startup and caches the result.
type Registry struct {
	adapters   []Adapter
	detected   []Adapter // adapters whose Detect() returned true
	detectOnce sync.Once
}

// NewRegistry creates a registry with the given adapters.
// Call Register() to add adapters, then any Get* method to query.
func NewRegistry() *Registry {
	return &Registry{}
}

// Register adds an adapter to the registry.
func (r *Registry) Register(a Adapter) {
	r.adapters = append(r.adapters, a)
}

// ensureDetected runs Detect() on all adapters once.
func (r *Registry) ensureDetected() {
	r.detectOnce.Do(func() {
		for _, a := range r.adapters {
			if a.Detect() {
				r.detected = append(r.detected, a)
				slog.Info("adapter detected", "name", a.Name())
			}
		}
		if len(r.detected) == 0 {
			slog.Info("no plugin adapters detected")
		}
	})
}

// Refresh re-runs detection (e.g., after a plugin install/uninstall).
func (r *Registry) Refresh() {
	r.detectOnce = sync.Once{}
	r.detected = nil
	r.ensureDetected()
}

// GetContextHealth queries all detected adapters and returns the first non-nil result.
func (r *Registry) GetContextHealth(sessionID string) *ContextHealth {
	r.ensureDetected()
	for _, a := range r.detected {
		if h := a.GetContextHealth(sessionID); h != nil {
			return h
		}
	}
	return nil
}

// GetSessionCosts queries all detected adapters and returns merged cost data.
func (r *Registry) GetSessionCosts(projectCode string, days int) []SessionCost {
	r.ensureDetected()
	var all []SessionCost
	for _, a := range r.detected {
		all = append(all, a.GetSessionCosts(projectCode, days)...)
	}
	return all
}

// GetWasteFindings queries all detected adapters and returns merged findings.
func (r *Registry) GetWasteFindings() []WasteFinding {
	r.ensureDetected()
	var all []WasteFinding
	for _, a := range r.detected {
		all = append(all, a.GetWasteFindings()...)
	}
	return all
}

// GetActivityMode queries all detected adapters and returns the first non-nil result.
func (r *Registry) GetActivityMode(sessionID string) *ActivityMode {
	r.ensureDetected()
	for _, a := range r.detected {
		if m := a.GetActivityMode(sessionID); m != nil {
			return m
		}
	}
	return nil
}

// DetectedAdapters returns the names of all detected adapters.
func (r *Registry) DetectedAdapters() []string {
	r.ensureDetected()
	names := make([]string, len(r.detected))
	for i, a := range r.detected {
		names[i] = a.Name()
	}
	return names
}

// HasAdapter returns true if an adapter with the given name is detected.
func (r *Registry) HasAdapter(name string) bool {
	r.ensureDetected()
	for _, a := range r.detected {
		if a.Name() == name {
			return true
		}
	}
	return false
}
