package handlers

import (
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
