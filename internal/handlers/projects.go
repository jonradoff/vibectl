package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/services"
)

type ProjectHandler struct {
	projectService     *services.ProjectService
	issueService       *services.IssueService
	sessionService     *services.SessionService
	feedbackService    *services.FeedbackService
	activityLogService *services.ActivityLogService
}

func NewProjectHandler(
	ps *services.ProjectService,
	is *services.IssueService,
	ss *services.SessionService,
	fs *services.FeedbackService,
	als *services.ActivityLogService,
) *ProjectHandler {
	return &ProjectHandler{
		projectService:     ps,
		issueService:       is,
		sessionService:     ss,
		feedbackService:    fs,
		activityLogService: als,
	}
}

// Routes returns a chi.Router with project CRUD and dashboard routes.
func (h *ProjectHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.List)
	r.Post("/", h.Create)
	r.Get("/archived", h.ListArchived)
	r.Get("/{id}", h.GetByID)
	r.Put("/{id}", h.Update)
	r.Delete("/{id}", h.Delete)
	r.Post("/{id}/archive", h.Archive)
	r.Post("/{id}/unarchive", h.Unarchive)
	r.Get("/{id}/dashboard", h.Dashboard)
	return r
}

// CodeRoutes returns a chi.Router for looking up projects by code.
func (h *ProjectHandler) CodeRoutes() chi.Router {
	r := chi.NewRouter()
	r.Get("/{code}", h.GetByCode)
	return r
}

// List returns all projects as a JSON array.
func (h *ProjectHandler) List(w http.ResponseWriter, r *http.Request) {
	projects, err := h.projectService.List(r.Context())
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_PROJECTS_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, projects)
}

// ListArchived returns all archived projects.
func (h *ProjectHandler) ListArchived(w http.ResponseWriter, r *http.Request) {
	projects, err := h.projectService.ListArchived(r.Context())
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_ARCHIVED_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, projects)
}

// Archive marks a project as archived.
func (h *ProjectHandler) Archive(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.projectService.Archive(r.Context(), id); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "ARCHIVE_FAILED")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Unarchive restores an archived project.
func (h *ProjectHandler) Unarchive(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.projectService.Unarchive(r.Context(), id); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "UNARCHIVE_FAILED")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Create decodes a CreateProjectRequest, validates it, and creates the project.
func (h *ProjectHandler) Create(w http.ResponseWriter, r *http.Request) {
	var req models.CreateProjectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "INVALID_BODY")
		return
	}

	project, err := h.projectService.Create(r.Context(), &req)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "CREATE_PROJECT_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusCreated, project)
}

// GetByID retrieves a project by its ObjectID.
func (h *ProjectHandler) GetByID(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	project, err := h.projectService.GetByID(r.Context(), id)
	if err != nil {
		middleware.WriteError(w, http.StatusNotFound, err.Error(), "PROJECT_NOT_FOUND")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, project)
}

// GetByCode retrieves a project by its unique code.
func (h *ProjectHandler) GetByCode(w http.ResponseWriter, r *http.Request) {
	code := chi.URLParam(r, "code")
	project, err := h.projectService.GetByCode(r.Context(), code)
	if err != nil {
		middleware.WriteError(w, http.StatusNotFound, err.Error(), "PROJECT_NOT_FOUND")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, project)
}

// Update applies partial updates to a project.
func (h *ProjectHandler) Update(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var req models.UpdateProjectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "INVALID_BODY")
		return
	}

	project, err := h.projectService.Update(r.Context(), id, &req)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "UPDATE_PROJECT_FAILED")
		return
	}

	if h.activityLogService != nil {
		pid := project.ID
		h.activityLogService.LogAsync("settings_change", "Updated settings for project: "+project.Name, &pid, "", nil)
	}

	middleware.WriteJSON(w, http.StatusOK, project)
}

// Delete removes a project by ID.
func (h *ProjectHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.projectService.Delete(r.Context(), id); err != nil {
		middleware.WriteError(w, http.StatusNotFound, err.Error(), "DELETE_PROJECT_FAILED")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Dashboard returns a ProjectSummary with issue counts and last session for a project.
func (h *ProjectHandler) Dashboard(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	ctx := r.Context()

	project, err := h.projectService.GetByID(ctx, id)
	if err != nil {
		middleware.WriteError(w, http.StatusNotFound, err.Error(), "PROJECT_NOT_FOUND")
		return
	}

	issuesByStatus, err := h.issueService.CountByProject(ctx, project.ID)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "COUNT_ISSUES_FAILED")
		return
	}

	issuesByPriority, err := h.issueService.CountByPriority(ctx, project.ID)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "COUNT_ISSUES_FAILED")
		return
	}

	// Compute issues by type from the full issue list.
	issues, err := h.issueService.ListByProject(ctx, id, nil)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_ISSUES_FAILED")
		return
	}
	issuesByType := make(map[string]int)
	openCount := 0
	for _, issue := range issues {
		issuesByType[string(issue.Type)]++
		if issue.Status == "open" {
			openCount++
		}
	}

	var lastSession *models.SessionLog
	session, err := h.sessionService.GetLatest(ctx, id)
	if err == nil {
		lastSession = session
	}

	summary := models.ProjectSummary{
		Project:          *project,
		OpenIssueCount:   openCount,
		IssuesByPriority: issuesByPriority,
		IssuesByStatus:   issuesByStatus,
		IssuesByType:     issuesByType,
		LastSession:      lastSession,
	}

	middleware.WriteJSON(w, http.StatusOK, summary)
}
