package handlers

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/services"
	"github.com/jonradoff/vibectl/internal/terminal"
)

// AdminHandler handles administrative operations: rebuild/restart and legacy set-password (CLI compat).
type AdminHandler struct {
	sourceDir    string
	onBeforeExec func()
	adminService *services.AdminService
}

func NewAdminHandler(sourceDir string, onBeforeExec func(), adminService *services.AdminService) *AdminHandler {
	return &AdminHandler{
		sourceDir:    sourceDir,
		onBeforeExec: onBeforeExec,
		adminService: adminService,
	}
}

// Rebuild handles POST /api/v1/admin/rebuild.
func (h *AdminHandler) Rebuild(w http.ResponseWriter, r *http.Request) {
	slog.Info("rebuild requested")
	terminal.GetGlobalBroadcast().Send("server_restarting")
	time.Sleep(200 * time.Millisecond)

	slog.Info("rebuilding server binary")
	buildCmd := exec.Command("go", "build", "-o", "vibectl-server", "./cmd/server/")
	buildCmd.Dir = h.sourceDir
	buildCmd.Env = os.Environ()
	buildCmd.Stdout = os.Stdout
	buildCmd.Stderr = os.Stderr

	if err := buildCmd.Run(); err != nil {
		slog.Error("rebuild failed", "error", err)
		middleware.WriteError(w, http.StatusInternalServerError,
			fmt.Sprintf("build failed: %v", err), "BUILD_ERROR")
		return
	}

	slog.Info("rebuild successful, restarting")
	middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "restarting"})

	go func() {
		time.Sleep(500 * time.Millisecond)
		if h.onBeforeExec != nil {
			h.onBeforeExec()
		}
		binary := h.sourceDir + "/vibectl-server"
		slog.Info("exec-ing new binary", "path", binary)
		if err := execSelf(binary); err != nil {
			slog.Error("failed to exec new binary, falling back to exit", "error", err)
			os.Exit(0)
		}
	}()
}

// ClaudeAuthStatus handles GET /api/v1/admin/claude-auth-status.
// Checks if Claude Code is authenticated — either via stored OAuth token or via `claude auth status`.
func (h *AdminHandler) ClaudeAuthStatus(w http.ResponseWriter, r *http.Request) {
	// First check our own stored token
	if token := GetClaudeOAuthToken(); token != "" {
		// Verify it works by running claude auth status with the token
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "claude", "auth", "status")
		cmd.Env = append(os.Environ(), "CLAUDE_CODE_OAUTH_TOKEN="+token)
		out, err := cmd.CombinedOutput()
		if err == nil {
			var status map[string]interface{}
			if json.Unmarshal(out, &status) == nil {
				if loggedIn, ok := status["loggedIn"].(bool); ok && loggedIn {
					middleware.WriteJSON(w, http.StatusOK, status)
					return
				}
			}
		}
		// Token might be expired — fall through to report not logged in
	}

	// Fall back to checking native claude auth
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "claude", "auth", "status")
	cmd.Env = os.Environ()
	out, err := cmd.CombinedOutput()
	if err != nil {
		middleware.WriteJSON(w, http.StatusOK, map[string]interface{}{
			"loggedIn": false,
			"error":    string(out),
		})
		return
	}
	var status map[string]interface{}
	if jsonErr := json.Unmarshal(out, &status); jsonErr == nil {
		middleware.WriteJSON(w, http.StatusOK, status)
		return
	}
	middleware.WriteJSON(w, http.StatusOK, map[string]interface{}{
		"loggedIn": true,
		"raw":      string(out),
	})
}

// SelfInfo handles GET /api/v1/admin/self-info.
func (h *AdminHandler) SelfInfo(w http.ResponseWriter, r *http.Request) {
	middleware.WriteJSON(w, http.StatusOK, map[string]string{
		"sourceDir": h.sourceDir,
	})
}

// claudeOAuthTokenPath returns the path for persisting the Claude OAuth token.
// Uses /data (Fly volume) when available, otherwise falls back to ~/.vibectl/.claude-oauth-token.
func claudeOAuthTokenPath() string {
	if _, err := os.Stat("/data"); err == nil {
		return "/data/.claude-oauth-token"
	}
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".vibectl")
	os.MkdirAll(dir, 0700)
	return filepath.Join(dir, ".claude-oauth-token")
}

// ClaudeLogin handles GET /api/v1/admin/claude-login.
// Returns PKCE OAuth parameters. Uses platform.claude.com for both authorize and token exchange
// (they are the same OAuth system; claude.ai's token endpoint is behind Cloudflare).
func (h *AdminHandler) ClaudeLogin(w http.ResponseWriter, r *http.Request) {
	// Generate PKCE code verifier + challenge
	verifierBytes := make([]byte, 32)
	if _, err := rand.Read(verifierBytes); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "PKCE_ERROR")
		return
	}
	codeVerifier := base64URLEncode(verifierBytes)
	codeChallenge := sha256Base64URL(codeVerifier)

	// Generate state nonce
	stateBytes := make([]byte, 32)
	rand.Read(stateBytes)
	state := base64URLEncode(stateBytes)

	// platform.claude.com/oauth/code/callback is the registered redirect URI for this client.
	// The authorize endpoint is on claude.ai (user-facing), but the token endpoint and
	// redirect are on platform.claude.com — they share OAuth state.
	clientID := "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
	redirectURI := "https://platform.claude.com/oauth/code/callback"
	scopes := "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"

	authURL := fmt.Sprintf(
		"https://claude.ai/oauth/authorize?code=true&client_id=%s&response_type=code&redirect_uri=%s&scope=%s&code_challenge=%s&code_challenge_method=S256&state=%s",
		clientID,
		url.QueryEscape(redirectURI),
		url.QueryEscape(scopes),
		codeChallenge,
		state,
	)

	middleware.WriteJSON(w, http.StatusOK, map[string]string{
		"authUrl":       authURL,
		"codeVerifier":  codeVerifier,
		"clientId":      clientID,
		"redirectUri":   redirectURI,
		"state":         state,
	})
}

// ClaudeLoginCode handles POST /api/v1/admin/claude-login-code.
// Exchanges the authorization code for an access token server-side,
// then stores it on the persistent volume.
func (h *AdminHandler) ClaudeLoginCode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Code         string `json:"code"`
		CodeVerifier string `json:"codeVerifier"`
		ClientId     string `json:"clientId"`
		RedirectUri  string `json:"redirectUri"`
		State        string `json:"state"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}
	if body.Code == "" || body.CodeVerifier == "" {
		middleware.WriteError(w, http.StatusBadRequest, "code and codeVerifier are required", "BAD_REQUEST")
		return
	}

	// Exchange the code at platform.claude.com/v1/oauth/token — same server as the redirect URI.
	// Claude Code uses application/json (not standard form encoding).
	payload := map[string]string{
		"grant_type":    "authorization_code",
		"code":          body.Code,
		"redirect_uri":  body.RedirectUri,
		"client_id":     body.ClientId,
		"code_verifier": body.CodeVerifier,
	}
	if body.State != "" {
		payload["state"] = body.State
	}
	jsonPayload, _ := json.Marshal(payload)

	tokenReq, _ := http.NewRequest("POST", "https://platform.claude.com/v1/oauth/token", strings.NewReader(string(jsonPayload)))
	tokenReq.Header.Set("Content-Type", "application/json")
	tokenReq.Header.Set("User-Agent", "claude-code/1.0.0")
	tokenReq.Header.Set("anthropic-client-name", "claude-code")
	tokenReq.Header.Set("anthropic-client-version", "1.0.0")
	tokenReq.Header.Set("Accept", "application/json")

	resp, err := http.DefaultClient.Do(tokenReq)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, "token exchange request failed: "+err.Error(), "TOKEN_EXCHANGE_FAILED")
		return
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		bodyStr := string(respBody[:min(500, len(respBody))])
		slog.Error("claude oauth token exchange failed",
			"status", resp.StatusCode,
			"body", bodyStr,
			"code_len", len(body.Code),
			"verifier_len", len(body.CodeVerifier),
			"redirect_uri", body.RedirectUri,
			"client_id", body.ClientId,
		)
		middleware.WriteError(w, http.StatusBadRequest, fmt.Sprintf("token exchange failed (%d): %s", resp.StatusCode, string(respBody[:min(200, len(respBody))])), "TOKEN_EXCHANGE_FAILED")
		return
	}

	var tokenResp struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
		ErrorDesc   string `json:"error_description"`
	}
	if err := json.Unmarshal(respBody, &tokenResp); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, "failed to parse token response", "TOKEN_PARSE_FAILED")
		return
	}
	if tokenResp.Error != "" {
		middleware.WriteError(w, http.StatusBadRequest, "OAuth error: "+tokenResp.ErrorDesc, "OAUTH_ERROR")
		return
	}
	if tokenResp.AccessToken == "" {
		middleware.WriteError(w, http.StatusInternalServerError, "no access_token in response", "NO_TOKEN")
		return
	}

	// Store the token
	if err := os.WriteFile(claudeOAuthTokenPath(), []byte(tokenResp.AccessToken), 0600); err != nil {
		slog.Error("failed to write claude oauth token", "error", err)
		middleware.WriteError(w, http.StatusInternalServerError, "failed to store token", "STORE_FAILED")
		return
	}

	slog.Info("claude oauth token stored successfully")
	middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// ClaudeTokenDirect handles POST /api/v1/admin/claude-token-direct.
// Stores a Claude OAuth token that was obtained externally (e.g. from claude auth status on a local machine).
func (h *AdminHandler) ClaudeTokenDirect(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}
	token := strings.TrimSpace(body.Token)
	if token == "" {
		middleware.WriteError(w, http.StatusBadRequest, "token is required", "BAD_REQUEST")
		return
	}

	// Basic format check: Claude OAuth tokens start with "sk-ant-oat" or similar prefix.
	// Authorization codes (from OAuth callback) are shorter random strings and won't work here.
	if !strings.HasPrefix(token, "sk-ant-") {
		middleware.WriteError(w, http.StatusBadRequest,
			"This looks like an authorization code, not an OAuth token. "+
				"Run 'claude auth status --json' and copy the oauthToken value (starts with sk-ant-oat01-...).",
			"INVALID_TOKEN_FORMAT")
		return
	}

	// Verify the token actually works
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "claude", "auth", "status")
	cmd.Env = append(os.Environ(), "CLAUDE_CODE_OAUTH_TOKEN="+token)
	out, err := cmd.CombinedOutput()
	if err != nil {
		slog.Warn("claude auth status failed during token validation", "error", err, "output", string(out))
		middleware.WriteError(w, http.StatusBadRequest, "token validation failed — claude auth status returned an error", "INVALID_TOKEN")
		return
	}
	var status map[string]interface{}
	if jsonErr := json.Unmarshal(out, &status); jsonErr != nil {
		slog.Warn("claude auth status returned non-JSON", "output", string(out))
		middleware.WriteError(w, http.StatusBadRequest, "token validation failed — unexpected response from claude auth status", "INVALID_TOKEN")
		return
	}
	if loggedIn, ok := status["loggedIn"].(bool); ok && !loggedIn {
		middleware.WriteError(w, http.StatusBadRequest, "token is not valid — claude auth status reports not logged in", "INVALID_TOKEN")
		return
	}

	if err := os.WriteFile(claudeOAuthTokenPath(), []byte(token), 0600); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, "failed to store token", "STORE_FAILED")
		return
	}
	slog.Info("claude oauth token stored directly")
	middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// SetPassword handles POST /api/v1/admin/set-password (legacy CLI endpoint).
// This writes to the old admin collection so the CLI (`vibectl admin set-password`) continues to work.
func (h *AdminHandler) SetPassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}
	if len(body.NewPassword) < 8 {
		middleware.WriteError(w, http.StatusBadRequest, "newPassword must be at least 8 characters", "BAD_REQUEST")
		return
	}

	token, err := h.adminService.SetPassword(r.Context(), body.CurrentPassword, body.NewPassword)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "SET_PASSWORD_FAILED")
		return
	}

	slog.Info("admin password updated via legacy endpoint")
	middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok", "token": token})
}

// base64URLEncode encodes bytes to unpadded base64url.
func base64URLEncode(data []byte) string {
	return base64.RawURLEncoding.EncodeToString(data)
}

// sha256Base64URL computes SHA-256 of a string and returns base64url-encoded hash.
func sha256Base64URL(s string) string {
	h := sha256.Sum256([]byte(s))
	return base64URLEncode(h[:])
}

// GetClaudeOAuthToken reads the stored OAuth token from the persistent volume.
// Returns empty string if no token is stored.
func GetClaudeOAuthToken() string {
	data, err := os.ReadFile(claudeOAuthTokenPath())
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// MCPServerInfo represents a configured MCP server for display purposes.
type MCPServerInfo struct {
	Name      string `json:"name"`
	Type      string `json:"type"`                // "stdio", "http", "sse"
	Command   string `json:"command,omitempty"`    // for stdio
	URL       string `json:"url,omitempty"`        // for http/sse
	Source    string `json:"source"`               // "user", "project", "project-file"
	ArgsCount int    `json:"argsCount,omitempty"`
}

// ListMCPServers handles GET /api/v1/admin/mcp-servers?projectPath=...
func (h *AdminHandler) ListMCPServers(w http.ResponseWriter, r *http.Request) {
	projectPath := r.URL.Query().Get("projectPath")
	var servers []MCPServerInfo

	// 1. Read user-scope servers from ~/.claude.json
	home, _ := os.UserHomeDir()
	claudeJSON := filepath.Join(home, ".claude.json")
	if data, err := os.ReadFile(claudeJSON); err == nil {
		var cfg struct {
			MCPServers map[string]json.RawMessage `json:"mcpServers"`
			Projects   map[string]struct {
				MCPServers map[string]json.RawMessage `json:"mcpServers"`
			} `json:"projects"`
		}
		if json.Unmarshal(data, &cfg) == nil {
			// User-scope servers
			for name, raw := range cfg.MCPServers {
				servers = append(servers, parseMCPEntry(name, raw, "user"))
			}
			// Project-specific servers from ~/.claude.json projects section
			if projectPath != "" {
				if proj, ok := cfg.Projects[projectPath]; ok {
					for name, raw := range proj.MCPServers {
						servers = append(servers, parseMCPEntry(name, raw, "project"))
					}
				}
			}
		}
	}

	// 2. Read project-scope .mcp.json
	if projectPath != "" {
		mcpJSON := filepath.Join(projectPath, ".mcp.json")
		if data, err := os.ReadFile(mcpJSON); err == nil {
			var cfg struct {
				MCPServers map[string]json.RawMessage `json:"mcpServers"`
			}
			if json.Unmarshal(data, &cfg) == nil {
				for name, raw := range cfg.MCPServers {
					servers = append(servers, parseMCPEntry(name, raw, "project-file"))
				}
			}
		}
	}

	if servers == nil {
		servers = []MCPServerInfo{}
	}

	middleware.WriteJSON(w, http.StatusOK, map[string]interface{}{
		"servers": servers,
	})
}

// SubscriptionUsage represents the Claude subscription usage response.
type SubscriptionUsage struct {
	FiveHour      *UsageBucket `json:"fiveHour"`
	SevenDay      *UsageBucket `json:"sevenDay"`
	SevenDaySonnet *UsageBucket `json:"sevenDaySonnet,omitempty"`
	SevenDayOpus  *UsageBucket `json:"sevenDayOpus,omitempty"`
	ExtraUsage    *ExtraUsage  `json:"extraUsage,omitempty"`
	SubscriptionType string    `json:"subscriptionType"`
}

type UsageBucket struct {
	Utilization float64 `json:"utilization"`
	ResetsAt    string  `json:"resetsAt"`
}

type ExtraUsage struct {
	IsEnabled    bool     `json:"isEnabled"`
	MonthlyLimit *float64 `json:"monthlyLimit"`
	UsedCredits  float64  `json:"usedCredits"`
}

// GetSubscriptionUsage handles GET /api/v1/admin/subscription-usage.
// Fetches the current Claude subscription usage from the OAuth API.
func (h *AdminHandler) GetSubscriptionUsage(w http.ResponseWriter, r *http.Request) {
	// Get OAuth token — try stored file first, then keychain
	token := GetClaudeOAuthToken()
	if token == "" {
		token = terminal.ReadClaudeTokenFromKeychain()
	}
	if token == "" {
		middleware.WriteError(w, http.StatusServiceUnavailable, "no Claude OAuth token available", "NO_TOKEN")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "GET", "https://api.anthropic.com/api/oauth/usage", nil)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, "failed to create request", "REQUEST_ERROR")
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("anthropic-beta", "oauth-2025-04-20")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		middleware.WriteError(w, http.StatusBadGateway, "failed to reach Anthropic API", "FETCH_ERROR")
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == 429 {
		middleware.WriteError(w, http.StatusTooManyRequests, "rate limited by Anthropic API", "RATE_LIMITED")
		return
	}
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		middleware.WriteError(w, http.StatusBadGateway, fmt.Sprintf("Anthropic API error (%d): %s", resp.StatusCode, string(body[:min(200, len(body))]), ), "API_ERROR")
		return
	}

	var raw struct {
		FiveHour      *struct { Utilization float64 `json:"utilization"`; ResetsAt string `json:"resets_at"` } `json:"five_hour"`
		SevenDay      *struct { Utilization float64 `json:"utilization"`; ResetsAt string `json:"resets_at"` } `json:"seven_day"`
		SevenDaySonnet *struct { Utilization float64 `json:"utilization"`; ResetsAt string `json:"resets_at"` } `json:"seven_day_sonnet"`
		SevenDayOpus  *struct { Utilization float64 `json:"utilization"`; ResetsAt string `json:"resets_at"` } `json:"seven_day_opus"`
		ExtraUsage    *struct {
			IsEnabled    bool     `json:"is_enabled"`
			MonthlyLimit *float64 `json:"monthly_limit"`
			UsedCredits  float64  `json:"used_credits"`
		} `json:"extra_usage"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, "failed to parse usage response", "PARSE_ERROR")
		return
	}

	// Read subscription type from keychain credentials
	subType := "unknown"
	keychainToken := terminal.ReadClaudeTokenFromKeychain()
	if keychainToken != "" {
		// Re-read full keychain data to get subscription type
		if u, uErr := os.UserHomeDir(); uErr == nil {
			_ = u // subscription type is in keychain JSON, already parsed in terminal pkg
		}
	}
	// Parse keychain for subscription info
	if subInfo := readSubscriptionType(); subInfo != "" {
		subType = subInfo
	}

	result := SubscriptionUsage{
		SubscriptionType: subType,
	}
	if raw.FiveHour != nil {
		result.FiveHour = &UsageBucket{Utilization: raw.FiveHour.Utilization, ResetsAt: raw.FiveHour.ResetsAt}
	}
	if raw.SevenDay != nil {
		result.SevenDay = &UsageBucket{Utilization: raw.SevenDay.Utilization, ResetsAt: raw.SevenDay.ResetsAt}
	}
	if raw.SevenDaySonnet != nil {
		result.SevenDaySonnet = &UsageBucket{Utilization: raw.SevenDaySonnet.Utilization, ResetsAt: raw.SevenDaySonnet.ResetsAt}
	}
	if raw.SevenDayOpus != nil {
		result.SevenDayOpus = &UsageBucket{Utilization: raw.SevenDayOpus.Utilization, ResetsAt: raw.SevenDayOpus.ResetsAt}
	}
	if raw.ExtraUsage != nil {
		result.ExtraUsage = &ExtraUsage{
			IsEnabled:    raw.ExtraUsage.IsEnabled,
			MonthlyLimit: raw.ExtraUsage.MonthlyLimit,
			UsedCredits:  raw.ExtraUsage.UsedCredits,
		}
	}

	middleware.WriteJSON(w, http.StatusOK, result)
}

func readSubscriptionType() string {
	if out, err := exec.Command("security", "find-generic-password",
		"-s", "Claude Code-credentials",
		"-a", os.Getenv("USER"),
		"-w",
	).Output(); err == nil {
		var creds struct {
			ClaudeAiOauth struct {
				SubscriptionType string `json:"subscriptionType"`
			} `json:"claudeAiOauth"`
		}
		if json.Unmarshal(out, &creds) == nil {
			return creds.ClaudeAiOauth.SubscriptionType
		}
	}
	return ""
}

func parseMCPEntry(name string, raw json.RawMessage, source string) MCPServerInfo {
	var entry struct {
		Type    string   `json:"type"`
		Command string   `json:"command"`
		URL     string   `json:"url"`
		Args    []string `json:"args"`
	}
	json.Unmarshal(raw, &entry)

	info := MCPServerInfo{
		Name:   name,
		Type:   entry.Type,
		Source: source,
	}
	if info.Type == "" {
		if entry.Command != "" {
			info.Type = "stdio"
		} else if entry.URL != "" {
			info.Type = "http"
		}
	}
	if entry.Command != "" {
		// Show just the binary name, not the full path
		info.Command = filepath.Base(entry.Command)
	}
	if entry.URL != "" {
		info.URL = entry.URL
	}
	info.ArgsCount = len(entry.Args)
	return info
}
