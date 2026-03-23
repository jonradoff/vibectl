package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/services"
)

// AuthHandler handles all authentication flows: password login, GitHub OAuth, change-password, and self-info.
type AuthHandler struct {
	userSvc          *services.UserService
	sessionSvc       *services.AuthSessionService
	adminSvc         *services.AdminService // kept for CLI backward compat (admin set-password)
	githubClientID   string
	githubSecret     string
	githubToken      string // GITHUB_TOKEN for CI status checks
	baseURL          string
	frontendURL      string // where to redirect after OAuth
	anthropicEnabled bool   // whether ANTHROPIC_API_KEY is configured

	// In-memory OAuth state store (nonce → oauthState). Fine for single-server self-hosted use.
	stateMu    sync.Mutex
	stateStore map[string]oauthState
}

type oauthState struct {
	ExpiresAt  time.Time
	LinkUserID string // non-empty when linking GitHub to an existing authenticated user
}

// loginAttempt tracks per-IP login rate limiting.
type loginAttempt struct {
	count     int
	windowEnd time.Time
}

var (
	loginAttempts = map[string]*loginAttempt{}
	loginMu       sync.Mutex
)

const (
	loginMaxAttempts = 10
	loginWindow      = 5 * time.Minute
)

func NewAuthHandler(userSvc *services.UserService, sessionSvc *services.AuthSessionService, adminSvc *services.AdminService, githubClientID, githubSecret, githubToken, baseURL, frontendURL string, anthropicEnabled bool) *AuthHandler {
	return &AuthHandler{
		userSvc:          userSvc,
		sessionSvc:       sessionSvc,
		adminSvc:         adminSvc,
		githubClientID:   githubClientID,
		githubSecret:     githubSecret,
		githubToken:      githubToken,
		baseURL:          baseURL,
		frontendURL:      frontendURL,
		anthropicEnabled: anthropicEnabled,
		stateStore:       make(map[string]oauthState),
	}
}

// AuthStatus returns the current auth state for the frontend.
// This endpoint is always public.
func (h *AuthHandler) AuthStatus(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	count, _ := h.userSvc.Count(ctx)
	noUsers := count == 0

	var tokenValid bool
	token := extractBearerToken(r)
	if token != "" && !noUsers {
		if u, err := h.sessionSvc.Verify(ctx, token); err == nil && u != nil {
			tokenValid = true
		}
	}

	// In bootstrap mode (no users), deny access — admin must be set up via CLI first

	middleware.WriteJSON(w, http.StatusOK, map[string]any{
		"usersExist":              !noUsers,
		"tokenValid":              tokenValid,
		"githubEnabled":           h.githubClientID != "",
		"githubTokenConfigured":   h.githubToken != "",
		"anthropicEnabled":        h.anthropicEnabled,
	})
}

// Me returns the current authenticated user.
func (h *AuthHandler) Me(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetCurrentUser(r)
	if user == nil {
		middleware.WriteError(w, http.StatusUnauthorized, "not authenticated", "UNAUTHORIZED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, user)
}

// Login accepts email/password (or "admin"/password for the fallback account) and returns a session token.
func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	if !checkLoginRateLimit(r) {
		middleware.WriteError(w, http.StatusTooManyRequests, "too many login attempts, try again later", "RATE_LIMITED")
		return
	}

	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		// Legacy field name from the old single-admin system
		AdminPassword string `json:"password_admin"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "INVALID_BODY")
		return
	}
	// Support legacy "password" field from the old admin login
	password := req.Password
	if password == "" {
		password = req.AdminPassword
	}
	email := req.Email
	if email == "" {
		email = "admin" // legacy: single-admin mode used password-only login
	}

	user, err := h.userSvc.ValidatePassword(r.Context(), email, password)
	if err != nil {
		slog.Warn("login failed", "email", email, "ip", r.RemoteAddr, "reason", err.Error())
		middleware.WriteError(w, http.StatusUnauthorized, err.Error(), "INVALID_CREDENTIALS")
		return
	}
	if user == nil {
		slog.Warn("login failed: bad credentials", "email", email, "ip", r.RemoteAddr)
		middleware.WriteError(w, http.StatusUnauthorized, "invalid email or password", "INVALID_CREDENTIALS")
		return
	}

	token, err := h.sessionSvc.Create(r.Context(), user.ID, r)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, "failed to create session", "SESSION_ERROR")
		return
	}

	slog.Info("login success", "userId", user.ID.Hex(), "email", email, "ip", r.RemoteAddr)
	middleware.WriteJSON(w, http.StatusOK, map[string]any{
		"token":             token,
		"user":              user,
		"requirePasswordChange": user.IsDefaultPassword,
	})
}

// Logout revokes the current session token.
func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	token := extractBearerToken(r)
	if token != "" {
		h.sessionSvc.Revoke(r.Context(), token)
	}
	w.WriteHeader(http.StatusNoContent)
}

// ChangePassword handles the mandatory first-login password change.
func (h *AuthHandler) ChangePassword(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetCurrentUser(r)
	if user == nil {
		middleware.WriteError(w, http.StatusUnauthorized, "not authenticated", "UNAUTHORIZED")
		return
	}
	var req struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "INVALID_BODY")
		return
	}
	if len(req.NewPassword) < 8 {
		middleware.WriteError(w, http.StatusBadRequest, "new password must be at least 8 characters", "WEAK_PASSWORD")
		return
	}
	if err := h.userSvc.ChangePassword(r.Context(), user.ID, req.CurrentPassword, req.NewPassword); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "CHANGE_PASSWORD_FAILED")
		return
	}
	// Revoke all other sessions on password change (security best practice)
	h.sessionSvc.RevokeAllForUser(r.Context(), user.ID)
	// Issue a fresh session for the current user
	token, err := h.sessionSvc.Create(r.Context(), user.ID, r)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, "failed to create session", "SESSION_ERROR")
		return
	}
	updated, _ := h.userSvc.GetByID(r.Context(), user.ID)
	middleware.WriteJSON(w, http.StatusOK, map[string]any{
		"token": token,
		"user":  updated,
	})
}

// GitHubLogin initiates the GitHub OAuth flow by redirecting to GitHub.
func (h *AuthHandler) GitHubLogin(w http.ResponseWriter, r *http.Request) {
	if h.githubClientID == "" {
		middleware.WriteError(w, http.StatusNotFound, "GitHub OAuth not configured", "GITHUB_DISABLED")
		return
	}
	state := generateState()
	h.stateMu.Lock()
	h.stateStore[state] = oauthState{ExpiresAt: time.Now().Add(10 * time.Minute)}
	h.stateMu.Unlock()

	authURL := fmt.Sprintf(
		"https://github.com/login/oauth/authorize?client_id=%s&scope=read:user,user:email&state=%s",
		url.QueryEscape(h.githubClientID), url.QueryEscape(state),
	)
	http.Redirect(w, r, authURL, http.StatusFound)
}

// GitHubLink initiates a GitHub OAuth flow to link a GitHub account to the current authenticated user.
func (h *AuthHandler) GitHubLink(w http.ResponseWriter, r *http.Request) {
	if h.githubClientID == "" {
		middleware.WriteError(w, http.StatusNotFound, "GitHub OAuth not configured", "GITHUB_DISABLED")
		return
	}
	user := middleware.GetCurrentUser(r)
	if user == nil {
		middleware.WriteError(w, http.StatusUnauthorized, "authentication required", "UNAUTHORIZED")
		return
	}
	state := generateState()
	h.stateMu.Lock()
	h.stateStore[state] = oauthState{ExpiresAt: time.Now().Add(10 * time.Minute), LinkUserID: user.ID.Hex()}
	h.stateMu.Unlock()

	authURL := fmt.Sprintf(
		"https://github.com/login/oauth/authorize?client_id=%s&scope=read:user,user:email&state=%s",
		url.QueryEscape(h.githubClientID), url.QueryEscape(state),
	)
	http.Redirect(w, r, authURL, http.StatusFound)
}

// GitHubCallback handles the OAuth callback from GitHub, creates/links the user, and redirects
// to the frontend with a session token in the URL fragment.
func (h *AuthHandler) GitHubCallback(w http.ResponseWriter, r *http.Request) {
	if h.githubClientID == "" {
		middleware.WriteError(w, http.StatusNotFound, "GitHub OAuth not configured", "GITHUB_DISABLED")
		return
	}

	state := r.URL.Query().Get("state")
	code := r.URL.Query().Get("code")
	if state == "" || code == "" {
		http.Redirect(w, r, h.frontendCallbackURL("", "missing OAuth parameters"), http.StatusFound)
		return
	}

	// Validate state
	h.stateMu.Lock()
	ostate, ok := h.stateStore[state]
	if ok {
		delete(h.stateStore, state)
	}
	h.stateMu.Unlock()
	if !ok || time.Now().After(ostate.ExpiresAt) {
		http.Redirect(w, r, h.frontendCallbackURL("", "invalid or expired OAuth state"), http.StatusFound)
		return
	}

	// Exchange code for access token
	ghToken, err := h.exchangeCode(code)
	if err != nil {
		slog.Error("github oauth: code exchange failed", "error", err)
		http.Redirect(w, r, h.frontendCallbackURL("", "GitHub authentication failed"), http.StatusFound)
		return
	}

	// Fetch GitHub user profile
	ghUser, err := h.fetchGitHubUser(ghToken)
	if err != nil {
		slog.Error("github oauth: profile fetch failed", "error", err)
		http.Redirect(w, r, h.frontendCallbackURL("", "failed to fetch GitHub profile"), http.StatusFound)
		return
	}

	ctx := r.Context()

	// === LINK MODE: attach GitHub to an existing authenticated user ===
	if ostate.LinkUserID != "" {
		linkUser, err := h.userSvc.GetByIDHex(ctx, ostate.LinkUserID)
		if err != nil || linkUser == nil {
			http.Redirect(w, r, h.frontendCallbackURL("", "user not found for linking"), http.StatusFound)
			return
		}
		if err := h.userSvc.LinkGitHub(ctx, linkUser.ID, ghUser.ID, ghUser.Login); err != nil {
			slog.Error("github oauth: link to existing user failed", "error", err)
			http.Redirect(w, r, h.frontendCallbackURL("", "failed to link GitHub account"), http.StatusFound)
			return
		}
		slog.Info("github oauth: linked GitHub to existing user", "githubLogin", ghUser.Login, "userId", linkUser.ID.Hex())
		// Redirect to profile page to show success
		base := h.frontendURL
		if base == "" {
			base = "http://localhost:4370"
		}
		http.Redirect(w, r, base+"/profile?linked=github", http.StatusFound)
		return
	}

	// === NORMAL LOGIN MODE ===

	// Look up by GitHub ID
	user, err := h.userSvc.GetByGitHubID(ctx, ghUser.ID)
	if err != nil {
		http.Redirect(w, r, h.frontendCallbackURL("", "database error"), http.StatusFound)
		return
	}

	if user == nil {
		// Try to find a pre-created account matching this GitHub username
		user, err = h.userSvc.GetByGitHubUsername(ctx, ghUser.Login)
		if err != nil {
			http.Redirect(w, r, h.frontendCallbackURL("", "database error"), http.StatusFound)
			return
		}
		if user != nil {
			// Link the GitHub ID to this pre-created account (first login)
			if err := h.userSvc.LinkGitHub(ctx, user.ID, ghUser.ID, ghUser.Login); err != nil {
				slog.Error("github oauth: link failed", "error", err)
			}
			slog.Info("github oauth: first login — linked pre-authorized user", "githubLogin", ghUser.Login, "userId", user.ID.Hex())
		}
	}

	if user == nil {
		// Not found and not pre-authorized — access denied
		slog.Warn("github oauth: access denied — not pre-authorized", "githubLogin", ghUser.Login, "ip", r.RemoteAddr)
		http.Redirect(w, r, h.frontendCallbackURL("", "Your GitHub account (@"+ghUser.Login+") has not been added to this VibeCtl instance. Ask your admin to create an account for you."), http.StatusFound)
		return
	}

	if user.Disabled {
		slog.Warn("github oauth: access denied — account disabled", "githubLogin", ghUser.Login, "userId", user.ID.Hex())
		http.Redirect(w, r, h.frontendCallbackURL("", "Your account has been disabled"), http.StatusFound)
		return
	}

	h.userSvc.UpdateLastLogin(ctx, user.ID)

	token, err := h.sessionSvc.Create(ctx, user.ID, r)
	if err != nil {
		http.Redirect(w, r, h.frontendCallbackURL("", "failed to create session"), http.StatusFound)
		return
	}

	slog.Info("github oauth: login success", "githubLogin", ghUser.Login, "userId", user.ID.Hex(), "ip", r.RemoteAddr)
	http.Redirect(w, r, h.frontendCallbackURL(token, ""), http.StatusFound)
}

func (h *AuthHandler) frontendCallbackURL(token, errMsg string) string {
	base := h.frontendURL
	if base == "" {
		base = "http://localhost:4370"
	}
	if errMsg != "" {
		return base + "/auth/callback?error=" + url.QueryEscape(errMsg)
	}
	return base + "/auth/callback?token=" + url.QueryEscape(token)
}

func (h *AuthHandler) exchangeCode(code string) (string, error) {
	data := url.Values{
		"client_id":     {h.githubClientID},
		"client_secret": {h.githubSecret},
		"code":          {code},
	}
	req, _ := http.NewRequest("POST", "https://github.com/login/oauth/access_token", strings.NewReader(data.Encode()))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var result struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return "", err
	}
	if result.Error != "" {
		return "", fmt.Errorf("github error: %s", result.Error)
	}
	return result.AccessToken, nil
}

type githubUser struct {
	ID    string `json:"id"`
	Login string `json:"login"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

func (gh *githubUser) UnmarshalJSON(data []byte) error {
	// GitHub ID comes back as a number; we store it as a string.
	var raw struct {
		ID    int64  `json:"id"`
		Login string `json:"login"`
		Name  string `json:"name"`
		Email string `json:"email"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	gh.ID = fmt.Sprintf("%d", raw.ID)
	gh.Login = raw.Login
	gh.Name = raw.Name
	gh.Email = raw.Email
	return nil
}

func (h *AuthHandler) fetchGitHubUser(token string) (*githubUser, error) {
	req, _ := http.NewRequest("GET", "https://api.github.com/user", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github.v3+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var u githubUser
	if err := json.NewDecoder(resp.Body).Decode(&u); err != nil {
		return nil, err
	}
	return &u, nil
}

func generateState() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func extractBearerToken(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimPrefix(auth, "Bearer ")
	}
	return r.Header.Get("X-Vibectl-Token")
}

func checkLoginRateLimit(r *http.Request) bool {
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	if ip == "" {
		ip = r.RemoteAddr
	}
	loginMu.Lock()
	defer loginMu.Unlock()
	now := time.Now()
	attempt, ok := loginAttempts[ip]
	if !ok || now.After(attempt.windowEnd) {
		loginAttempts[ip] = &loginAttempt{count: 1, windowEnd: now.Add(loginWindow)}
		return true
	}
	attempt.count++
	return attempt.count <= loginMaxAttempts
}
