package terminal

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/creack/pty"
	"github.com/google/uuid"
)

const defaultBufferSize = 256 * 1024 // 256KB ring buffer for reconnection replay

// RingBuffer is a fixed-size circular buffer for terminal output.
type RingBuffer struct {
	buf  []byte
	size int
	pos  int
	full bool
	mu   sync.Mutex
}

// NewRingBuffer creates a ring buffer with the given capacity.
func NewRingBuffer(size int) *RingBuffer {
	return &RingBuffer{
		buf:  make([]byte, size),
		size: size,
	}
}

// Write appends data to the ring buffer, overwriting oldest data when full.
func (rb *RingBuffer) Write(p []byte) (int, error) {
	rb.mu.Lock()
	defer rb.mu.Unlock()

	n := len(p)
	if n >= rb.size {
		copy(rb.buf, p[n-rb.size:])
		rb.pos = 0
		rb.full = true
		return n, nil
	}

	remaining := rb.size - rb.pos
	if n <= remaining {
		copy(rb.buf[rb.pos:], p)
		rb.pos += n
		if rb.pos == rb.size {
			rb.pos = 0
			rb.full = true
		}
	} else {
		copy(rb.buf[rb.pos:], p[:remaining])
		copy(rb.buf, p[remaining:])
		rb.pos = n - remaining
		rb.full = true
	}

	return n, nil
}

// Bytes returns all buffered content in order (oldest first).
func (rb *RingBuffer) Bytes() []byte {
	rb.mu.Lock()
	defer rb.mu.Unlock()

	if !rb.full {
		out := make([]byte, rb.pos)
		copy(out, rb.buf[:rb.pos])
		return out
	}

	out := make([]byte, rb.size)
	n := copy(out, rb.buf[rb.pos:])
	copy(out[n:], rb.buf[:rb.pos])
	return out
}

// subscriber represents a WebSocket client listening for PTY output.
type subscriber struct {
	ch   chan []byte
	done chan struct{} // closed when subscriber disconnects
}

// TerminalSession represents a running claude code process attached to a PTY.
type TerminalSession struct {
	ID           string
	ProjectID    string
	ProjectCode  string
	LocalPath    string
	Cmd          *exec.Cmd
	Pty          *os.File
	StartedAt    time.Time
	LastActivity time.Time
	Buffer       *RingBuffer
	exited       chan struct{}    // closed when the PTY read loop ends
	subscribers  []*subscriber
	mu           sync.Mutex
}

// Subscribe registers a new output listener. Returns a channel that receives
// PTY output and a done channel the caller should close when unsubscribing.
func (s *TerminalSession) Subscribe() (<-chan []byte, chan struct{}) {
	sub := &subscriber{
		ch:   make(chan []byte, 256),
		done: make(chan struct{}),
	}

	s.mu.Lock()
	s.subscribers = append(s.subscribers, sub)
	s.mu.Unlock()

	return sub.ch, sub.done
}

// Exited returns a channel that is closed when the PTY process exits.
func (s *TerminalSession) Exited() <-chan struct{} {
	return s.exited
}

// broadcast sends data to all active subscribers, removing any that have
// disconnected.
func (s *TerminalSession) broadcast(data []byte) {
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
			// Subscriber can't keep up — drop this chunk.
		}
		alive = append(alive, sub)
	}
	s.subscribers = alive
}

// closeAllSubscribers closes all subscriber channels (called when PTY exits).
func (s *TerminalSession) closeAllSubscribers() {
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

// Manager manages claude code child processes keyed by project ID.
type Manager struct {
	sessions map[string]*TerminalSession
	mu       sync.RWMutex
}

// NewManager creates a new terminal session manager.
func NewManager() *Manager {
	return &Manager{
		sessions: make(map[string]*TerminalSession),
	}
}

// GetSession returns the session for a project, or nil if none exists.
func (m *Manager) GetSession(projectID string) *TerminalSession {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sessions[projectID]
}

// StartSession spawns a claude command with a PTY in the given working directory.
// If initialPrompt is non-empty, it is written to the PTY after a brief delay.
func (m *Manager) StartSession(projectID, projectCode, localPath string, initialPrompt string) (*TerminalSession, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if existing, ok := m.sessions[projectID]; ok {
		if existing.IsAlive() {
			return nil, fmt.Errorf("session already exists for project %s", projectID)
		}
		existing.Close()
		delete(m.sessions, projectID)
	}

	cmd := exec.Command("claude")
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
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")

	ptmx, err := pty.Start(cmd)
	if err != nil {
		return nil, fmt.Errorf("failed to start pty: %w", err)
	}

	now := time.Now()
	sess := &TerminalSession{
		ID:           uuid.New().String(),
		ProjectID:    projectID,
		ProjectCode:  projectCode,
		LocalPath:    localPath,
		Cmd:          cmd,
		Pty:          ptmx,
		StartedAt:    now,
		LastActivity: now,
		Buffer:       NewRingBuffer(defaultBufferSize),
		exited:       make(chan struct{}),
	}

	// Background goroutine: read PTY output, write to ring buffer, broadcast to subscribers.
	go func() {
		defer close(sess.exited)
		defer sess.closeAllSubscribers()

		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				data := make([]byte, n)
				copy(data, buf[:n])

				sess.mu.Lock()
				sess.Buffer.Write(data)
				sess.LastActivity = time.Now()
				sess.mu.Unlock()

				sess.broadcast(data)
			}
			if err != nil {
				slog.Debug("pty read loop ended", "projectID", projectID, "error", err)
				return
			}
		}
	}()

	m.sessions[projectID] = sess

	slog.Info("terminal session started",
		"projectID", projectID,
		"projectCode", projectCode,
		"sessionID", sess.ID,
		"localPath", localPath,
	)

	if initialPrompt != "" {
		go func() {
			time.Sleep(500 * time.Millisecond)
			if _, err := sess.Write([]byte(initialPrompt + "\n")); err != nil {
				slog.Error("failed to write initial prompt", "projectID", projectID, "error", err)
			}
		}()
	}

	return sess, nil
}

// KillSession kills the process for the given project and removes the session.
func (m *Manager) KillSession(projectID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	sess, ok := m.sessions[projectID]
	if !ok {
		return fmt.Errorf("no session for project %s", projectID)
	}

	err := sess.Close()
	delete(m.sessions, projectID)

	slog.Info("terminal session killed", "projectID", projectID, "sessionID", sess.ID)
	return err
}

// Resize changes the PTY window size for the given project's session.
func (m *Manager) Resize(projectID string, rows, cols uint16) error {
	m.mu.RLock()
	sess, ok := m.sessions[projectID]
	m.mu.RUnlock()

	if !ok {
		return fmt.Errorf("no session for project %s", projectID)
	}

	return pty.Setsize(sess.Pty, &pty.Winsize{
		Rows: rows,
		Cols: cols,
	})
}
