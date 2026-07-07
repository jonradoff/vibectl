package terminal

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// RunOnDiskConsistencyCheck iterates the chat_sessions collection and, for
// every doc with a claudeSessionId, verifies that the JSONL exists under the
// direct-encoded ~/.claude/projects/<encoded>/ location. Any that don't get
// a cross-dir fallback lookup (findSessionAnywhere) and a log line — either
// "resolved via fallback: <alt-path>" if we found it under a different
// encoded dir (project probably moved), or "orphan" if we couldn't find it
// anywhere.
//
// Runs async so it doesn't block startup. Purely observational — no repairs.
//
// The check is called by cmd/server/main.go after all services are wired.
// Requires a "session summary" callback that yields (projectCode, sessionID,
// localPath) tuples; keeps this helper decoupled from the concrete DB service.
type SessionSummaryFn func(ctx context.Context) []SessionSummary

// SessionSummary is a lightweight row shape used by the consistency check.
type SessionSummary struct {
	ProjectCode     string
	ClaudeSessionID string
	LocalPath       string
}

// RunOnDiskConsistencyCheck launches the scan in a goroutine.
func RunOnDiskConsistencyCheck(list SessionSummaryFn) {
	if list == nil {
		return
	}
	go runOnDiskConsistencyCheck(list)
}

func runOnDiskConsistencyCheck(list SessionSummaryFn) {
	// Small delay to let higher-priority startup work drain.
	time.Sleep(3 * time.Second)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	rows := list(ctx)
	if len(rows) == 0 {
		return
	}
	home, err := os.UserHomeDir()
	if err != nil {
		slog.Warn("consistency check: cannot resolve home dir", "error", err)
		return
	}

	var ok, moved, orphan, skipped int
	for _, r := range rows {
		if r.ClaudeSessionID == "" {
			skipped++
			continue
		}
		if r.LocalPath == "" {
			// No path to compute an "expected" encoding; try cross-dir directly.
			if alt := findSessionAnywhere(home, r.ClaudeSessionID); alt != "" {
				moved++
				slog.Info("consistency: on-disk session found via cross-dir fallback (no localPath)",
					"projectCode", r.ProjectCode, "sessionID", r.ClaudeSessionID, "path", alt)
			} else {
				orphan++
				slog.Warn("consistency: on-disk session not found anywhere",
					"projectCode", r.ProjectCode, "sessionID", r.ClaudeSessionID)
			}
			continue
		}
		encoded := strings.ReplaceAll(r.LocalPath, "/", "-")
		if !strings.HasPrefix(encoded, "-") {
			encoded = "-" + encoded
		}
		expected := filepath.Join(home, ".claude", "projects", encoded, r.ClaudeSessionID+".jsonl")
		if info, err := os.Stat(expected); err == nil && !info.IsDir() {
			ok++
			continue
		}
		if alt := findSessionAnywhere(home, r.ClaudeSessionID); alt != "" {
			moved++
			slog.Info("consistency: on-disk session moved (project renamed?) — resolved via cross-dir fallback",
				"projectCode", r.ProjectCode,
				"sessionID", r.ClaudeSessionID,
				"expected", expected,
				"actual", alt)
			continue
		}
		orphan++
		slog.Warn("consistency: on-disk session not found anywhere",
			"projectCode", r.ProjectCode,
			"sessionID", r.ClaudeSessionID,
			"expected", expected)
	}
	slog.Info("consistency check complete",
		"total", len(rows), "ok", ok, "moved", moved, "orphan", orphan, "skipped", skipped)
}
