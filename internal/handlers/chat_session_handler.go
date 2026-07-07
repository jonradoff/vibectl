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
	}
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
