package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/services"
)

type ChatHistoryHandler struct {
	chatHistoryService *services.ChatHistoryService
}

func NewChatHistoryHandler(chs *services.ChatHistoryService) *ChatHistoryHandler {
	return &ChatHistoryHandler{chatHistoryService: chs}
}

// ListByProject returns history summaries for a project (no messages).
func (h *ChatHistoryHandler) ListByProject(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")

	entries, err := h.chatHistoryService.ListByProject(r.Context(), projectID)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "CHAT_HISTORY_ERROR")
		return
	}

	middleware.WriteJSON(w, http.StatusOK, entries)
}

// GetByID returns a full history entry with messages.
func (h *ChatHistoryHandler) GetByID(w http.ResponseWriter, r *http.Request) {
	historyID := chi.URLParam(r, "historyId")

	entry, err := h.chatHistoryService.GetByID(r.Context(), historyID)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "INVALID_HISTORY_ID")
		return
	}
	if entry == nil {
		middleware.WriteError(w, http.StatusNotFound, "history entry not found", "HISTORY_NOT_FOUND")
		return
	}

	middleware.WriteJSON(w, http.StatusOK, entry)
}
