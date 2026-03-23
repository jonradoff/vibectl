package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/services"
)

// ChatSessionHandler exposes chat session state endpoints so client-mode instances
// can persist and resume sessions against the remote server.
type ChatSessionHandler struct {
	svc *services.ChatSessionService
	chs *services.ChatHistoryService
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
	}
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

	if err := h.chs.Archive(r.Context(), projectID, req.ClaudeSessionID, req.Messages, startedAt); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "ARCHIVE_ERROR")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
