package terminal

import (
	"encoding/json"
	"log/slog"
	"sort"
	"time"
)

// SessionStat is a snapshot of one live session for the /session-stats endpoint.
type SessionStat struct {
	ProjectCode    string    `json:"projectCode"`
	SpawnID        string    `json:"spawnId"`
	ClaudeSession  string    `json:"claudeSessionId,omitempty"`
	StartedAt      time.Time `json:"startedAt"`
	LastActivity   time.Time `json:"lastActivity"`
	IdleSeconds    int64     `json:"idleSeconds"`
	Subscribers    int       `json:"subscribers"`
	PID            int       `json:"pid,omitempty"`
	ReapedForIdle  bool      `json:"reapedForIdle"`
	Committed      bool      `json:"committed"`
}

// SnapshotSessions returns a copy of the current session table for admin/UI use.
func (m *ChatManager) SnapshotSessions() []SessionStat {
	m.mu.RLock()
	sessions := make([]*ChatSession, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}
	m.mu.RUnlock()

	out := make([]SessionStat, 0, len(sessions))
	for _, s := range sessions {
		s.mu.Lock()
		la := s.lastActivity
		reaped := s.reapedForIdle
		committed := s.committed
		s.mu.Unlock()
		pid := 0
		if s.Cmd != nil && s.Cmd.Process != nil {
			pid = s.Cmd.Process.Pid
		}
		idle := int64(0)
		if !la.IsZero() {
			idle = int64(time.Since(la).Seconds())
		}
		out = append(out, SessionStat{
			ProjectCode:   s.ProjectCode,
			SpawnID:       s.ID,
			ClaudeSession: s.SessionID,
			StartedAt:     s.StartedAt,
			LastActivity:  la,
			IdleSeconds:   idle,
			Subscribers:   s.SubscriberCount(),
			PID:           pid,
			ReapedForIdle: reaped,
			Committed:     committed,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].IdleSeconds > out[j].IdleSeconds
	})
	return out
}

// reapCandidate is an internal helper for reap selection.
type reapCandidate struct {
	sess       *ChatSession
	idle       time.Duration
	subscribed bool
}

// StartIdleReaper launches a background goroutine that periodically checks
// each live session and SIGTERMs any whose Claude Code subprocess has been
// idle longer than m.IdleReapAfter with no attached subscribers. Returns
// immediately if IdleReapAfter <= 0.
//
// stop signals the reaper to exit.
func (m *ChatManager) StartIdleReaper(stop <-chan struct{}) {
	if m.IdleReapAfter <= 0 {
		slog.Info("idle-reaper disabled (IdleReapAfter <= 0)")
		return
	}
	// Check ~every 30s, but at least four times per idle window (so a
	// 20-min window checks every 5 min minimum).
	interval := m.IdleReapAfter / 4
	if interval > 30*time.Second {
		interval = 30 * time.Second
	}
	if interval < 10*time.Second {
		interval = 10 * time.Second
	}
	slog.Info("idle-reaper started",
		"idleReapAfter", m.IdleReapAfter,
		"checkInterval", interval,
		"maxActiveClaude", m.MaxActiveClaude)

	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				m.reapIdle()
			}
		}
	}()
}

// reapIdle scans all live sessions and reaps those exceeding the idle
// threshold with zero attached subscribers.
func (m *ChatManager) reapIdle() {
	candidates := m.gatherReapCandidates()
	for _, c := range candidates {
		if c.subscribed {
			continue
		}
		if c.idle < m.IdleReapAfter {
			continue
		}
		m.reapSession(c.sess, "idle-threshold")
	}
}

// gatherReapCandidates snapshots every live session with its idle time and
// subscriber state — used by both the periodic reaper and the concurrency-cap
// eviction path.
func (m *ChatManager) gatherReapCandidates() []reapCandidate {
	m.mu.RLock()
	all := make([]*ChatSession, 0, len(m.sessions))
	for _, s := range m.sessions {
		all = append(all, s)
	}
	m.mu.RUnlock()

	out := make([]reapCandidate, 0, len(all))
	for _, s := range all {
		if !s.IsAlive() {
			continue
		}
		out = append(out, reapCandidate{
			sess:       s,
			idle:       s.IdleFor(),
			subscribed: s.SubscriberCount() > 0,
		})
	}
	// Longest idle first — eviction picks from the top.
	sort.Slice(out, func(i, j int) bool { return out[i].idle > out[j].idle })
	return out
}

// reapSession marks the session as reaped, broadcasts a session_reaped event
// so the frontend can silently reset local state, and SIGTERMs the underlying
// process. The exit goroutine's suppression path checks reapedForIdle to
// avoid the misleading "Claude exited with error" system_error broadcast.
func (m *ChatManager) reapSession(s *ChatSession, reason string) {
	s.mu.Lock()
	if s.reapedForIdle {
		s.mu.Unlock()
		return // already reaped, nothing to do
	}
	s.reapedForIdle = true
	pid := 0
	if s.Cmd != nil && s.Cmd.Process != nil {
		pid = s.Cmd.Process.Pid
	}
	s.mu.Unlock()

	slog.Info("reaping idle chat session",
		"projectID", s.ProjectCode,
		"pid", pid,
		"reason", reason,
		"idleFor", s.IdleFor().String())

	// Tell any *late-attaching* subscriber the session was reaped so the
	// frontend can transparently kick a fresh spawn on the next user
	// message. Existing subscribers, if any, are also notified.
	evt := map[string]interface{}{
		"type": "session_reaped",
		"data": map[string]string{
			"reason":  reason,
			"message": "Session reaped to free memory. Sending a message will spawn a fresh one from your on-disk history.",
		},
	}
	if data, err := json.Marshal(evt); err == nil {
		s.broadcast(data)
	}

	if err := m.KillSession(s.ProjectCode); err != nil {
		slog.Warn("reap: KillSession failed", "projectID", s.ProjectCode, "error", err)
	}
}

// EnforceMaxActiveClaude reaps the longest-idle unsubscribed session(s) until
// the number of live sessions is below m.MaxActiveClaude. Called before every
// new spawn. No-op when MaxActiveClaude <= 0.
func (m *ChatManager) EnforceMaxActiveClaude() {
	if m.MaxActiveClaude <= 0 {
		return
	}
	for {
		candidates := m.gatherReapCandidates()
		if len(candidates) < m.MaxActiveClaude {
			return
		}
		// Reap the longest-idle unsubscribed session; if none are
		// unsubscribed, we can't safely reap and must let the spawn proceed
		// (better a hot machine than a broken UX for the user).
		reaped := false
		for _, c := range candidates {
			if !c.subscribed {
				m.reapSession(c.sess, "max-active-cap")
				reaped = true
				break
			}
		}
		if !reaped {
			slog.Warn("max-active-claude cap reached but every session has an active subscriber; allowing spawn",
				"max", m.MaxActiveClaude, "current", len(candidates))
			return
		}
	}
}
