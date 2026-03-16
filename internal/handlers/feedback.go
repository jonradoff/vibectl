package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/agents"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/services"
)

type FeedbackHandler struct {
	feedbackService  *services.FeedbackService
	triageAgent      *agents.TriageAgent
	themesAgent      *agents.ThemesAgent
	decisionService  *services.DecisionService
	vibectlMdService *services.VibectlMdService
	projectService   *services.ProjectService
	webhookService   *services.WebhookService
}

func NewFeedbackHandler(fs *services.FeedbackService, ta *agents.TriageAgent, tha *agents.ThemesAgent, ds *services.DecisionService, vm *services.VibectlMdService, ps *services.ProjectService, ws *services.WebhookService) *FeedbackHandler {
	return &FeedbackHandler{feedbackService: fs, triageAgent: ta, themesAgent: tha, decisionService: ds, vibectlMdService: vm, projectService: ps, webhookService: ws}
}

// FeedbackRoutes returns a router mounted at /api/v1/feedback.
func (h *FeedbackHandler) FeedbackRoutes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.List)
	r.Post("/", h.Create)
	r.Post("/batch", h.CreateBatch)
	r.Post("/{id}/triage", h.TriggerTriage)
	r.Post("/triage-batch", h.TriggerTriageBatch)
	r.Patch("/{id}/review", h.Review)
	return r
}

// ProjectFeedbackRoutes returns a router mounted under /api/v1/projects/{id}/feedback.
func (h *FeedbackHandler) ProjectFeedbackRoutes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.ListByProject)
	return r
}

// List returns feedback items filtered by optional query params: projectId, triageStatus, sourceType.
func (h *FeedbackHandler) List(w http.ResponseWriter, r *http.Request) {
	filters := map[string]string{
		"projectId":    r.URL.Query().Get("projectId"),
		"triageStatus": r.URL.Query().Get("triageStatus"),
		"sourceType":   r.URL.Query().Get("sourceType"),
	}

	items, err := h.feedbackService.List(r.Context(), filters)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_FEEDBACK_ERROR")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, items)
}

// Create inserts a single feedback item.
func (h *FeedbackHandler) Create(w http.ResponseWriter, r *http.Request) {
	var req models.CreateFeedbackRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid JSON body", "INVALID_JSON")
		return
	}

	if req.RawContent == "" {
		middleware.WriteError(w, http.StatusBadRequest, "rawContent is required", "VALIDATION_ERROR")
		return
	}
	if req.SourceType == "" {
		middleware.WriteError(w, http.StatusBadRequest, "sourceType is required", "VALIDATION_ERROR")
		return
	}

	item, err := h.feedbackService.Create(r.Context(), &req)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "CREATE_FEEDBACK_ERROR")
		return
	}
	middleware.WriteJSON(w, http.StatusCreated, item)
}

// CreateBatch inserts multiple feedback items at once.
func (h *FeedbackHandler) CreateBatch(w http.ResponseWriter, r *http.Request) {
	var reqs []models.CreateFeedbackRequest
	if err := json.NewDecoder(r.Body).Decode(&reqs); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid JSON body", "INVALID_JSON")
		return
	}

	if len(reqs) == 0 {
		middleware.WriteError(w, http.StatusBadRequest, "batch must contain at least one item", "VALIDATION_ERROR")
		return
	}

	items, err := h.feedbackService.CreateBatch(r.Context(), reqs)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "CREATE_BATCH_ERROR")
		return
	}
	middleware.WriteJSON(w, http.StatusCreated, items)
}

// TriggerTriage initiates AI triage for a single feedback item.
func (h *FeedbackHandler) TriggerTriage(w http.ResponseWriter, r *http.Request) {
	if h.triageAgent == nil {
		middleware.WriteError(w, http.StatusServiceUnavailable, "ANTHROPIC_API_KEY not configured", "AGENT_UNAVAILABLE")
		return
	}

	id := chi.URLParam(r, "id")
	analysis, err := h.triageAgent.TriageItem(r.Context(), id)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "TRIAGE_ERROR")
		return
	}

	// Fire webhook after triage completes
	if h.webhookService != nil {
		go func() {
			ctx := context.Background()
			item, fetchErr := h.feedbackService.GetByID(ctx, id)
			if fetchErr == nil && item != nil && item.ProjectID != nil {
				h.webhookService.Fire(ctx, *item.ProjectID, models.WebhookEventFeedbackTriaged, map[string]any{
					"feedbackId": id,
				})
			}
		}()
	}

	middleware.WriteJSON(w, http.StatusOK, analysis)
}

// TriggerTriageBatch initiates AI triage for all pending feedback items.
func (h *FeedbackHandler) TriggerTriageBatch(w http.ResponseWriter, r *http.Request) {
	if h.triageAgent == nil {
		middleware.WriteError(w, http.StatusServiceUnavailable, "ANTHROPIC_API_KEY not configured", "AGENT_UNAVAILABLE")
		return
	}

	count, err := h.triageAgent.TriagePending(r.Context())
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "TRIAGE_BATCH_ERROR")
		return
	}

	// Async: analyze themes for projects that had feedback triaged
	if h.themesAgent != nil && count > 0 {
		go func() {
			ctx := context.Background()
			projects, _ := h.projectService.List(ctx)
			for _, p := range projects {
				themes, err := h.themesAgent.AnalyzeThemes(ctx, p.ID.Hex())
				if err != nil || len(themes) == 0 {
					continue
				}
				h.projectService.UpdateRecurringThemes(ctx, p.ID.Hex(), themes)
				h.vibectlMdService.UpdateSection(ctx, p.ID.Hex(), "themes")
			}
		}()
	}

	middleware.WriteJSON(w, http.StatusOK, map[string]int{"triaged": count})
}

// Review accepts or dismisses a feedback item.
func (h *FeedbackHandler) Review(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var req models.ReviewFeedbackRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid JSON body", "INVALID_JSON")
		return
	}

	if req.Action != "accept" && req.Action != "dismiss" {
		middleware.WriteError(w, http.StatusBadRequest, "action must be \"accept\" or \"dismiss\"", "VALIDATION_ERROR")
		return
	}

	item, err := h.feedbackService.Review(r.Context(), id, &req)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "REVIEW_FEEDBACK_ERROR")
		return
	}

	if item.ProjectID != nil {
		pid := *item.ProjectID
		go func() {
			ctx := context.Background()
			action := "feedback_accepted"
			summary := fmt.Sprintf("Accepted feedback #%s", id)
			sections := []string{"status", "focus", "decisions"}
			if req.Action == "dismiss" {
				action = "feedback_dismissed"
				summary = fmt.Sprintf("Dismissed feedback #%s", id)
				sections = []string{"decisions"}
			}
			h.decisionService.Record(ctx, pid, action, summary, "")
			h.vibectlMdService.UpdateSection(ctx, pid.Hex(), sections...)
		}()
	}

	middleware.WriteJSON(w, http.StatusOK, item)
}

// ListByProject returns all feedback items for the project identified by the URL param "id".
func (h *FeedbackHandler) ListByProject(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")

	items, err := h.feedbackService.ListByProject(r.Context(), projectID)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_FEEDBACK_ERROR")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, items)
}
