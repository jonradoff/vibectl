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
)

// ChatSessionPersister is the persistence interface for active chat session state.
type ChatSessionPersister interface {
	Upsert(ctx context.Context, projectID, claudeSessionID, localPath string, messages []json.RawMessage) error
	MarkResumable(ctx context.Context, projectID string) error
	MarkDead(ctx context.Context, projectID string) error
	GetResumable(ctx context.Context, projectID string) (*models.ChatSessionState, error)
}

// ChatHistoryArchiver is the persistence interface for completed chat session history.
type ChatHistoryArchiver interface {
	Archive(ctx context.Context, projectID, claudeSessionID string, messages []json.RawMessage, startedAt time.Time) error
}

// ChatSession represents a claude code process running in stream-json mode.
type ChatSession struct {
	ID          string
	ProjectCode string
	LocalPath   string
	SessionID   string // Claude session ID from init event
	TokenHash   string // SHA256 of OAuth token used — stable identity per login
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
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.stdin == nil {
		return fmt.Errorf("session stdin closed")
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

	return nil
}

// SendControlResponse writes a control_response to claude's stdin (for permission approvals/denials).
func (s *ChatSession) SendControlResponse(requestID string, response json.RawMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.stdin == nil {
		return fmt.Errorf("session stdin closed")
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
		// Without this, acceptEdits silently denies them and plan mode gets stuck.
		args = append(args, "--permission-mode", "acceptEdits",
			"--allowedTools", "EnterPlanMode ExitPlanMode")
	}
	args = append(args, extraArgs...)

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
		ID:        uuid.New().String(),
		ProjectCode: projectID,
		LocalPath: localPath,
		TokenHash: tokenHash,
		StartedAt: time.Now().UTC(),
		Cmd:       cmd,
		stdin:     stdinPipe,
		exited:    make(chan struct{}),
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

		scanner := bufio.NewScanner(stdoutPipe)
		scanner.Buffer(make([]byte, 1024*1024), 1024*1024) // 1MB line buffer
		for scanner.Scan() {
			line := scanner.Bytes()
			if len(line) == 0 {
				continue
			}

			// Buffer non-stream events for reconnection replay.
			var parsed struct {
				Type      string `json:"type"`
				SessionID string `json:"session_id"`
			}
			if err := json.Unmarshal(line, &parsed); err == nil {
				if sess.SessionID == "" && parsed.SessionID != "" {
					sess.SessionID = parsed.SessionID
					// Persist immediately when we learn the session ID
					m.persistSession(sess)
				}

				// Buffer complete messages (assistant, user/tool_result), not stream deltas
				if parsed.Type == "assistant" || parsed.Type == "user" {
					data := make(json.RawMessage, len(line))
					copy(data, line)
					sess.mu.Lock()
					sess.messages = append(sess.messages, data)
					if len(sess.messages) > 500 {
						sess.messages = sess.messages[len(sess.messages)-500:]
					}
					sess.dirty = true
					sess.mu.Unlock()
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

		if exitCode != 0 || len(stderrLines) > 0 {
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
		}

		// Final persist on exit
		m.persistSession(sess)

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
				sess.dirty = false
				sess.mu.Unlock()
				if isDirty {
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
	if err := m.ChatHistoryService.Archive(ctx, sess.ProjectCode, sess.SessionID, msgs, sess.StartedAt); err != nil {
		slog.Error("failed to archive chat session", "projectCode", sess.ProjectCode, "error", err)
	} else {
		slog.Info("chat session archived to history", "projectCode", sess.ProjectCode, "messages", len(msgs))
		// Trigger async intent extraction
		if m.IntentExtractor != nil {
			entry := &models.ChatHistoryEntry{
				ProjectCode:     sess.ProjectCode,
				ClaudeSessionID: sess.SessionID,
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

// ResumeSession spawns a claude process that resumes a previous session by ID.
func (m *ChatManager) ResumeSession(projectID, localPath, claudeSessionID string, savedMessages []json.RawMessage) (*ChatSession, error) {
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
