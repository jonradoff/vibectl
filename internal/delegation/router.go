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
}

// localProjectSubPaths are project sub-routes that stay local (under /api/v1/projects/{id}/...).
var localProjectSubPaths = []string{
	"chat-session",
	"chat-history",
	"files/list",
	"files/read",
	"files/write",
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

	// Check project sub-routes: /api/v1/projects/{id}/chat-session etc.
	if strings.HasPrefix(path, "/api/v1/projects/") {
		parts := strings.SplitN(path, "/", 6) // ["", "api", "v1", "projects", "{id}", "sub/path"]
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
