package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/services"
)

type contextKey string

const currentUserKey contextKey = "currentUser"

// GetCurrentUser extracts the authenticated user from the request context.
// Returns nil if no user is present (should not happen on protected routes).
func GetCurrentUser(r *http.Request) *models.User {
	u, _ := r.Context().Value(currentUserKey).(*models.User)
	return u
}

// UserAuth validates the Bearer session token or API key, looks up the owning user,
// and populates the request context.
//
// Bootstrap mode: if no users exist yet (fresh install), all requests pass through
// as if authenticated — this preserves the zero-config first-run experience.
// Once any user account exists, authentication is always required.
//
// Token routing:
//   - "vk_…" prefix → API key lookup via apiKeySvc
//   - anything else  → session token lookup via sessionSvc
func UserAuth(userSvc *services.UserService, sessionSvc *services.AuthSessionService, apiKeySvc *services.APIKeyService) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()

			// Bootstrap mode: if no users exist, pass through transparently.
			count, err := userSvc.Count(ctx)
			if err == nil && count == 0 {
				next.ServeHTTP(w, r)
				return
			}

			token := extractBearerToken(r)
			if token == "" {
				WriteError(w, http.StatusUnauthorized, "authentication required", "UNAUTHORIZED")
				return
			}

			var user *models.User
			if services.IsAPIKeyToken(token) {
				user, err = apiKeySvc.Verify(ctx, token, userSvc)
				if err != nil || user == nil {
					WriteError(w, http.StatusUnauthorized, "invalid API key", "UNAUTHORIZED")
					return
				}
			} else {
				user, err = sessionSvc.Verify(ctx, token)
				if err != nil || user == nil {
					WriteError(w, http.StatusUnauthorized, "invalid or expired token", "UNAUTHORIZED")
					return
				}
			}

			if user.Disabled {
				WriteError(w, http.StatusForbidden, "account is disabled", "ACCOUNT_DISABLED")
				return
			}

			// Attach user to context for downstream handlers.
			next.ServeHTTP(w, r.WithContext(context.WithValue(ctx, currentUserKey, user)))
		})
	}
}

// RequireSuperAdmin is a middleware that allows only super_admin users through.
func RequireSuperAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user := GetCurrentUser(r)
		if user == nil || user.GlobalRole != models.GlobalRoleSuperAdmin {
			WriteError(w, http.StatusForbidden, "super_admin access required", "FORBIDDEN")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func extractBearerToken(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimPrefix(auth, "Bearer ")
	}
	if t := r.Header.Get("X-Vibectl-Token"); t != "" {
		return t
	}
	// Fallback: query param for SSE connections (EventSource can't set headers)
	return r.URL.Query().Get("token")
}

// AdminAuth is kept for backward compatibility with the CLI and any existing code paths.
// It now delegates to UserAuth internally.
func AdminAuth(adminService *services.AdminService) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			has, err := adminService.HasPassword(r.Context())
			if err != nil || !has {
				next.ServeHTTP(w, r)
				return
			}
			token := extractBearerToken(r)
			if token == "" {
				WriteError(w, http.StatusUnauthorized, "authentication required: set VIBECTL_TOKEN or run 'vibectl admin login'", "UNAUTHORIZED")
				return
			}
			ok, err := adminService.VerifyToken(r.Context(), token)
			if err != nil || !ok {
				WriteError(w, http.StatusUnauthorized, "invalid or expired token", "UNAUTHORIZED")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
