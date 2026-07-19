package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/services"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// ChatSessionHandler exposes chat session state endpoints so client-mode instances
// can persist and resume sessions against the remote server.
type ChatSessionHandler struct {
	svc *services.ChatSessionService
	chs *services.ChatHistoryService
	// ResetSession is an optional hook that performs a user-initiated hard
	// reset: kill the Claude Code subprocess (as a reap so the frontend
	// silently remounts), then clear the persisted claudeSessionId. Wired
	// to chatManager.ResetSession in cmd/server/main.go.
	ResetSession func(projectID string) error
	// KillLiveSession is an optional hook that terminates a running
	// subprocess WITHOUT writing anything to the DB. Used by Adopt so the
	// just-written claudeSessionId isn't clobbered by MarkDead. Wired to
	// chatManager.KillLiveSession in cmd/server/main.go.
	KillLiveSession func(projectID string) error
}

func NewChatSessionHandler(svc *services.ChatSessionService, chs *services.ChatHistoryService) *ChatSessionHandler {
	return &ChatSessionHandler{svc: svc, chs: chs}
}

// Routes mounts under /projects/{id}/chat-session/
func (h *ChatSessionHandler) Routes() func(chi.Router) {
	return func(r chi.Router) {
		r.Post("/upsert", h.Upsert)
		r.Post("/mark-resumable", h.MarkResumable)
		r.Post("/mark-dead", h.MarkDead)
		r.Get("/resumable", h.GetResumable)
		r.Post("/archive", h.Archive)
		r.Post("/reset", h.Reset)
		r.Post("/adopt", h.Adopt)
	}
}

// Adopt points the project's chat_sessions doc at an existing Claude Code
// session ID so the next launch resumes THAT session. Used by the Session
// History "Resume this session" button — restores an archived conversation
// (from chat_history) or an orphaned on-disk JSONL (post-credit-exhaustion,
// post-account-swap, etc.) without a mongosh escape hatch.
//
// Also tears down any currently-running Claude Code process for this
// project so the frontend's next chat_launch takes the resume path
// cleanly instead of reconnecting to whatever session was live.
func (h *ChatSessionHandler) Adopt(w http.ResponseWriter, r *http.Request) {
	projectCode := chi.URLParam(r, "id")
	var req struct {
		ClaudeSessionID string `json:"claudeSessionId"`
		LocalPath       string `json:"localPath"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "BAD_REQUEST")
		return
	}
	if req.ClaudeSessionID == "" || req.LocalPath == "" {
		middleware.WriteError(w, http.StatusBadRequest, "claudeSessionId and localPath are required", "BAD_REQUEST")
		return
	}
	if err := h.svc.AdoptSession(r.Context(), projectCode, req.ClaudeSessionID, req.LocalPath); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "ADOPT_ERROR")
		return
	}
	// Kill any live process for this project — ResetSession does the reap
	// with the right suppress-system_error / broadcast-session_reaped
	// wiring, but we do NOT want its SetNoResume side effect (that would
	// undo the adoption we just wrote). Use KillLiveSession which the
	// hook wires to ChatManager.KillLiveSession — kill only, no DB write.
	if h.KillLiveSession != nil {
		_ = h.KillLiveSession(projectCode)
	}
	w.WriteHeader(http.StatusNoContent)
}

// Reset performs a hard reset: kills the running Claude Code subprocess (if
// any) and clears the persisted claudeSessionId so the next launch spawns a
// truly fresh session with no --resume. Used for cases where the terminal is
// stuck (permissions issue, MCP glitch, etc.) and the user just wants to
// start over. The on-disk conversation log survives, so history remains
// browsable in the Session History tab.
func (h *ChatSessionHandler) Reset(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")

	// The manager's ResetSession does both parts (kill + clear) with the
	// right suppress-system_error / broadcast-session_reaped semantics. If
	// the hook isn't wired (should never happen in prod), fall back to
	// clearing DB state so the next launch is at least free of stale IDs.
	if h.ResetSession != nil {
		if err := h.ResetSession(projectID); err != nil {
			middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "RESET_ERROR")
			return
		}
	} else if err := h.svc.ClearSession(r.Context(), projectID); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "RESET_ERROR")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type upsertRequest struct {
	ClaudeSessionID string            `json:"claudeSessionId"`
	LocalPath       string            `json:"localPath"`
	Messages        []json.RawMessage `json:"messages"`
}

func (h *ChatSessionHandler) Upsert(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	var req upsertRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "BAD_REQUEST")
		return
	}
	if err := h.svc.Upsert(r.Context(), projectID, req.ClaudeSessionID, req.LocalPath, req.Messages); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "UPSERT_ERROR")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *ChatSessionHandler) MarkResumable(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	if err := h.svc.MarkResumable(r.Context(), projectID); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "MARK_ERROR")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *ChatSessionHandler) MarkDead(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	if err := h.svc.MarkDead(r.Context(), projectID); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "MARK_ERROR")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *ChatSessionHandler) GetResumable(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	state, err := h.svc.GetResumable(r.Context(), projectID)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "GET_ERROR")
		return
	}
	if state == nil {
		middleware.WriteJSON(w, http.StatusOK, nil)
		return
	}
	middleware.WriteJSON(w, http.StatusOK, state)
}

type archiveRequest struct {
	ClaudeSessionID string            `json:"claudeSessionId"`
	Messages        []json.RawMessage `json:"messages"`
	StartedAt       string            `json:"startedAt"` // RFC3339
}

func (h *ChatSessionHandler) Archive(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	var req archiveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "BAD_REQUEST")
		return
	}

	startedAt, err := time.Parse(time.RFC3339, req.StartedAt)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid startedAt: "+err.Error(), "BAD_REQUEST")
		return
	}

	// Extract user from auth context for attribution
	var userID *bson.ObjectID
	var userName string
	if u := middleware.GetCurrentUser(r); u != nil {
		userID = &u.ID
		userName = u.DisplayName
	}

	if err := h.chs.Archive(r.Context(), projectID, req.ClaudeSessionID, req.Messages, startedAt, userID, userName); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "ARCHIVE_ERROR")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
