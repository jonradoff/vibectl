package terminal

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jonradoff/vibectl/internal/models"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// ChatSessionPersister is the persistence interface for active chat session state.
type ChatSessionPersister interface {
	Upsert(ctx context.Context, projectID, claudeSessionID, localPath string, messages []json.RawMessage) error
	MarkResumable(ctx context.Context, projectID string) error
	MarkDead(ctx context.Context, projectID string) error
	ClearSession(ctx context.Context, projectID string) error
	GetResumable(ctx context.Context, projectID string) (*models.ChatSessionState, error)
	// GetLastSessionID returns the claudeSessionId on the chat_sessions doc
	// regardless of status. Used to attempt on-disk fallback recovery for
	// sessions that have been marked dead (the JSONL may still exist under
	// an old/moved directory encoding).
	GetLastSessionID(ctx context.Context, projectID string) (string, error)
}

// ChatHistoryArchiver is the persistence interface for completed chat session history.
type ChatHistoryArchiver interface {
	Archive(ctx context.Context, projectID, claudeSessionID string, messages []json.RawMessage, startedAt time.Time, userID *bson.ObjectID, userName string) error
	// RecentSessionIDs returns the last `limit` claudeSessionIds this project
	// ever had, newest first. Used to recover an on-disk transcript when the
	// active chat_sessions record is dead/missing but Claude Code's on-disk
	// history still exists (possibly under a moved/renamed encoded dir).
	RecentSessionIDs(ctx context.Context, projectID string, limit int) ([]string, error)
}

// ChatSession represents a claude code process running in stream-json mode.
type ChatSession struct {
	ID          string
	ProjectCode string
	LocalPath   string
	SessionID   string         // Claude session ID from init event
	TokenHash   string         // SHA256 of OAuth token used — stable identity per login
	UserID      *bson.ObjectID // vibectl user who owns this session (nil in standalone)
	UserName    string
	StartedAt   time.Time
	Cmd         *exec.Cmd
	stdin       io.WriteCloser
	exited      chan struct{}
	subscribers []*subscriber
	messages    []json.RawMessage // buffered events for reconnection
	dirty       bool              // true if messages changed since last persist
	mu          sync.Mutex
	lastModel            string   // model from most recent message_start (for usage tracking)
	pendingContextUpdate string   // queued VIBECTL.md update to prepend to next user message
	stderrMu             sync.Mutex
	stderrBuf            []string // recent stderr lines, capped at 50
	proxy                *recordingProxy // optional cache-optimizer trace recorder

	// committed is true once Claude Code has emitted at least one assistant
	// message, meaning its on-disk conversation log for this session ID exists.
	// Until then, the session ID is in memory only — persisting it to Mongo
	// would create an orphan that future --resume calls can't recover from.
	committed bool

	// sessionLost is true if the orphan-recovery path fired for this spawn.
	// Suppresses the redundant system_error broadcast on process exit.
	sessionLost bool

	// lastActivity is the wall-clock time of the most recent stdin write OR
	// stdout event. The idle reaper uses it to decide when a session's Claude
	// Code subprocess is safe to SIGTERM to free memory (each subprocess is
	// 300-500 MB of resident RAM). Guarded by mu.
	lastActivity time.Time

	// reapedForIdle is set to true by the reaper before it signals the
	// process, so the exit goroutine can suppress the misleading
	// "Claude exited with error" broadcast and instead emit a typed event
	// telling the frontend a fresh spawn will occur on the next user message.
	reapedForIdle bool
}

// TouchActivity marks the session as active NOW. Called whenever the user
// sends stdin OR whenever claude emits stdout — either counts as "the user is
// interacting with this project."
func (s *ChatSession) TouchActivity() {
	s.mu.Lock()
	s.lastActivity = time.Now()
	s.mu.Unlock()
}

// IdleFor returns how long the session has been quiet.
func (s *ChatSession) IdleFor() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.lastActivity.IsZero() {
		return 0
	}
	return time.Since(s.lastActivity)
}

// SubscriberCount returns how many WebSocket clients are currently attached.
// Used by the reaper to skip sessions with an active viewer.
func (s *ChatSession) SubscriberCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Prune closed subscribers on the way through so the count is accurate.
	alive := s.subscribers[:0]
	for _, sub := range s.subscribers {
		select {
		case <-sub.done:
			// closed
		default:
			alive = append(alive, sub)
		}
	}
	s.subscribers = alive
	return len(alive)
}

// ReapedForIdle returns true if the reaper is / has terminated this session.
func (s *ChatSession) ReapedForIdle() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reapedForIdle
}

// UsageRecorderFunc is a callback invoked when Claude Code reports token usage.
type UsageRecorderFunc func(tokenHash, projectID, sessionID, model string, inputTokens, outputTokens, cacheRead, cacheCreation int64)

// QueueContextUpdate stores a VIBECTL.md update to be prepended to the next user message.
func (s *ChatSession) QueueContextUpdate(content string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pendingContextUpdate = content
}

// SendMessage writes a user message to claude's stdin in stream-json format.
// If a pending context update is queued, it's prepended to the message.
func (s *ChatSession) SendMessage(text string) error {
	// Fail fast if the process has already exited — writing to a dead pipe
	// produces "write |1: file already closed" which is meaningless to the
	// user. The frontend will see SESSION_ENDED and offer to reset.
	select {
	case <-s.exited:
		return fmt.Errorf("SESSION_ENDED: Claude Code is no longer running. Reset the session to start a fresh one.")
	default:
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.stdin == nil {
		return fmt.Errorf("SESSION_ENDED: stdin closed. Reset the session to start a fresh one.")
	}

	// Prepend pending context update if available
	if s.pendingContextUpdate != "" {
		text = fmt.Sprintf("[CONTEXT UPDATE] Project status refreshed:\n\n<vibectl_md>\n%s\n</vibectl_md>\n\nThis is an automated context update, not a user instruction. Continue with whatever you were doing.\n\n---\n\n%s", s.pendingContextUpdate, text)
		s.pendingContextUpdate = ""
		slog.Info("injected context update into user message", "projectID", s.ProjectCode)
	}

	msg := map[string]interface{}{
		"type": "user",
		"message": map[string]interface{}{
			"role": "user",
			"content": []map[string]string{
				{"type": "text", "text": text},
			},
		},
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("marshal message: %w", err)
	}

	data = append(data, '\n')
	if _, err := s.stdin.Write(data); err != nil {
		return fmt.Errorf("write to stdin: %w", err)
	}
	s.lastActivity = time.Now()

	return nil
}

// SendToolResult writes a user-role message with a single tool_result content
// block to claude's stdin. Used by the frontend to complete client-side tool
// calls (currently AskUserQuestion) so the assistant can continue instead of
// waiting on a tool result that never arrives.
//
// content is opaque to us — Claude expects either a string or an array of
// content blocks. Pass whatever the tool spec calls for; the AskUserQuestion
// answer, for example, is a JSON string of the answers map.
func (s *ChatSession) SendToolResult(toolUseID, content string, isError bool) error {
	select {
	case <-s.exited:
		return fmt.Errorf("SESSION_ENDED: Claude Code is no longer running")
	default:
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.stdin == nil {
		return fmt.Errorf("SESSION_ENDED: stdin closed")
	}

	block := map[string]interface{}{
		"type":         "tool_result",
		"tool_use_id":  toolUseID,
		"content":      content,
	}
	if isError {
		block["is_error"] = true
	}
	msg := map[string]interface{}{
		"type": "user",
		"message": map[string]interface{}{
			"role":    "user",
			"content": []interface{}{block},
		},
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("marshal tool result: %w", err)
	}
	data = append(data, '\n')
	if _, err := s.stdin.Write(data); err != nil {
		return fmt.Errorf("write to stdin: %w", err)
	}
	s.lastActivity = time.Now()
	return nil
}

// SendControlResponse writes a control_response to claude's stdin (for permission approvals/denials).
func (s *ChatSession) SendControlResponse(requestID string, response json.RawMessage) error {
	select {
	case <-s.exited:
		return fmt.Errorf("SESSION_ENDED: Claude Code is no longer running")
	default:
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.stdin == nil {
		return fmt.Errorf("SESSION_ENDED: stdin closed")
	}

	msg := map[string]interface{}{
		"type":       "control_response",
		"request_id": requestID,
		"response":   response,
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("marshal control response: %w", err)
	}

	data = append(data, '\n')
	if _, err := s.stdin.Write(data); err != nil {
		return fmt.Errorf("write control response to stdin: %w", err)
	}

	return nil
}

// Subscribe registers a new output listener.
func (s *ChatSession) Subscribe() (<-chan []byte, chan struct{}) {
	sub := &subscriber{
		ch:   make(chan []byte, 256),
		done: make(chan struct{}),
	}

	s.mu.Lock()
	s.subscribers = append(s.subscribers, sub)
	s.mu.Unlock()

	return sub.ch, sub.done
}

// Exited returns a channel closed when the process exits.
func (s *ChatSession) Exited() <-chan struct{} {
	return s.exited
}

// Messages returns buffered events for reconnection replay.
func (s *ChatSession) Messages() []json.RawMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]json.RawMessage, len(s.messages))
	copy(out, s.messages)
	return out
}

func (s *ChatSession) broadcast(data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()

	alive := s.subscribers[:0]
	for _, sub := range s.subscribers {
		select {
		case <-sub.done:
			close(sub.ch)
			continue
		default:
		}

		select {
		case sub.ch <- data:
		default:
		}
		alive = append(alive, sub)
	}
	s.subscribers = alive
}

func (s *ChatSession) closeAllSubscribers() {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, sub := range s.subscribers {
		select {
		case <-sub.done:
		default:
		}
		close(sub.ch)
	}
	s.subscribers = nil
}

// Interrupt sends SIGINT to the child process (graceful stop).
func (s *ChatSession) Interrupt() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.Cmd == nil || s.Cmd.Process == nil {
		return fmt.Errorf("no process to interrupt")
	}
	return s.Cmd.Process.Signal(os.Interrupt)
}

// Close kills the child process.
func (s *ChatSession) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.stdin != nil {
		s.stdin.Close()
		s.stdin = nil
	}

	if s.Cmd != nil && s.Cmd.Process != nil {
		if err := s.Cmd.Process.Kill(); err != nil {
			return fmt.Errorf("failed to kill process: %w", err)
		}
		_ = s.Cmd.Wait()
	}

	return nil
}

// IsAlive checks whether the child process is still running.
func (s *ChatSession) IsAlive() bool {
	if s.Cmd == nil || s.Cmd.Process == nil {
		return false
	}
	return s.Cmd.ProcessState == nil
}

// ChatManager manages chat sessions keyed by project ID.
// InjectContextUpdate queues a VIBECTL.md update for the next prompt on a project's active session.
func (m *ChatManager) InjectContextUpdate(projectID, content string) {
	m.mu.RLock()
	sess, ok := m.sessions[projectID]
	m.mu.RUnlock()
	if !ok || !sess.IsAlive() {
		return
	}
	sess.QueueContextUpdate(content)
	slog.Info("queued context update", "projectID", projectID)
}

// IntentExtractorFunc is called after a session is archived, to extract developer intents.
type IntentExtractorFunc func(entry *models.ChatHistoryEntry)

type ChatManager struct {
	sessions            map[string]*ChatSession
	projectTokens       map[string]string // per-project Claude OAuth tokens (for account switching)
	mu                  sync.RWMutex
	skipPermissions     bool
	ChatSessionService  ChatSessionPersister
	ChatHistoryService  ChatHistoryArchiver
	UsageRecorder       UsageRecorderFunc // optional callback for token usage tracking
	IntentExtractor     IntentExtractorFunc // optional callback for intent extraction after archive

	// Cache-optimizer trace recording (research toggle). When RecordTraces is
	// true and RecordingProxyCmd is set, each Claude Code spawn is wrapped with
	// a local recording proxy. See internal/terminal/recording_proxy.go.
	RecordTraces            bool
	RecordingProxyCmd       string
	RecordingProxyDir       string
	RecordingProxyOutputDir string

	// ModelResolver returns the Claude model to spawn with for the given project,
	// or empty string to let Claude Code use its own default. Looks up project
	// override first, then falls back to global settings.DefaultModel. Wired
	// in cmd/server/main.go.
	ModelResolver func(projectID string) string

	// Idle reaper — SIGTERMs Claude Code subprocesses that have been quiet
	// (no stdin write, no stdout event) for IdleReapAfter with no attached
	// WebSocket subscribers. Each subprocess holds 300-500 MB of RAM, so an
	// idle user with 20 open project cards otherwise burns 6-10 GB.
	// Frontend gets a session_reaped event and silently unmounts; the next
	// message spawns a fresh --resume session from the on-disk JSONL.
	//
	// IdleReapAfter <= 0 disables the reaper. Default 20 min.
	IdleReapAfter time.Duration
	// MaxActiveClaude, if > 0, caps the concurrent Claude Code subprocesses.
	// When a new spawn would exceed this, the least-recently-active idle
	// session is reaped first. 0 = unlimited.
	MaxActiveClaude int
}

// NewChatManager creates a new chat session manager.
func NewChatManager(chatSessionService ChatSessionPersister, chatHistoryService ChatHistoryArchiver) *ChatManager {
	return &ChatManager{
		sessions:            make(map[string]*ChatSession),
		projectTokens:       make(map[string]string),
		skipPermissions:     true, // default to accept-all
		ChatSessionService:  chatSessionService,
		ChatHistoryService:  chatHistoryService,
	}
}

// SetSkipPermissions sets whether new sessions skip permission prompts.
func (m *ChatManager) SetSkipPermissions(skip bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.skipPermissions = skip
}

// GetSessionUser returns the userId and userName for an active session, or nil/"" if not found.
func (m *ChatManager) GetSessionUser(projectID string) (*bson.ObjectID, string) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if sess, ok := m.sessions[projectID]; ok {
		return sess.UserID, sess.UserName
	}
	return nil, ""
}

// RemoveSession removes a session from the manager without killing or marking dead.
func (m *ChatManager) RemoveSession(projectID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.sessions, projectID)
}

// GetSession returns the chat session for a project, or nil if none exists.
func (m *ChatManager) GetSession(projectID string) *ChatSession {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sessions[projectID]
}

// SetProjectToken sets a per-project Claude OAuth token for account switching.
// The token will be injected into the Claude process environment when the session starts.
func (m *ChatManager) SetProjectToken(projectID, token string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if token == "" {
		delete(m.projectTokens, projectID)
	} else {
		m.projectTokens[projectID] = token
	}
}

// GetProjectToken returns the per-project token, if set.
func (m *ChatManager) GetProjectToken(projectID string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.projectTokens[projectID]
}

// PreserveCurrentTokenForAllSessions snapshots the given token as the per-project
// token for every active session that doesn't already have one. Call this before
// `claude auth login` changes the global keychain credential, so existing sessions
// keep using their original account.
func (m *ChatManager) PreserveCurrentTokenForAllSessions(token string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for pid := range m.sessions {
		if m.projectTokens[pid] == "" {
			m.projectTokens[pid] = token
			slog.Info("preserved token for existing session", "projectID", pid)
		}
	}
}

// startProcess is the shared logic for spawning a claude process.
// extraArgs are appended after the standard flags (e.g. --resume <id>).
func (m *ChatManager) startProcess(projectID, localPath string, extraArgs ...string) (*ChatSession, error) {
	// NOTE: MaxActiveClaude cap is enforced by the public entrypoints
	// (StartSession / ResumeSession) BEFORE they acquire m.mu.Lock —
	// gatherReapCandidates and reapSession both need m.mu themselves and
	// Go's RWMutex is not reentrant. Do NOT call m.EnforceMaxActiveClaude()
	// from inside startProcess.

	args := []string{
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
	}
	if m.skipPermissions {
		args = append(args, "--dangerously-skip-permissions")
	} else {
		// In non-skip mode, use "acceptEdits" which auto-approves reads/edits
		// but blocks dangerous operations (rm, etc). The default mode silently
		// denies everything in non-interactive (-p) mode.
		// Also allow plan mode tools — they're safe (just change Claude's output mode).
		// Also allow AskUserQuestion — it's a UI-surface tool the assistant uses
		// to gather clarification from the user. Without allowlisting it,
		// acceptEdits silently denies the tool call and the user never sees
		// the question, giving the appearance that the assistant just skipped
		// past it. The frontend renders the question inline in the chat.
		// Without this, acceptEdits silently denies them and plan mode / question
		// prompts get stuck.
		args = append(args, "--permission-mode", "acceptEdits",
			"--allowedTools", "EnterPlanMode ExitPlanMode AskUserQuestion")
	}
	args = append(args, extraArgs...)

	// Resolve model: project override > settings default > unset (use Claude's default).
	if m.ModelResolver != nil {
		if model := m.ModelResolver(projectID); model != "" {
			args = append(args, "--model", model)
			slog.Info("spawn with model", "projectID", projectID, "model", model)
		}
	}

	cmd := exec.Command("claude", args...)

	if localPath != "" {
		// Check if directory exists before trying to start
		if _, err := os.Stat(localPath); os.IsNotExist(err) {
			return nil, fmt.Errorf("DIR_NOT_FOUND: %s", localPath)
		}
		cmd.Dir = localPath
	} else {
		home, _ := os.UserHomeDir()
		cmd.Dir = home
	}
	env := os.Environ()

	// CRITICAL COST SAFEGUARD:
	// Claude Code, if it sees ANTHROPIC_API_KEY in its env, will bill every
	// call against the API key instead of the user's OAuth (Pro/Team)
	// subscription. Vibectl sets ANTHROPIC_API_KEY in its own env for the
	// server-side AI agents (triage, PM review, intent extraction, model
	// list). That key must NOT leak into the Claude Code subprocess.
	//
	// Same for ANTHROPIC_AUTH_TOKEN — Claude Code accepts it as an alias.
	//
	// Removing these forces Claude Code to fall back to the OAuth flow it
	// manages itself via ~/.claude/.credentials.json + keychain, which is
	// what the user actually pays for on their subscription.
	filtered := env[:0]
	for _, e := range env {
		if strings.HasPrefix(e, "ANTHROPIC_API_KEY=") ||
			strings.HasPrefix(e, "ANTHROPIC_AUTH_TOKEN=") {
			continue
		}
		filtered = append(filtered, e)
	}
	env = filtered
	// Per-project token takes priority (account switching via /login).
	// Falls back to globally stored token file.
	// Do NOT read from keychain here — let Claude Code handle its own auth
	// natively (it manages token refresh). We only read keychain below for
	// the usage tracking hash.
	var oauthToken string
	if token := m.projectTokens[projectID]; token != "" {
		oauthToken = token
	} else if token := getStoredClaudeToken(); token != "" {
		oauthToken = token
	}
	if oauthToken != "" {
		env = append(env, "CLAUDE_CODE_OAUTH_TOKEN="+oauthToken)
	}

	// Optional cache-optimizer trace recording. Non-fatal: if the proxy can't
	// start, Claude Code launches normally without recording.
	spawnID := uuid.New().String()
	var proxy *recordingProxy
	if m.RecordTraces && m.RecordingProxyCmd != "" {
		p, err := startRecordingProxy(m.RecordingProxyCmd, m.RecordingProxyDir, m.RecordingProxyOutputDir, spawnID)
		if err != nil {
			slog.Warn("recording proxy disabled for this spawn", "projectID", projectID, "error", err)
		} else {
			proxy = p
			env = append(env, fmt.Sprintf("ANTHROPIC_BASE_URL=http://127.0.0.1:%d", p.port))
			slog.Info("recording trace for spawn", "projectID", projectID, "spawnID", spawnID, "port", p.port)
		}
	}

	cmd.Env = env

	stdinPipe, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("stdin pipe: %w", err)
	}

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		stdinPipe.Close()
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}

	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		stdinPipe.Close()
		stdoutPipe.Close()
		return nil, fmt.Errorf("stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		stdinPipe.Close()
		return nil, fmt.Errorf("start claude: %w", err)
	}

	// Compute stable hash of OAuth token for usage tracking identity.
	// Use the env-var token if set, otherwise read from keychain (read-only, not passed to Claude).
	tokenForHash := oauthToken
	if tokenForHash == "" {
		tokenForHash = readClaudeTokenFromKeychain()
	}
	var tokenHash string
	if tokenForHash != "" {
		h := sha256.Sum256([]byte(tokenForHash))
		tokenHash = fmt.Sprintf("%x", h[:8]) // 16-char hex prefix — enough for identity
		slog.Info("usage tracking enabled", "tokenHash", tokenHash, "projectID", projectID)
	} else {
		slog.Warn("no OAuth token found — usage tracking disabled", "projectID", projectID)
	}

	sess := &ChatSession{
		ID:           spawnID,
		ProjectCode:  projectID,
		LocalPath:    localPath,
		TokenHash:    tokenHash,
		StartedAt:    time.Now().UTC(),
		lastActivity: time.Now(),
		Cmd:          cmd,
		stdin:        stdinPipe,
		exited:       make(chan struct{}),
		proxy:        proxy,
	}

	// stderrDone is closed when the stderr goroutine has fully drained.
	stderrDone := make(chan struct{})

	// Background goroutine: read stderr, buffer all lines, forward errors immediately.
	go func() {
		defer close(stderrDone)
		scanner := bufio.NewScanner(stderrPipe)
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				continue
			}
			slog.Warn("claude stderr", "projectID", projectID, "line", line)

			// Buffer all stderr lines for post-exit reporting.
			sess.stderrMu.Lock()
			sess.stderrBuf = append(sess.stderrBuf, line)
			if len(sess.stderrBuf) > 50 {
				sess.stderrBuf = sess.stderrBuf[len(sess.stderrBuf)-50:]
			}
			sess.stderrMu.Unlock()

			// Forward error lines immediately (case-insensitive match).
			lower := strings.ToLower(line)
			// Model availability errors get their own typed event so the
			// frontend can show an inline picker. The standard wording from
			// Claude Code is "issue with the selected model (<id>)".
			if strings.Contains(lower, "issue with the selected model") ||
				strings.Contains(lower, "model not found") ||
				(strings.Contains(lower, "model") && strings.Contains(lower, "may not exist")) {
				modelEvent := map[string]interface{}{
					"type": "model_unavailable",
					"data": map[string]string{"message": line},
				}
				if data, marshalErr := json.Marshal(modelEvent); marshalErr == nil {
					sess.broadcast(data)
				}
			}
			// Orphan session ID: Claude Code can't find the persisted session
			// (typically because a prior spawn failed before writing the
			// conversation file). Auto-clear the bad ID so the next launch
			// starts fresh, and tell the frontend to relaunch.
			if strings.Contains(lower, "no conversation found with session id") {
				sess.mu.Lock()
				sess.sessionLost = true
				sess.mu.Unlock()
				go func() {
					ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					defer cancel()
					if err := m.ChatSessionService.ClearSession(ctx, projectID); err != nil {
						slog.Error("failed to clear orphaned session ID", "projectID", projectID, "error", err)
					} else {
						slog.Info("cleared orphaned session ID after no-conversation-found",
							"projectID", projectID, "staleSessionID", sess.SessionID)
					}
				}()
				evt := map[string]interface{}{
					"type": "session_lost",
					"data": map[string]string{"message": line},
				}
				if data, marshalErr := json.Marshal(evt); marshalErr == nil {
					sess.broadcast(data)
				}
			}
			if strings.Contains(lower, "error") ||
				strings.Contains(lower, "not logged in") ||
				strings.Contains(lower, "please run /login") ||
				strings.Contains(lower, "authentication") ||
				strings.Contains(lower, "oauth") ||
				strings.Contains(line, "401") {
				errEvent := map[string]interface{}{
					"type": "error",
					"data": map[string]string{"message": line},
				}
				if data, marshalErr := json.Marshal(errEvent); marshalErr == nil {
					sess.broadcast(data)
				}
			}
		}
	}()

	// Background goroutine: read stdout line by line, broadcast each event.
	go func() {
		defer close(sess.exited)
		defer sess.closeAllSubscribers()
		defer sess.proxy.stop() // no-op if nil; flushes the recording trace

		scanner := bufio.NewScanner(stdoutPipe)
		scanner.Buffer(make([]byte, 1024*1024), 1024*1024) // 1MB line buffer
		for scanner.Scan() {
			line := scanner.Bytes()
			if len(line) == 0 {
				continue
			}

			// Any stdout activity means claude is working — reset the idle
			// timer so the reaper doesn't kill an active session.
			sess.TouchActivity()

			// Buffer non-stream events for reconnection replay.
			var parsed struct {
				Type      string `json:"type"`
				SessionID string `json:"session_id"`
			}
			if err := json.Unmarshal(line, &parsed); err == nil {
				// Capture session ID in memory immediately so /compact and other
				// in-process resumes work, but DON'T persist to Mongo yet.
				// Claude Code only writes the conversation file to disk after
				// the first assistant turn — persisting earlier risks orphaning
				// a session ID if Claude exits before completing a turn (e.g.
				// model_unavailable errors), causing future "no conversation
				// found" failures on resume.
				if sess.SessionID == "" && parsed.SessionID != "" {
					sess.SessionID = parsed.SessionID
				}

				// Buffer complete messages (assistant, user/tool_result), not stream deltas
				if parsed.Type == "assistant" || parsed.Type == "user" {
					data := make(json.RawMessage, len(line))
					copy(data, line)
					sess.mu.Lock()
					wasFirstAssistant := parsed.Type == "assistant" && !sess.committed
					sess.messages = append(sess.messages, data)
					if len(sess.messages) > 500 {
						sess.messages = sess.messages[len(sess.messages)-500:]
					}
					sess.dirty = true
					if wasFirstAssistant {
						sess.committed = true
					}
					sess.mu.Unlock()

					// Persist the session ID once Claude Code has actually
					// committed a conversation to its on-disk log (first
					// assistant message means the turn completed successfully).
					if wasFirstAssistant && sess.SessionID != "" {
						m.persistSession(sess)
					}
				}

				// Extract token usage from stream events for usage tracking.
				// Also handle "result" type which some Claude Code versions emit at end of turn.
				if m.UsageRecorder != nil && sess.TokenHash != "" {
					if parsed.Type == "stream_event" {
						m.extractStreamUsage(line, sess)
					} else if parsed.Type == "result" {
						m.extractResultUsage(line, sess)
					}
				}

				// Detect model-unavailable errors emitted via result events with
				// is_error: true. Claude Code surfaces these on stdout, not stderr.
				if parsed.Type == "result" {
					var r struct {
						IsError bool   `json:"is_error"`
						Result  string `json:"result"`
					}
					if json.Unmarshal(line, &r) == nil && r.IsError {
						lower := strings.ToLower(r.Result)
						if strings.Contains(lower, "issue with the selected model") ||
							strings.Contains(lower, "model not found") ||
							(strings.Contains(lower, "model") && strings.Contains(lower, "may not exist")) {
							evt := map[string]interface{}{
								"type": "model_unavailable",
								"data": map[string]string{"message": r.Result},
							}
							if data, marshalErr := json.Marshal(evt); marshalErr == nil {
								sess.broadcast(data)
							}
						}
					}
				}

				dataCopy := make([]byte, len(line))
				copy(dataCopy, line)
				sess.broadcast(dataCopy)
			} else {
				// Non-JSON stdout line — check for login errors and wrap as JSON error event
				lower := strings.ToLower(string(line))
				if strings.Contains(lower, "not logged in") || strings.Contains(lower, "please run /login") {
					errEvent := map[string]interface{}{
						"type": "error",
						"data": map[string]string{"message": string(line)},
					}
					if data, marshalErr := json.Marshal(errEvent); marshalErr == nil {
						sess.broadcast(data)
					}
				} else {
					// Broadcast raw for other non-JSON output
					dataCopy := make([]byte, len(line))
					copy(dataCopy, line)
					sess.broadcast(dataCopy)
				}
			}
		}

		if err := scanner.Err(); err != nil {
			slog.Error("chat stdout scanner error", "projectID", projectID, "error", err)
		}

		// Capture exit code before waiting for stderr to finish.
		waitErr := cmd.Wait()
		exitCode := 0
		if waitErr != nil {
			if exitErr, ok := waitErr.(*exec.ExitError); ok {
				exitCode = exitErr.ExitCode()
			}
		}

		// Wait for stderr goroutine to finish (with a short timeout).
		select {
		case <-stderrDone:
		case <-time.After(2 * time.Second):
		}

		// Broadcast system_error if process exited non-zero or produced stderr.
		sess.stderrMu.Lock()
		stderrLines := make([]string, len(sess.stderrBuf))
		copy(stderrLines, sess.stderrBuf)
		sess.stderrMu.Unlock()

		sess.mu.Lock()
		suppressSystemError := sess.sessionLost || sess.reapedForIdle
		committed := sess.committed
		sess.mu.Unlock()

		if (exitCode != 0 || len(stderrLines) > 0) && !suppressSystemError {
			slog.Error("claude process exited with error",
				"projectID", projectID,
				"exitCode", exitCode,
				"stderrLines", len(stderrLines),
			)
			sysErr := map[string]interface{}{
				"type": "system_error",
				"data": map[string]interface{}{
					"exitCode": exitCode,
					"stderr":   stderrLines,
				},
			}
			if data, marshalErr := json.Marshal(sysErr); marshalErr == nil {
				sess.broadcast(data)
			}
		} else if suppressSystemError {
			slog.Info("suppressed system_error broadcast after session_lost",
				"projectID", projectID, "exitCode", exitCode)
		}

		// Only persist on exit if the session was committed (at least one
		// assistant message). Otherwise the session ID is in-memory only —
		// writing it now would create an orphan on Mongo with no matching
		// conversation file on disk.
		if committed {
			m.persistSession(sess)
		} else {
			slog.Info("skipping final persist for uncommitted session",
				"projectID", projectID, "sessionID", sess.SessionID, "exitCode", exitCode)
		}

		// Archive session to history
		m.archiveSession(sess)

		slog.Info("chat session exited", "projectID", projectID, "sessionID", sess.ID, "exitCode", exitCode)
	}()

	// Periodic persistence ticker (every 5 seconds if dirty)
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-sess.exited:
				return
			case <-ticker.C:
				sess.mu.Lock()
				isDirty := sess.dirty
				committed := sess.committed
				sess.dirty = false
				sess.mu.Unlock()
				if isDirty && committed {
					m.persistSession(sess)
				}
			}
		}
	}()

	return sess, nil
}

// persistSession saves the current session state to MongoDB.
func (m *ChatManager) persistSession(sess *ChatSession) {
	if m.ChatSessionService == nil {
		return
	}
	msgs := sess.Messages()
	sid := sess.SessionID
	if sid == "" {
		return // nothing useful to persist yet
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := m.ChatSessionService.Upsert(ctx, sess.ProjectCode, sid, sess.LocalPath, msgs); err != nil {
		slog.Error("failed to persist chat session", "projectID", sess.ProjectCode, "error", err)
	}
}

// archiveSession saves the session's messages to chat history for later viewing.
func (m *ChatManager) archiveSession(sess *ChatSession) {
	if m.ChatHistoryService == nil {
		return
	}
	msgs := sess.Messages()
	if len(msgs) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := m.ChatHistoryService.Archive(ctx, sess.ProjectCode, sess.SessionID, msgs, sess.StartedAt, sess.UserID, sess.UserName); err != nil {
		slog.Error("failed to archive chat session", "projectCode", sess.ProjectCode, "error", err)
	} else {
		slog.Info("chat session archived to history", "projectCode", sess.ProjectCode, "messages", len(msgs))
		// Trigger async intent extraction
		if m.IntentExtractor != nil {
			entry := &models.ChatHistoryEntry{
				ProjectCode:     sess.ProjectCode,
				ClaudeSessionID: sess.SessionID,
				UserID:          sess.UserID,
				UserName:        sess.UserName,
				Messages:        msgs,
				MessageCount:    len(msgs),
				StartedAt:       sess.StartedAt,
				EndedAt:         time.Now().UTC(),
			}
			m.IntentExtractor(entry)
		}
	}
}

// StartSession spawns a claude process in stream-json mode.
func (m *ChatManager) StartSession(projectID, localPath string) (*ChatSession, error) {
	// Enforce the concurrency cap BEFORE we hold m.mu — the cap enforcement
	// may need to reap other sessions and reapSession → KillSession takes
	// m.mu.Lock itself. Go's RWMutex is not reentrant, so acquiring it here
	// first would deadlock.
	m.EnforceMaxActiveClaude()

	m.mu.Lock()
	defer m.mu.Unlock()

	if existing, ok := m.sessions[projectID]; ok {
		if existing.IsAlive() {
			return nil, fmt.Errorf("session already exists for project %s", projectID)
		}
		existing.Close()
		delete(m.sessions, projectID)
	}

	sess, err := m.startProcess(projectID, localPath)
	if err != nil {
		return nil, err
	}

	m.sessions[projectID] = sess

	slog.Info("chat session started",
		"projectID", projectID,
		"sessionID", sess.ID,
		"localPath", localPath,
	)

	time.Sleep(100 * time.Millisecond)
	return sess, nil
}

// SetUser associates a vibectl user with this session for attribution in intents/analytics.
func (s *ChatSession) SetUser(userID *bson.ObjectID, userName string) {
	s.UserID = userID
	s.UserName = userName
}

// ResumeSession spawns a claude process that resumes a previous session by ID.
func (m *ChatManager) ResumeSession(projectID, localPath, claudeSessionID string, savedMessages []json.RawMessage) (*ChatSession, error) {
	// Enforce cap before taking m.mu — same reason as StartSession.
	m.EnforceMaxActiveClaude()

	m.mu.Lock()
	defer m.mu.Unlock()

	if existing, ok := m.sessions[projectID]; ok {
		if existing.IsAlive() {
			return nil, fmt.Errorf("session already exists for project %s", projectID)
		}
		existing.Close()
		delete(m.sessions, projectID)
	}

	sess, err := m.startProcess(projectID, localPath, "--resume", claudeSessionID)
	if err != nil {
		return nil, err
	}

	// Pre-populate with saved messages so reconnection replay includes history
	sess.SessionID = claudeSessionID
	sess.mu.Lock()
	sess.messages = savedMessages
	sess.mu.Unlock()

	m.sessions[projectID] = sess

	slog.Info("chat session resumed",
		"projectID", projectID,
		"sessionID", sess.ID,
		"claudeSessionID", claudeSessionID,
		"localPath", localPath,
	)

	time.Sleep(100 * time.Millisecond)
	return sess, nil
}

// KillSession kills the process for the given project.
func (m *ChatManager) KillSession(projectID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	sess, ok := m.sessions[projectID]
	if !ok {
		return fmt.Errorf("no session for project %s", projectID)
	}

	err := sess.Close()
	delete(m.sessions, projectID)

	// Mark as dead so it won't be resumed
	if m.ChatSessionService != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		m.ChatSessionService.MarkDead(ctx, projectID)
	}

	slog.Info("chat session killed", "projectID", projectID, "sessionID", sess.ID)
	return err
}

// ShutdownAll persists and marks all active sessions as resumable, then kills them.
// Called during graceful server shutdown.
func (m *ChatManager) ShutdownAll() {
	m.mu.Lock()
	defer m.mu.Unlock()

	for pid, sess := range m.sessions {
		// Final persist
		m.persistSession(sess)

		// Archive to history
		m.archiveSession(sess)

		// Mark resumable if we have a claude session ID
		if sess.SessionID != "" && m.ChatSessionService != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			m.ChatSessionService.MarkResumable(ctx, sess.ProjectCode)
			cancel()
		}

		sess.Close()
		delete(m.sessions, pid)

		slog.Info("chat session saved for resume",
			"projectID", sess.ProjectCode,
			"claudeSessionID", sess.SessionID,
		)
	}
}

// extractStreamUsage parses stream_event lines for usage data.
// Claude Code stream-json emits:
//   - message_start: contains model name + initial usage
//   - message_delta: contains final cumulative usage (input_tokens, output_tokens, cache tokens)
//
// We capture the model from message_start (stored on the session) and record
// usage from message_delta.
func (m *ChatManager) extractStreamUsage(line []byte, sess *ChatSession) {
	var envelope struct {
		Event json.RawMessage `json:"event"`
	}
	if err := json.Unmarshal(line, &envelope); err != nil || len(envelope.Event) == 0 {
		return
	}

	var eventType struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(envelope.Event, &eventType); err != nil {
		return
	}

	switch eventType.Type {
	case "message_start":
		// Capture model name for this turn.
		var msgStart struct {
			Message struct {
				Model string `json:"model"`
			} `json:"message"`
		}
		if err := json.Unmarshal(envelope.Event, &msgStart); err == nil && msgStart.Message.Model != "" {
			sess.mu.Lock()
			sess.lastModel = msgStart.Message.Model
			sess.mu.Unlock()
		}

	case "message_delta":
		// Final cumulative usage for this turn.
		var msgDelta struct {
			Usage struct {
				InputTokens         int64 `json:"input_tokens"`
				OutputTokens        int64 `json:"output_tokens"`
				CacheReadTokens     int64 `json:"cache_read_input_tokens"`
				CacheCreationTokens int64 `json:"cache_creation_input_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal(envelope.Event, &msgDelta); err != nil {
			return
		}
		u := msgDelta.Usage
		if u.InputTokens == 0 && u.OutputTokens == 0 {
			return
		}

		sess.mu.Lock()
		model := sess.lastModel
		sess.mu.Unlock()

		slog.Info("claude usage recorded",
			"projectID", sess.ProjectCode,
			"model", model,
			"inputTokens", u.InputTokens,
			"outputTokens", u.OutputTokens,
			"cacheRead", u.CacheReadTokens,
			"cacheCreation", u.CacheCreationTokens,
		)

		m.UsageRecorder(
			sess.TokenHash,
			sess.ProjectCode,
			sess.SessionID,
			model,
			u.InputTokens,
			u.OutputTokens,
			u.CacheReadTokens,
			u.CacheCreationTokens,
		)
	}
}

// extractResultUsage handles "result" type events (some Claude Code versions).
func (m *ChatManager) extractResultUsage(line []byte, sess *ChatSession) {
	var resultEvent struct {
		Result struct {
			Model string `json:"model"`
			Usage struct {
				InputTokens         int64 `json:"input_tokens"`
				OutputTokens        int64 `json:"output_tokens"`
				CacheReadTokens     int64 `json:"cache_read_input_tokens"`
				CacheCreationTokens int64 `json:"cache_creation_input_tokens"`
			} `json:"usage"`
		} `json:"result"`
	}
	if err := json.Unmarshal(line, &resultEvent); err != nil {
		return
	}
	u := resultEvent.Result.Usage
	if u.InputTokens == 0 && u.OutputTokens == 0 {
		return
	}
	model := resultEvent.Result.Model
	if model == "" {
		sess.mu.Lock()
		model = sess.lastModel
		sess.mu.Unlock()
	}
	slog.Info("claude usage recorded (result)",
		"projectID", sess.ProjectCode,
		"model", model,
		"inputTokens", u.InputTokens,
		"outputTokens", u.OutputTokens,
	)
	m.UsageRecorder(
		sess.TokenHash, sess.ProjectCode, sess.SessionID, model,
		u.InputTokens, u.OutputTokens, u.CacheReadTokens, u.CacheCreationTokens,
	)
}

// getStoredClaudeToken reads the Claude OAuth token from persistent storage.
// Uses /data (Fly volume) when available, otherwise ~/.vibectl/.claude-oauth-token.
// Returns empty string if no token is stored.
func getStoredClaudeToken() string {
	tokenPath := "/data/.claude-oauth-token"
	if _, err := os.Stat("/data"); err != nil {
		home, _ := os.UserHomeDir()
		tokenPath = filepath.Join(home, ".vibectl", ".claude-oauth-token")
	}
	data, err := os.ReadFile(tokenPath)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// ReadClaudeTokenFromKeychain is the exported version of readClaudeTokenFromKeychain.
func ReadClaudeTokenFromKeychain() string {
	return readClaudeTokenFromKeychain()
}

// readClaudeTokenFromKeychain tries multiple locations where Claude Code stores OAuth tokens.
// Claude Code has moved credentials between releases:
//   1. macOS keychain: service "Claude Code-credentials", account = username (current)
//   2. ~/.claude/.credentials.json with claudeAiOauth.accessToken (older)
// Returns empty string if the token can't be found anywhere.
func readClaudeTokenFromKeychain() string {
	// Try macOS keychain first (current Claude Code location)
	acct := os.Getenv("USER")
	if acct != "" {
		out, err := exec.Command("security", "find-generic-password",
			"-s", "Claude Code-credentials",
			"-a", acct,
			"-w",
		).Output()
		if err == nil {
			var creds struct {
				ClaudeAiOauth struct {
					AccessToken string `json:"accessToken"`
				} `json:"claudeAiOauth"`
			}
			if json.Unmarshal(out, &creds) == nil && creds.ClaudeAiOauth.AccessToken != "" {
				return creds.ClaudeAiOauth.AccessToken
			}
		}
	}

	// Fallback: ~/.claude/.credentials.json (older Claude Code versions)
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	credPath := filepath.Join(home, ".claude", ".credentials.json")
	data, err := os.ReadFile(credPath)
	if err != nil {
		return ""
	}
	var creds struct {
		ClaudeAiOauth struct {
			AccessToken string `json:"accessToken"`
		} `json:"claudeAiOauth"`
	}
	if json.Unmarshal(data, &creds) == nil && creds.ClaudeAiOauth.AccessToken != "" {
		return creds.ClaudeAiOauth.AccessToken
	}
	return ""
}

// PKCELoginParams holds the parameters for a PKCE OAuth login flow.
type PKCELoginParams struct {
	AuthURL      string
	CodeVerifier string
	ClientID     string
	RedirectURI  string
	State        string
}

// generatePKCELogin creates PKCE parameters and an auth URL for Claude OAuth.
// Does NOT modify the keychain — the token is managed per-project in memory.
func generatePKCELogin() *PKCELoginParams {
	verifierBytes := make([]byte, 32)
	if _, err := rand.Read(verifierBytes); err != nil {
		slog.Error("failed to generate PKCE verifier", "error", err)
		return nil
	}
	codeVerifier := base64.RawURLEncoding.EncodeToString(verifierBytes)
	challengeHash := sha256.Sum256([]byte(codeVerifier))
	codeChallenge := base64.RawURLEncoding.EncodeToString(challengeHash[:])

	stateBytes := make([]byte, 32)
	rand.Read(stateBytes)
	state := base64.RawURLEncoding.EncodeToString(stateBytes)

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

	return &PKCELoginParams{
		AuthURL:      authURL,
		CodeVerifier: codeVerifier,
		ClientID:     clientID,
		RedirectURI:  redirectURI,
		State:        state,
	}
}

// exchangeCodeForToken exchanges an OAuth authorization code for an access token.
func exchangeCodeForToken(code, codeVerifier, clientID, redirectURI string) (string, error) {
	payload, _ := json.Marshal(map[string]string{
		"grant_type":    "authorization_code",
		"code":          code,
		"redirect_uri":  redirectURI,
		"client_id":     clientID,
		"code_verifier": codeVerifier,
	})

	req, _ := http.NewRequest("POST", "https://platform.claude.com/v1/oauth/token", strings.NewReader(string(payload)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "claude-code/1.0.0")
	req.Header.Set("anthropic-client-name", "claude-code")
	req.Header.Set("anthropic-client-version", "1.0.0")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("token exchange request failed: %w", err)
	}
	defer resp.Body.Close()

	var tokenResp struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
		ErrorDesc   string `json:"error_description"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil {
		return "", fmt.Errorf("failed to parse token response: %w", err)
	}
	if tokenResp.Error != "" {
		return "", fmt.Errorf("%s: %s", tokenResp.Error, tokenResp.ErrorDesc)
	}
	if tokenResp.AccessToken == "" {
		return "", fmt.Errorf("no access_token in response (HTTP %d)", resp.StatusCode)
	}
	return tokenResp.AccessToken, nil
}
