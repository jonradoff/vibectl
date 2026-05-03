// Package adapters provides an extensible integration layer for third-party
// Claude Code plugins. VibeCtl defines data contracts (what it can display),
// and adapters know how to extract that data from specific plugin sources.
//
// Each adapter auto-detects whether its source is installed and returns
// enrichment data on demand. If a plugin isn't installed, its adapter
// returns nil — no errors, no broken UI, no configuration required.
package adapters

// ContextHealth represents the real-time health of a Claude Code session's
// context window, typically provided by a token optimization plugin.
type ContextHealth struct {
	Score             int     `json:"score"`                       // 0-100 quality score
	Grade             string  `json:"grade"`                       // S/A/B/C/D/F
	FillPct           float64 `json:"fillPct"`                     // context window fill percentage
	Compactions       int     `json:"compactions"`                 // number of compaction events
	CompactionLossPct float64 `json:"compactionLossPct,omitempty"` // cumulative context lost to compaction
	SessionDuration   string  `json:"sessionDuration,omitempty"`   // human-readable duration
}

// SessionCost represents the token cost of a session, broken down by model and pricing tier.
type SessionCost struct {
	InputTokens  int64   `json:"inputTokens"`
	OutputTokens int64   `json:"outputTokens"`
	CacheRead    int64   `json:"cacheRead,omitempty"`
	CacheWrite   int64   `json:"cacheWrite,omitempty"`
	CostUsd      float64 `json:"costUsd"`
	Model        string  `json:"model,omitempty"`
	PricingTier  string  `json:"pricingTier,omitempty"`
}

// WasteFinding represents an identified pattern of token waste.
type WasteFinding struct {
	Severity       string  `json:"severity"`       // low, medium, high, critical
	Pattern        string  `json:"pattern"`         // e.g., "output_waste", "cache_instability"
	Description    string  `json:"description"`
	Confidence     float64 `json:"confidence"`
	MonthlyWaste   float64 `json:"monthlyWasteUsd,omitempty"`
	Recommendation string  `json:"recommendation,omitempty"`
}

// ActivityMode represents the detected current activity in a Claude Code session.
type ActivityMode struct {
	Mode       string  `json:"mode"`       // code, debug, review, infra, general
	Confidence float64 `json:"confidence"`
}

// RecommendedPlugin describes a plugin that VibeCtl recommends for enhanced functionality.
type RecommendedPlugin struct {
	ID          string   `json:"id"`          // plugin ID (e.g., "token-optimizer@alexgreensh-token-optimizer")
	Name        string   `json:"name"`        // display name
	Description string   `json:"description"` // why VibeCtl recommends it
	InstallURL  string   `json:"installUrl"`  // GitHub URL for manual install
	Marketplace string   `json:"marketplace"` // marketplace ID for CLI install
	Features    []string `json:"features"`    // what VibeCtl features it enables
	Installed   bool     `json:"installed"`   // auto-detected
	Enabled     bool     `json:"enabled"`     // from settings.json
}
