package middleware

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/services"
)

type contextKey string

const currentUserKey contextKey = "currentUser"

// Auth verify cache. Every protected request used to hit Mongo twice
// (userSvc.Count + sessionSvc/apiKeySvc.Verify). On a slow or degraded
// Atlas link the round-trips compound: a single page load fires 20-30
// parallel API calls, each stalling for the full server-selection
// window (~30-60s), each ultimately returning 401 → frontend clears
// the token → user is kicked to the login screen mid-session.
//
// This cache serves two purposes:
//   1. FRESH cache (default 60s): repeated calls within the window bypass
//      the DB entirely, so a page load is one verify not thirty.
//   2. STALE cache (default extra 300s): if the DB is unreachable and we
//      have a previously-verified entry, we keep serving the user rather
//      than 401ing them. This is the resilience path for degraded links.
//
// Cache keys are SHA-256 hashes of the raw token so we never store
// bearer tokens in memory. Real "invalid token" answers from the DB
// are cached briefly as negative entries so a bad token doesn't
// hammer the DB either.
type authCacheEntry struct {
	user        *models.User // nil = negative entry (bad token)
	verifiedAt  time.Time
	freshUntil  time.Time
	staleUntil  time.Time
}

var (
	authCache             sync.Map // string(hash) → *authCacheEntry
	authCacheFreshTTL     = 60 * time.Second
	authCacheStaleWindow  = 5 * time.Minute
	authCacheNegativeTTL  = 30 * time.Second
	authVerifyTimeout     = 3 * time.Second
	bootstrapCountCache   struct {
		mu         sync.Mutex
		hasUsers   bool
		checkedAt  time.Time
		ttl        time.Duration
	}
)

func init() {
	bootstrapCountCache.ttl = 30 * time.Second
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// hasUsersCached wraps userSvc.Count with a bounded timeout and a short
// cache so bootstrap-mode detection can't stall auth on a slow DB. On
// a timeout / error we return true (users exist) — the safe default,
// since falling into bootstrap mode incorrectly would let unauth'd
// requests through. Once we've seen "users exist" once, we cache that
// answer aggressively — the state changes at most once per install.
func hasUsersCached(ctx context.Context, userSvc *services.UserService) bool {
	bootstrapCountCache.mu.Lock()
	if !bootstrapCountCache.checkedAt.IsZero() && bootstrapCountCache.hasUsers {
		// Sticky positive: once users exist, they always exist for the process's lifetime.
		bootstrapCountCache.mu.Unlock()
		return true
	}
	if !bootstrapCountCache.checkedAt.IsZero() && time.Since(bootstrapCountCache.checkedAt) < bootstrapCountCache.ttl {
		result := bootstrapCountCache.hasUsers
		bootstrapCountCache.mu.Unlock()
		return result
	}
	bootstrapCountCache.mu.Unlock()

	countCtx, cancel := context.WithTimeout(ctx, authVerifyTimeout)
	defer cancel()
	count, err := userSvc.Count(countCtx)
	has := true
	if err == nil {
		has = count > 0
	}
	bootstrapCountCache.mu.Lock()
	bootstrapCountCache.hasUsers = has
	bootstrapCountCache.checkedAt = time.Now()
	bootstrapCountCache.mu.Unlock()
	return has
}

// verifyTokenCached looks up the token in the cache and, on miss or
// staleness, calls the appropriate Verify method with a bounded
// timeout. Under a healthy DB this behaves exactly like a direct
// call. Under a degraded DB, cached entries survive up to the stale
// window so the app stays alive rather than 401ing the user.
func verifyTokenCached(
	ctx context.Context,
	token string,
	sessionSvc *services.AuthSessionService,
	apiKeySvc *services.APIKeyService,
	userSvc *services.UserService,
) (*models.User, error) {
	key := hashToken(token)
	now := time.Now()

	if raw, ok := authCache.Load(key); ok {
		entry := raw.(*authCacheEntry)
		if now.Before(entry.freshUntil) {
			// Fresh: serve without touching DB. Negative entry → nil user.
			return entry.user, nil
		}
	}

	verifyCtx, cancel := context.WithTimeout(ctx, authVerifyTimeout)
	defer cancel()

	var (
		user *models.User
		err  error
	)
	if services.IsAPIKeyToken(token) {
		user, err = apiKeySvc.Verify(verifyCtx, token, userSvc)
	} else {
		user, err = sessionSvc.Verify(verifyCtx, token)
	}

	// DB timeout / server-selection error → serve stale if we can.
	if err != nil {
		if raw, ok := authCache.Load(key); ok {
			entry := raw.(*authCacheEntry)
			if now.Before(entry.staleUntil) {
				// Stale-while-error path: keep serving the last known good
				// answer rather than kicking the user out. Do NOT extend
				// freshUntil — the next request will retry the DB.
				return entry.user, nil
			}
		}
		return nil, err
	}

	// Success (positive or explicit-invalid): cache the answer.
	e := &authCacheEntry{
		user:       user,
		verifiedAt: now,
	}
	if user != nil {
		e.freshUntil = now.Add(authCacheFreshTTL)
		e.staleUntil = now.Add(authCacheFreshTTL + authCacheStaleWindow)
	} else {
		e.freshUntil = now.Add(authCacheNegativeTTL)
		e.staleUntil = e.freshUntil
	}
	authCache.Store(key, e)
	return user, nil
}

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
			// Cached + bounded so the check can't stall the request.
			if !hasUsersCached(ctx, userSvc) {
				next.ServeHTTP(w, r)
				return
			}

			token := extractBearerToken(r)
			if token == "" {
				WriteError(w, http.StatusUnauthorized, "authentication required", "UNAUTHORIZED")
				return
			}

			// Cached + bounded verify. Serves fresh answers from the process
			// cache for authCacheFreshTTL, and stale-while-error for up to
			// authCacheStaleWindow past that so a degraded DB doesn't kick
			// the user out mid-session. See verifyTokenCached.
			user, err := verifyTokenCached(ctx, token, sessionSvc, apiKeySvc, userSvc)
			if err != nil || user == nil {
				msg := "invalid or expired token"
				if services.IsAPIKeyToken(token) {
					msg = "invalid API key"
				}
				WriteError(w, http.StatusUnauthorized, msg, "UNAUTHORIZED")
				return
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

// InvalidateAuthCache drops the cached verify entry for a token — call
// after a logout so the token can't continue authenticating from cache
// until its natural expiry.
func InvalidateAuthCache(token string) {
	if token == "" {
		return
	}
	authCache.Delete(hashToken(token))
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
