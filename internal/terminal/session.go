package terminal

import (
	"fmt"
	"time"
)

// Write sends data to the session's PTY.
func (s *TerminalSession) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.Pty == nil {
		return 0, fmt.Errorf("pty is closed")
	}

	s.LastActivity = time.Now()
	return s.Pty.Write(p)
}

// Read reads data directly from the session's PTY.
func (s *TerminalSession) Read(p []byte) (int, error) {
	if s.Pty == nil {
		return 0, fmt.Errorf("pty is closed")
	}

	return s.Pty.Read(p)
}

// Close kills the child process and closes the PTY file descriptor.
func (s *TerminalSession) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	var firstErr error

	if s.Cmd != nil && s.Cmd.Process != nil {
		if err := s.Cmd.Process.Kill(); err != nil {
			firstErr = fmt.Errorf("failed to kill process: %w", err)
		}
		// Reap the process to avoid zombies.
		_ = s.Cmd.Wait()
	}

	if s.Pty != nil {
		if err := s.Pty.Close(); err != nil && firstErr == nil {
			firstErr = fmt.Errorf("failed to close pty: %w", err)
		}
		s.Pty = nil
	}

	return firstErr
}

// IsAlive checks whether the child process is still running.
func (s *TerminalSession) IsAlive() bool {
	if s.Cmd == nil || s.Cmd.Process == nil {
		return false
	}

	// ProcessState is set after Wait returns. If it's nil, the process
	// hasn't exited yet (or Wait hasn't been called).
	return s.Cmd.ProcessState == nil
}

// UpdateActivity sets LastActivity to the current time.
func (s *TerminalSession) UpdateActivity() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.LastActivity = time.Now()
}
