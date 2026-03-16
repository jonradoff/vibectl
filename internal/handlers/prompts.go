package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/services"
)

type PromptHandler struct {
	promptService      *services.PromptService
	activityLogService *services.ActivityLogService
}

func NewPromptHandler(ps *services.PromptService, als *services.ActivityLogService) *PromptHandler {
	return &PromptHandler{promptService: ps, activityLogService: als}
}

// ProjectPromptRoutes mounts under /api/v1/projects/{id}/prompts
func (h *PromptHandler) ProjectPromptRoutes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.ListByProject)
	r.Post("/", h.Create)
	return r
}

// PromptRoutes mounts under /api/v1/prompts
func (h *PromptHandler) PromptRoutes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.ListAll)
	r.Post("/", h.CreateGlobal) // POST /api/v1/prompts for global prompts
	r.Get("/{promptId}", h.GetByID)
	r.Put("/{promptId}", h.Update)
	r.Delete("/{promptId}", h.Delete)
	return r
}

func (h *PromptHandler) ListByProject(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	prompts, err := h.promptService.ListByProject(r.Context(), projectID)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, prompts)
}

func (h *PromptHandler) ListAll(w http.ResponseWriter, r *http.Request) {
	prompts, err := h.promptService.ListAll(r.Context())
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, prompts)
}

func (h *PromptHandler) Create(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	h.createPrompt(w, r, projectID)
}

func (h *PromptHandler) CreateGlobal(w http.ResponseWriter, r *http.Request) {
	h.createPrompt(w, r, "*")
}

func (h *PromptHandler) createPrompt(w http.ResponseWriter, r *http.Request, projectID string) {
	var req models.CreatePromptRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "INVALID_BODY")
		return
	}
	if req.Name == "" {
		middleware.WriteError(w, http.StatusBadRequest, "name is required", "MISSING_NAME")
		return
	}

	prompt, err := h.promptService.Create(r.Context(), projectID, &req)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "CREATE_FAILED")
		return
	}

	scope := "global"
	if !prompt.Global {
		scope = "project"
	}
	h.activityLogService.LogAsync("prompt_created", "Created "+scope+" prompt: "+prompt.Name, prompt.ProjectID, "", nil)

	middleware.WriteJSON(w, http.StatusCreated, prompt)
}

func (h *PromptHandler) GetByID(w http.ResponseWriter, r *http.Request) {
	promptID := chi.URLParam(r, "promptId")
	prompt, err := h.promptService.GetByID(r.Context(), promptID)
	if err != nil {
		middleware.WriteError(w, http.StatusNotFound, err.Error(), "NOT_FOUND")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, prompt)
}

func (h *PromptHandler) Update(w http.ResponseWriter, r *http.Request) {
	promptID := chi.URLParam(r, "promptId")
	var req models.UpdatePromptRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "INVALID_BODY")
		return
	}

	prompt, err := h.promptService.Update(r.Context(), promptID, &req)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "UPDATE_FAILED")
		return
	}

	h.activityLogService.LogAsync("prompt_edited", "Edited prompt: "+prompt.Name, prompt.ProjectID, "", nil)

	middleware.WriteJSON(w, http.StatusOK, prompt)
}

func (h *PromptHandler) Delete(w http.ResponseWriter, r *http.Request) {
	promptID := chi.URLParam(r, "promptId")

	// Fetch before delete for logging
	prompt, _ := h.promptService.GetByID(r.Context(), promptID)

	if err := h.promptService.Delete(r.Context(), promptID); err != nil {
		middleware.WriteError(w, http.StatusNotFound, err.Error(), "NOT_FOUND")
		return
	}

	if prompt != nil {
		h.activityLogService.LogAsync("prompt_deleted", "Deleted prompt: "+prompt.Name, prompt.ProjectID, "", nil)
	}

	w.WriteHeader(http.StatusNoContent)
}
