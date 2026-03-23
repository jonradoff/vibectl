package terminal

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
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
	ProjectID   string
	LocalPath   string
	SessionID   string // Claude session ID from init event
	StartedAt   time.Time
	Cmd         *exec.Cmd
	stdin       io.WriteCloser
	exited      chan struct{}
	subscribers []*subscriber
	messages    []json.RawMessage // buffered events for reconnection
	dirty       bool              // true if messages changed since last persist
	mu          sync.Mutex
	stderrMu    sync.Mutex
	stderrBuf   []string // recent stderr lines, capped at 50
}

// SendMessage writes a user message to claude's stdin in stream-json format.
func (s *ChatSession) SendMessage(text string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.stdin == nil {
		return fmt.Errorf("session stdin closed")
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
type ChatManager struct {
	sessions            map[string]*ChatSession
	mu                  sync.RWMutex
	skipPermissions     bool
	ChatSessionService  ChatSessionPersister
	ChatHistoryService  ChatHistoryArchiver
}

// NewChatManager creates a new chat session manager.
func NewChatManager(chatSessionService ChatSessionPersister, chatHistoryService ChatHistoryArchiver) *ChatManager {
	return &ChatManager{
		sessions:            make(map[string]*ChatSession),
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
	// Inject Claude OAuth token from persistent storage if available
	if tokenData, err := os.ReadFile("/data/.claude-oauth-token"); err == nil {
		token := strings.TrimSpace(string(tokenData))
		if token != "" {
			env = append(env, "CLAUDE_CODE_OAUTH_TOKEN="+token)
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

	sess := &ChatSession{
		ID:        uuid.New().String(),
		ProjectID: projectID,
		LocalPath: localPath,
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
	if err := m.ChatSessionService.Upsert(ctx, sess.ProjectID, sid, sess.LocalPath, msgs); err != nil {
		slog.Error("failed to persist chat session", "projectID", sess.ProjectID, "error", err)
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
	if err := m.ChatHistoryService.Archive(ctx, sess.ProjectID, sess.SessionID, msgs, sess.StartedAt); err != nil {
		slog.Error("failed to archive chat session", "projectID", sess.ProjectID, "error", err)
	} else {
		slog.Info("chat session archived to history", "projectID", sess.ProjectID, "messages", len(msgs))
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
			m.ChatSessionService.MarkResumable(ctx, sess.ProjectID)
			cancel()
		}

		sess.Close()
		delete(m.sessions, pid)

		slog.Info("chat session saved for resume",
			"projectID", sess.ProjectID,
			"claudeSessionID", sess.SessionID,
		)
	}
}
