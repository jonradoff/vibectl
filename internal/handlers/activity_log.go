package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/services"
)

type ActivityLogHandler struct {
	activityLogService *services.ActivityLogService
}

func NewActivityLogHandler(als *services.ActivityLogService) *ActivityLogHandler {
	return &ActivityLogHandler{activityLogService: als}
}

func (h *ActivityLogHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.List)
	return r
}

// PostActivity handles POST /api/v1/projects/{id}/activity.
// Allows client instances to log activity events to the remote server.
func (h *ActivityLogHandler) PostActivity(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	user := middleware.GetCurrentUser(r)

	var body struct {
		Type    string `json:"type"`
		Message string `json:"message"`
		Snippet string `json:"snippet,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Type == "" || body.Message == "" {
		middleware.WriteError(w, http.StatusBadRequest, "type and message are required", "BAD_REQUEST")
		return
	}

	if projectID == "" {
		middleware.WriteError(w, http.StatusBadRequest, "invalid project id", "BAD_REQUEST")
		return
	}

	if user != nil {
		h.activityLogService.LogAsyncWithUser(body.Type, body.Message, projectID, &user.ID, user.DisplayName, body.Snippet, nil)
	} else {
		h.activityLogService.LogAsync(body.Type, body.Message, projectID, body.Snippet, nil)
	}

	middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *ActivityLogHandler) List(w http.ResponseWriter, r *http.Request) {
	projectID := r.URL.Query().Get("projectId")
	logType := r.URL.Query().Get("type")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))

	if limit == 0 {
		limit = 50
	}

	entries, total, err := h.activityLogService.List(r.Context(), projectID, logType, limit, offset)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_FAILED")
		return
	}

	middleware.WriteJSON(w, http.StatusOK, map[string]interface{}{
		"entries": entries,
		"total":   total,
		"limit":   limit,
		"offset":  offset,
	})
}
