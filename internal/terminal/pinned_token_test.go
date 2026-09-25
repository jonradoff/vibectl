package terminal

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// isolate points HOME at an empty dir (no stored token file) and USER at an
// account with no keychain entry, so tests never see real credentials.
func isolate(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USER", "vibectl-test-no-such-user")
	return home
}

func TestResolveSpawnToken_ProjectPinWins(t *testing.T) {
	isolate(t)
	m := NewChatManager(nil, nil)
	m.SetProjectToken("P", "sk-ant-oat01-pinned")

	tok, src, pin := m.resolveSpawnToken("P")
	if tok != "sk-ant-oat01-pinned" || src != AuthSourceProject || pin.Origin != "paste" {
		t.Fatalf("got tok=%q src=%q origin=%q", tok, src, pin.Origin)
	}
	if tok, src, _ := m.resolveSpawnToken("OTHER"); tok != "" || src != AuthSourceNative {
		t.Fatalf("other project should be native, got tok=%q src=%q", tok, src)
	}
}

func TestResolveSpawnToken_DropsPinPastKnownExpiry(t *testing.T) {
	isolate(t)
	m := NewChatManager(nil, nil)
	m.SetProjectTokenWithExpiry("P", "sk-ant-oat01-old", "login", time.Now().Add(-time.Minute))

	tok, src, _ := m.resolveSpawnToken("P")
	if tok != "" || src != AuthSourceNative {
		t.Fatalf("expired pin should fall back to native, got tok=%q src=%q", tok, src)
	}
	if m.GetProjectToken("P") != "" {
		t.Fatal("expired pin should have been removed")
	}
}

func TestResolveSpawnToken_ClearWithEmptyToken(t *testing.T) {
	isolate(t)
	m := NewChatManager(nil, nil)
	m.SetProjectToken("P", "sk-ant-oat01-x")
	m.SetProjectToken("P", "")
	if tok, src, _ := m.resolveSpawnToken("P"); tok != "" || src != AuthSourceNative {
		t.Fatalf("cleared pin should be native, got tok=%q src=%q", tok, src)
	}
}

func TestHandlePinnedAuthFailure_BlacklistsPinAndStoredToken(t *testing.T) {
	home := isolate(t)
	m := NewChatManager(nil, nil)
	m.SetProjectToken("P", "sk-ant-oat01-dead")

	sess := &ChatSession{ProjectCode: "P", AuthSource: AuthSourceProject, authToken: "sk-ant-oat01-dead"}
	if !m.handlePinnedAuthFailure(sess, "401 OAuth access token has expired") {
		t.Fatal("expected first failure to be handled")
	}
	if m.handlePinnedAuthFailure(sess, "again") {
		t.Fatal("second failure on the same spawn must be a no-op")
	}
	if !sess.AuthFailed() {
		t.Fatal("session should be marked auth-failed")
	}
	if m.GetProjectToken("P") != "" {
		t.Fatal("pin should be cleared")
	}

	// The same dead token in the global stored file must be skipped too.
	if err := os.MkdirAll(filepath.Join(home, ".vibectl"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".vibectl", ".claude-oauth-token"), []byte("sk-ant-oat01-dead\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if tok, src, _ := m.resolveSpawnToken("P"); tok != "" || src != AuthSourceNative {
		t.Fatalf("blacklisted stored token should be skipped, got tok=%q src=%q", tok, src)
	}

	// Re-pinning the same token (user explicitly re-pastes) un-blacklists it.
	m.SetProjectToken("P", "sk-ant-oat01-dead")
	if tok, _, _ := m.resolveSpawnToken("P"); tok != "sk-ant-oat01-dead" {
		t.Fatalf("explicit re-pin should be honored, got %q", tok)
	}
}

func TestHandlePinnedAuthFailure_IgnoresNativeSessions(t *testing.T) {
	isolate(t)
	m := NewChatManager(nil, nil)
	sess := &ChatSession{ProjectCode: "P", AuthSource: AuthSourceNative}
	if m.handlePinnedAuthFailure(sess, "401 OAuth access token has expired") {
		t.Fatal("native sessions must keep the normal login UI path")
	}
}

func TestIsPinnedAuthFailure(t *testing.T) {
	yes := []string{
		`Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has expired. Re-authenticate to continue."}}`,
		"401 OAuth access token has expired. Re-authenticate to continue.",
		"Invalid authentication credentials",
	}
	no := []string{
		"issue with the selected model (claude-x)",
		"Credit balance is too low",
		"rate_limit_error: too many requests",
	}
	for _, s := range yes {
		if !isPinnedAuthFailure(s) {
			t.Errorf("expected auth failure: %q", s)
		}
	}
	for _, s := range no {
		if isPinnedAuthFailure(s) {
			t.Errorf("unexpected auth failure: %q", s)
		}
	}
}

// fakeClaude installs a `claude` script on PATH that records whether
// CLAUDE_CODE_OAUTH_TOKEN was injected, then emits the stream-json result
// Claude Code produces when its injected OAuth token has expired.
func fakeClaude(t *testing.T) (envFile string) {
	t.Helper()
	bin := t.TempDir()
	envFile = filepath.Join(bin, "env.txt")
	script := `#!/bin/sh
printf '%s' "${CLAUDE_CODE_OAUTH_TOKEN:-<none>}" > "` + envFile + `"
sleep 0.3
echo '{"type":"result","is_error":true,"result":"Failed to authenticate. API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"OAuth access token has expired. Re-authenticate to continue.\"}}"}'
sleep 5
`
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	return envFile
}

// End-to-end through startProcess: a pinned token is injected, the expiry
// result triggers pinned_token_expired BEFORE the result event, and the next
// spawn for the project runs without the dead token.
func TestPinnedTokenExpiry_EndToEnd(t *testing.T) {
	isolate(t)
	envFile := fakeClaude(t)
	m := NewChatManager(nil, nil)
	m.SetProjectTokenWithExpiry("P", "sk-ant-oat01-dead", "login", time.Now().Add(time.Hour))

	sess, err := m.StartSession("P", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer sess.Close()
	if sess.AuthSource != AuthSourceProject || sess.AuthOrigin != "login" {
		t.Fatalf("spawn auth = %q/%q", sess.AuthSource, sess.AuthOrigin)
	}
	out, _ := sess.Subscribe()

	var order []string
	deadline := time.After(4 * time.Second)
	for len(order) < 2 {
		select {
		case b, ok := <-out:
			if !ok {
				t.Fatalf("stream closed early; saw %v", order)
			}
			var evt struct{ Type string }
			_ = json.Unmarshal(b, &evt)
			order = append(order, evt.Type)
		case <-deadline:
			t.Fatalf("timed out; saw %v", order)
		}
	}
	if order[0] != "pinned_token_expired" || order[1] != "result" {
		t.Fatalf("event order = %v, want [pinned_token_expired result]", order)
	}
	if got, _ := os.ReadFile(envFile); string(got) != "sk-ant-oat01-dead" {
		t.Fatalf("first spawn env token = %q", got)
	}
	if !sess.AuthFailed() {
		t.Fatal("session should be flagged auth-failed so launch won't reconnect to it")
	}

	// Respawn (what set_project_token "" / launch-zombie-teardown do).
	sess.Close()
	m.RemoveSession("P")
	sess2, err := m.StartSession("P", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer sess2.Close()
	time.Sleep(200 * time.Millisecond)
	if got, _ := os.ReadFile(envFile); string(got) != "<none>" {
		t.Fatalf("respawn should use native auth, env token = %q", got)
	}
	if sess2.AuthSource != AuthSourceNative {
		t.Fatalf("respawn auth source = %q", sess2.AuthSource)
	}
}
