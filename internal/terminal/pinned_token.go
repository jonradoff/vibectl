package terminal

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"
)

// Auth sources for a spawned Claude Code process. A "pinned" source means
// vibectl injected CLAUDE_CODE_OAUTH_TOKEN, which Claude Code can NOT
// refresh — once that access token expires every turn 401s. "native" means
// Claude Code manages its own keychain credential and refreshes it itself.
const (
	AuthSourceNative  = "native"  // no env token — Claude Code's own keychain/credentials
	AuthSourceProject = "project" // per-project token from /login or the paste modal
	AuthSourceStored  = "stored"  // global token file (~/.vibectl/.claude-oauth-token or /data)
)

// pinnedToken is a per-project Claude OAuth token set via /login (PKCE) or
// the paste modal. ExpiresAt is zero when unknown (pasted tokens).
type pinnedToken struct {
	Token     string
	Origin    string // "login" (PKCE exchange) or "paste"
	SetAt     time.Time
	ExpiresAt time.Time
}

// AuthInfo describes which credential a project's Claude Code process runs
// on. Sent to the frontend as an `auth_info` event so a pinned login is
// visible in the chat header instead of silently overriding native auth.
type AuthInfo struct {
	Source    string     `json:"source"`
	Origin    string     `json:"origin,omitempty"`
	ExpiresAt *time.Time `json:"expiresAt,omitempty"`
	// NativeAvailable is true when Claude Code has its own credential to fall
	// back to (keychain / ~/.claude/.credentials.json).
	NativeAvailable bool `json:"nativeAvailable"`
}

func tokenFingerprint(token string) string {
	h := sha256.Sum256([]byte(token))
	return fmt.Sprintf("%x", h[:8])
}

// SetProjectToken pins a token of unknown lifetime (paste modal). An empty
// token clears the pin so the next spawn falls back to native auth.
func (m *ChatManager) SetProjectToken(projectID, token string) {
	m.SetProjectTokenWithExpiry(projectID, token, "paste", time.Time{})
}

// SetProjectTokenWithExpiry pins a per-project token with a known expiry
// (PKCE exchange returns expires_in). Zero expiresAt means unknown.
func (m *ChatManager) SetProjectTokenWithExpiry(projectID, token, origin string, expiresAt time.Time) {
	m.tokMu.Lock()
	defer m.tokMu.Unlock()
	if token == "" {
		if _, had := m.projectTokens[projectID]; had {
			slog.Info("per-project Claude token cleared", "projectID", projectID)
		}
		delete(m.projectTokens, projectID)
		return
	}
	m.projectTokens[projectID] = pinnedToken{Token: token, Origin: origin, SetAt: time.Now(), ExpiresAt: expiresAt}
	delete(m.expiredTokens, tokenFingerprint(token))
	slog.Info("per-project Claude token set", "projectID", projectID, "origin", origin,
		"fingerprint", tokenFingerprint(token), "expiresAt", expiresAt)
}

// GetProjectToken returns the per-project token, if set.
func (m *ChatManager) GetProjectToken(projectID string) string {
	m.tokMu.Lock()
	defer m.tokMu.Unlock()
	return m.projectTokens[projectID].Token
}

// resolveSpawnToken picks the credential for a new spawn: a live per-project
// pin, then the global stored token file, then native auth (""). Pins that
// are past their known expiry, or that already failed with an auth error,
// are skipped so a restart/reset never respawns onto a dead token.
// Uses tokMu only — safe to call from startProcess while m.mu is held.
func (m *ChatManager) resolveSpawnToken(projectID string) (token, source string, pin pinnedToken) {
	m.tokMu.Lock()
	defer m.tokMu.Unlock()
	if p, ok := m.projectTokens[projectID]; ok {
		switch {
		case !p.ExpiresAt.IsZero() && time.Now().After(p.ExpiresAt):
			slog.Warn("dropping expired per-project Claude token; using native auth",
				"projectID", projectID, "origin", p.Origin, "expiredAt", p.ExpiresAt)
			delete(m.projectTokens, projectID)
		case m.expiredTokens[tokenFingerprint(p.Token)]:
			slog.Warn("dropping per-project Claude token that failed auth; using native auth",
				"projectID", projectID, "origin", p.Origin)
			delete(m.projectTokens, projectID)
		default:
			return p.Token, AuthSourceProject, p
		}
	}
	if t := getStoredClaudeToken(); t != "" {
		if !m.expiredTokens[tokenFingerprint(t)] {
			return t, AuthSourceStored, pinnedToken{}
		}
		slog.Warn("skipping stored Claude token file that failed auth; using native auth", "projectID", projectID)
	}
	return "", AuthSourceNative, pinnedToken{}
}

// AuthInfoFor reports the credential the project's live session runs on,
// or what the next spawn would use if there is no live session.
func (m *ChatManager) AuthInfoFor(projectID string) AuthInfo {
	info := AuthInfo{NativeAvailable: readClaudeTokenFromKeychain() != ""}
	if sess := m.GetSession(projectID); sess != nil && sess.IsAlive() {
		info.Source, info.Origin = sess.AuthSource, sess.AuthOrigin
		if !sess.AuthExpiresAt.IsZero() {
			t := sess.AuthExpiresAt
			info.ExpiresAt = &t
		}
		return info
	}
	m.tokMu.Lock()
	p, ok := m.projectTokens[projectID]
	m.tokMu.Unlock()
	switch {
	case ok:
		info.Source, info.Origin = AuthSourceProject, p.Origin
		if !p.ExpiresAt.IsZero() {
			t := p.ExpiresAt
			info.ExpiresAt = &t
		}
	case getStoredClaudeToken() != "":
		info.Source = AuthSourceStored
	default:
		info.Source = AuthSourceNative
	}
	return info
}

// isPinnedAuthFailure reports whether a Claude Code error message means the
// injected credential itself is dead (expired / revoked / invalid), as
// opposed to rate limits, credit exhaustion, or model errors.
func isPinnedAuthFailure(msg string) bool {
	l := strings.ToLower(msg)
	return strings.Contains(l, "oauth access token has expired") ||
		strings.Contains(l, "token has expired") ||
		strings.Contains(l, "authentication_error") ||
		strings.Contains(l, "invalid authentication credentials") ||
		strings.Contains(l, "oauth token has been revoked") ||
		strings.Contains(l, "failed to authenticate")
}

// handlePinnedAuthFailure runs when a session on a pinned credential reports
// an auth failure. It blacklists that token, clears the per-project pin, and
// broadcasts `pinned_token_expired` so the frontend can respawn (--resume)
// onto native auth. Returns false (and does nothing) for native sessions or
// if it already fired for this spawn — native auth failures keep the normal
// login UI.
func (m *ChatManager) handlePinnedAuthFailure(sess *ChatSession, message string) bool {
	if sess.AuthSource == AuthSourceNative || sess.authToken == "" {
		return false
	}
	sess.mu.Lock()
	if sess.authFailed {
		sess.mu.Unlock()
		return false
	}
	sess.authFailed = true
	sess.mu.Unlock()

	fp := tokenFingerprint(sess.authToken)
	m.tokMu.Lock()
	m.expiredTokens[fp] = true
	if p, ok := m.projectTokens[sess.ProjectCode]; ok && p.Token == sess.authToken {
		delete(m.projectTokens, sess.ProjectCode)
	}
	m.tokMu.Unlock()

	nativeAvailable := readClaudeTokenFromKeychain() != ""
	slog.Warn("pinned Claude token failed auth; cleared pin",
		"projectID", sess.ProjectCode, "source", sess.AuthSource, "origin", sess.AuthOrigin,
		"fingerprint", fp, "nativeAvailable", nativeAvailable)

	evt := map[string]interface{}{
		"type": "pinned_token_expired",
		"data": map[string]interface{}{
			"source":          sess.AuthSource,
			"origin":          sess.AuthOrigin,
			"nativeAvailable": nativeAvailable,
			"message":         message,
		},
	}
	if data, err := json.Marshal(evt); err == nil {
		sess.broadcast(data)
	}
	return true
}

// AuthFailed reports whether this spawn's pinned credential has failed auth.
// A live-but-dead session must not be reconnected to — respawn instead.
func (s *ChatSession) AuthFailed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.authFailed
}
