package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/events"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/services"
	"go.mongodb.org/mongo-driver/v2/bson"
)

type PromptHandler struct {
	promptService      *services.PromptService
	activityLogService *services.ActivityLogService
	memberService      *services.ProjectMemberService
	bus                *events.Bus
}

func NewPromptHandler(ps *services.PromptService, als *services.ActivityLogService, ms *services.ProjectMemberService, bus *events.Bus) *PromptHandler {
	return &PromptHandler{promptService: ps, activityLogService: als, memberService: ms, bus: bus}
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
	var userID *bson.ObjectID
	if u := middleware.GetCurrentUser(r); u != nil {
		userID = &u.ID
	}
	prompts, err := h.promptService.ListByProject(r.Context(), projectID, userID)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, prompts)
}

func (h *PromptHandler) ListAll(w http.ResponseWriter, r *http.Request) {
	var userID *bson.ObjectID
	if u := middleware.GetCurrentUser(r); u != nil {
		userID = &u.ID
	}
	prompts, err := h.promptService.ListAll(r.Context(), userID)
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

	u := middleware.GetCurrentUser(r)
	var userID *bson.ObjectID
	var userName string
	if u != nil {
		userID = &u.ID
		userName = u.DisplayName
	}

	// Role checks for shared prompts
	if req.Shared {
		if projectID == "*" || projectID == "" {
			// Global shared prompt requires super_admin
			if u == nil || u.GlobalRole != models.GlobalRoleSuperAdmin {
				middleware.WriteError(w, http.StatusForbidden, "only super_admin can create shared global prompts", "FORBIDDEN")
				return
			}
		} else if h.memberService != nil && u != nil {
			// Project shared prompt requires project owner role
			pid, err := bson.ObjectIDFromHex(projectID)
			if err == nil {
				hasOwner, _ := h.memberService.HasRole(r.Context(), pid, u.ID, models.ProjectRoleOwner)
				if !hasOwner && u.GlobalRole != models.GlobalRoleSuperAdmin {
					middleware.WriteError(w, http.StatusForbidden, "only project owners can create shared project prompts", "FORBIDDEN")
					return
				}
			}
		}
	}

	prompt, err := h.promptService.Create(r.Context(), projectID, &req, userID, userName)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "CREATE_FAILED")
		return
	}

	scope := "global"
	if !prompt.Global {
		scope = "project"
	}
	if u != nil {
		h.activityLogService.LogAsyncWithUser("prompt_created", "Created "+scope+" prompt: "+prompt.Name, prompt.ProjectID, &u.ID, u.DisplayName, "", nil)
	} else {
		h.activityLogService.LogAsync("prompt_created", "Created "+scope+" prompt: "+prompt.Name, prompt.ProjectID, "", nil)
	}

	pid := ""
	if prompt.ProjectID != nil {
		pid = prompt.ProjectID.Hex()
	}
	h.bus.Publish(events.Event{Type: "prompt.created", ProjectID: pid})
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

	// Ownership check: only creator or super_admin can edit
	u := middleware.GetCurrentUser(r)
	existing, err := h.promptService.GetByID(r.Context(), promptID)
	if err != nil {
		middleware.WriteError(w, http.StatusNotFound, err.Error(), "NOT_FOUND")
		return
	}
	if existing.CreatedBy != nil && u != nil && *existing.CreatedBy != u.ID && u.GlobalRole != models.GlobalRoleSuperAdmin {
		middleware.WriteError(w, http.StatusForbidden, "only the creator can edit this prompt", "FORBIDDEN")
		return
	}

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

	if u != nil {
		h.activityLogService.LogAsyncWithUser("prompt_edited", "Edited prompt: "+prompt.Name, prompt.ProjectID, &u.ID, u.DisplayName, "", nil)
	} else {
		h.activityLogService.LogAsync("prompt_edited", "Edited prompt: "+prompt.Name, prompt.ProjectID, "", nil)
	}

	pid := ""
	if prompt.ProjectID != nil {
		pid = prompt.ProjectID.Hex()
	}
	h.bus.Publish(events.Event{Type: "prompt.updated", ProjectID: pid})
	middleware.WriteJSON(w, http.StatusOK, prompt)
}

func (h *PromptHandler) Delete(w http.ResponseWriter, r *http.Request) {
	promptID := chi.URLParam(r, "promptId")

	// Ownership check: only creator or super_admin can delete
	u := middleware.GetCurrentUser(r)
	existing, _ := h.promptService.GetByID(r.Context(), promptID)
	if existing != nil && existing.CreatedBy != nil && u != nil && *existing.CreatedBy != u.ID && u.GlobalRole != models.GlobalRoleSuperAdmin {
		middleware.WriteError(w, http.StatusForbidden, "only the creator can delete this prompt", "FORBIDDEN")
		return
	}

	if err := h.promptService.Delete(r.Context(), promptID); err != nil {
		middleware.WriteError(w, http.StatusNotFound, err.Error(), "NOT_FOUND")
		return
	}

	if existing != nil {
		pid := ""
		if existing.ProjectID != nil {
			pid = existing.ProjectID.Hex()
		}
		h.bus.Publish(events.Event{Type: "prompt.deleted", ProjectID: pid})
		if u != nil {
			h.activityLogService.LogAsyncWithUser("prompt_deleted", "Deleted prompt: "+existing.Name, existing.ProjectID, &u.ID, u.DisplayName, "", nil)
		} else {
			h.activityLogService.LogAsync("prompt_deleted", "Deleted prompt: "+existing.Name, existing.ProjectID, "", nil)
		}
	}

	w.WriteHeader(http.StatusNoContent)
}
