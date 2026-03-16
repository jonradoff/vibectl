package middleware

import (
	"net/http"
	"strings"

	"github.com/jonradoff/vibectl/internal/services"
)

// AdminAuth returns a middleware that requires a valid admin Bearer token on protected routes.
// If no admin password has been configured (bootstrap mode), all requests pass through.
func AdminAuth(adminService *services.AdminService) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			has, err := adminService.HasPassword(r.Context())
			if err != nil || !has {
				// No password set — open access until one is configured.
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

func extractBearerToken(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimPrefix(auth, "Bearer ")
	}
	return r.Header.Get("X-Vibectl-Token")
}
