package delegation

import "strings"

// localPrefixes are API paths that always stay on the local instance, even in delegated mode.
var localPrefixes = []string{
	"/api/v1/auth/",
	"/api/v1/admin/",
	"/api/v1/delegation/",
	"/api/v1/settings",
	"/api/v1/mode",
	"/api/v1/api-keys",
	"/api/v1/users/me",
	"/api/v1/chat-history/",
	"/api/v1/claude-usage/",
	"/api/v1/local-paths",
	"/api/v1/check-dir",
	"/api/v1/ensure-dir",
	"/api/v1/detect-git-remote",
	"/api/v1/detect-fly-toml",
	"/api/v1/detect-start-sh",
	"/api/v1/detect-deploy-sh",
	"/api/v1/detect-project-scripts",
	// Dashboard stays local — it builds ProjectSummary from local project data
	"/api/v1/dashboard",
	// Intents stay local — extraction runs locally from chat sessions.
	// Extracted intents are pushed to remote separately for team aggregation.
	"/api/v1/intents",
}

// localExactPaths are paths that match exactly (not as prefixes).
// /api/v1/projects itself is local (for local paths), but /api/v1/projects/{id}/feedback etc. proxy to remote.
var localExactPaths = []string{
	"/api/v1/projects",       // project list
	"/api/v1/projects/tags",
	"/api/v1/projects/stale",
	"/api/v1/projects/archived",
}

// localProjectSubPaths are project sub-routes that stay local (under /api/v1/projects/{id}/...).
var localProjectSubPaths = []string{
	"chat-session",
	"chat-history",
	"files/list",
	"files/read",
	"files/write",
	"feedback",
}

// IsLocalRoute returns true if the given path should be handled locally, even when delegation is active.
func IsLocalRoute(path string) bool {
	// Non-API routes are always local (static files, healthz, WebSocket endpoints)
	if !strings.HasPrefix(path, "/api/v1/") {
		return true
	}

	// Check direct local prefixes
	for _, prefix := range localPrefixes {
		if strings.HasPrefix(path, prefix) {
			return true
		}
	}

	// Check exact local paths (e.g., /api/v1/projects but not /api/v1/projects/{id}/feedback)
	for _, exact := range localExactPaths {
		if path == exact || path == exact+"/" {
			return true
		}
	}

	// Check project sub-routes under /api/v1/projects/{id}/...
	if strings.HasPrefix(path, "/api/v1/projects/") {
		parts := strings.SplitN(path, "/", 6) // ["", "api", "v1", "projects", "{id}", "sub/path"]

		// /api/v1/projects/{id} with no sub-path — local (project detail with local paths)
		if len(parts) == 5 {
			return true
		}

		// /api/v1/projects/{id}/sub-path — check if sub-path is local
		if len(parts) >= 6 {
			subPath := parts[5]
			for _, local := range localProjectSubPaths {
				if strings.HasPrefix(subPath, local) {
					return true
				}
			}
		}
	}

	return false
}
