package adapters

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// TokenOptimizerAdapter reads data from the token-optimizer Claude Code plugin.
// It detects the plugin's presence via installed_plugins.json and reads
// quality caches, snapshots, and session stores for enrichment data.
type TokenOptimizerAdapter struct {
	claudeDir  string
	pluginData string // ~/.claude/plugins/data/token-optimizer-alexgreensh-token-optimizer/
	detected   *bool
}

func NewTokenOptimizerAdapter() *TokenOptimizerAdapter {
	home, _ := os.UserHomeDir()
	claudeDir := filepath.Join(home, ".claude")
	return &TokenOptimizerAdapter{
		claudeDir:  claudeDir,
		pluginData: filepath.Join(claudeDir, "plugins", "data", "token-optimizer-alexgreensh-token-optimizer"),
	}
}

func (a *TokenOptimizerAdapter) Name() string {
	return "token-optimizer"
}

func (a *TokenOptimizerAdapter) Detect() bool {
	if a.detected != nil {
		return *a.detected
	}
	// Check installed_plugins.json for any token-optimizer entry
	data, err := os.ReadFile(filepath.Join(a.claudeDir, "plugins", "installed_plugins.json"))
	if err != nil {
		result := false
		a.detected = &result
		return false
	}
	var file struct {
		Plugins map[string]json.RawMessage `json:"plugins"`
	}
	if json.Unmarshal(data, &file) != nil {
		result := false
		a.detected = &result
		return false
	}
	for id := range file.Plugins {
		if strings.HasPrefix(id, "token-optimizer@") {
			result := true
			a.detected = &result
			return true
		}
	}
	result := false
	a.detected = &result
	return false
}

// GetContextHealth reads the quality cache for a session.
// The quality cache is written by token-optimizer's UserPromptSubmit hook.
func (a *TokenOptimizerAdapter) GetContextHealth(sessionID string) *ContextHealth {
	if sessionID == "" {
		return nil
	}

	// Quality cache files are at ~/.claude/plugins/data/token-optimizer-.../config/quality-cache-{sessionID}.json
	// Also check the main claude dir for quality caches
	candidates := []string{
		filepath.Join(a.pluginData, "config", "quality-cache-"+sessionID+".json"),
		filepath.Join(a.claudeDir, "token-optimizer", "quality-cache-"+sessionID+".json"),
	}

	for _, path := range candidates {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}

		var cache struct {
			Score    int     `json:"score"`
			Grade    string  `json:"grade"`
			FillPct  float64 `json:"fill_pct"`
			Compactions int  `json:"compactions"`
			CompactionDepth struct {
				CumulativeLossPct float64 `json:"cumulative_loss_pct"`
			} `json:"compaction_depth"`
			SessionStartTS float64 `json:"session_start_ts"`
		}
		if json.Unmarshal(data, &cache) != nil {
			continue
		}

		return &ContextHealth{
			Score:             cache.Score,
			Grade:             cache.Grade,
			FillPct:           cache.FillPct,
			Compactions:       cache.Compactions,
			CompactionLossPct: cache.CompactionDepth.CumulativeLossPct,
		}
	}

	return nil
}

// GetSessionCosts reads from the trends database. Placeholder for now —
// full implementation will query trends.db SQLite.
func (a *TokenOptimizerAdapter) GetSessionCosts(projectCode string, days int) []SessionCost {
	// TODO: Read from trends.db SQLite when implementing cost integration
	return nil
}

// GetWasteFindings reads the latest auto-snapshot for waste indicators.
func (a *TokenOptimizerAdapter) GetWasteFindings() []WasteFinding {
	// Read latest auto-snapshot for high-level waste signals
	snapshotDir := filepath.Join(a.pluginData, "data", "auto-snapshots")
	entries, err := os.ReadDir(snapshotDir)
	if err != nil || len(entries) == 0 {
		return nil
	}

	// Read the most recent snapshot
	latest := entries[len(entries)-1]
	data, err := os.ReadFile(filepath.Join(snapshotDir, latest.Name()))
	if err != nil {
		return nil
	}

	var snapshot struct {
		TotalOverhead      int `json:"total_overhead"`
		ControllableTokens int `json:"controllable_tokens"`
		ContextWindow      int `json:"context_window"`
		SkillTokens        int `json:"skill_tokens"`
		MCPTokens          int `json:"mcp_tokens"`
		MemoryMdTokens     int `json:"memory_md_tokens"`
		MemoryMdLines      int `json:"memory_md_lines"`
	}
	if json.Unmarshal(data, &snapshot) != nil {
		return nil
	}

	var findings []WasteFinding

	// Flag high overhead
	if snapshot.ContextWindow > 0 {
		overheadPct := float64(snapshot.TotalOverhead) / float64(snapshot.ContextWindow) * 100
		if overheadPct > 5 {
			findings = append(findings, WasteFinding{
				Severity:       "medium",
				Pattern:        "high_overhead",
				Description:    "Context overhead is " + formatPct(overheadPct) + " of window (" + formatTokens(snapshot.TotalOverhead) + " tokens)",
				Confidence:     0.9,
				Recommendation: "Run /token-optimizer for a full audit and optimization plan",
			})
		}
	}

	// Flag large MEMORY.md
	if snapshot.MemoryMdLines > 200 {
		findings = append(findings, WasteFinding{
			Severity:       "low",
			Pattern:        "large_memory",
			Description:    "MEMORY.md has " + formatInt(snapshot.MemoryMdLines) + " lines (" + formatTokens(snapshot.MemoryMdTokens) + " tokens)",
			Confidence:     0.8,
			Recommendation: "Consider pruning stale memory entries",
		})
	}

	return findings
}

// GetActivityMode reads the session store for the current activity mode.
// Placeholder — full implementation will query session SQLite.
func (a *TokenOptimizerAdapter) GetActivityMode(sessionID string) *ActivityMode {
	// TODO: Read from session-store/{sessionID}.db → session_meta → current_mode
	return nil
}

// --- helpers ---

func formatPct(v float64) string {
	if v < 1 {
		return "<1%"
	}
	return fmt.Sprintf("%.1f%%", v)
}

func formatTokens(v int) string {
	if v >= 1000 {
		return fmt.Sprintf("%.1fK", float64(v)/1000)
	}
	return fmt.Sprintf("%d", v)
}

func formatInt(v int) string {
	return fmt.Sprintf("%d", v)
}
