package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/services"
	"go.mongodb.org/mongo-driver/v2/bson"
)

type PlanHandler struct {
	planService *services.PlanService
}

func NewPlanHandler(ps *services.PlanService) *PlanHandler {
	return &PlanHandler{planService: ps}
}

func (h *PlanHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.List)
	r.Get("/{planId}", h.GetByID)
	r.Put("/{planId}/status", h.UpdateStatus)
	return r
}

func (h *PlanHandler) List(w http.ResponseWriter, r *http.Request) {
	projectID := r.URL.Query().Get("projectId")
	status := r.URL.Query().Get("status")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))

	if limit == 0 {
		limit = 50
	}

	plans, total, err := h.planService.List(r.Context(), projectID, status, limit, offset)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_FAILED")
		return
	}

	middleware.WriteJSON(w, http.StatusOK, map[string]interface{}{
		"plans":  plans,
		"total":  total,
		"limit":  limit,
		"offset": offset,
	})
}

func (h *PlanHandler) GetByID(w http.ResponseWriter, r *http.Request) {
	planID := chi.URLParam(r, "planId")
	oid, err := bson.ObjectIDFromHex(planID)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid plan id", "BAD_REQUEST")
		return
	}

	plan, err := h.planService.GetByID(r.Context(), oid)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "GET_FAILED")
		return
	}
	if plan == nil {
		middleware.WriteError(w, http.StatusNotFound, "plan not found", "NOT_FOUND")
		return
	}

	middleware.WriteJSON(w, http.StatusOK, plan)
}

func (h *PlanHandler) UpdateStatus(w http.ResponseWriter, r *http.Request) {
	planID := chi.URLParam(r, "planId")
	oid, err := bson.ObjectIDFromHex(planID)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid plan id", "BAD_REQUEST")
		return
	}

	var body struct {
		Status   string `json:"status"`
		Feedback string `json:"feedback,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Status == "" {
		middleware.WriteError(w, http.StatusBadRequest, "status is required", "BAD_REQUEST")
		return
	}

	valid := map[string]bool{"pending": true, "accepted": true, "rejected": true, "completed": true, "abandoned": true}
	if !valid[body.Status] {
		middleware.WriteError(w, http.StatusBadRequest, "invalid status", "BAD_REQUEST")
		return
	}

	if err := h.planService.UpdateStatus(r.Context(), oid, body.Status, body.Feedback); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "UPDATE_FAILED")
		return
	}

	middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
