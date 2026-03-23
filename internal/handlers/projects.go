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

type ProjectHandler struct {
	projectService     *services.ProjectService
	issueService       *services.IssueService
	sessionService     *services.SessionService
	feedbackService    *services.FeedbackService
	activityLogService *services.ActivityLogService
	memberService      *services.ProjectMemberService
	bus                *events.Bus
}

func NewProjectHandler(
	ps *services.ProjectService,
	is *services.IssueService,
	ss *services.SessionService,
	fs *services.FeedbackService,
	als *services.ActivityLogService,
	ms *services.ProjectMemberService,
	bus *events.Bus,
) *ProjectHandler {
	return &ProjectHandler{
		projectService:     ps,
		issueService:       is,
		sessionService:     ss,
		feedbackService:    fs,
		activityLogService: als,
		memberService:      ms,
		bus:                bus,
	}
}

// Routes returns a chi.Router with project CRUD and dashboard routes.
func (h *ProjectHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.List)
	r.With(middleware.RequireSuperAdmin).Post("/", h.Create)
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

// maskProjects returns the slice with webhook secrets redacted.
func maskProjects(projects []models.Project) []models.Project {
	out := make([]models.Project, len(projects))
	for i, p := range projects {
		out[i] = *p.MaskSecrets()
	}
	return out
}

// List returns projects the current user has access to.
// Super admins see all projects; members see only projects they belong to.
func (h *ProjectHandler) List(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetCurrentUser(r)

	projects, err := h.projectService.List(r.Context())
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_PROJECTS_FAILED")
		return
	}

	// Super admins see everything.
	if user == nil || user.GlobalRole == models.GlobalRoleSuperAdmin {
		middleware.WriteJSON(w, http.StatusOK, maskProjects(projects))
		return
	}

	// Filter to projects where the user is a member.
	memberIDs, err := h.memberService.ListProjectIDsForUser(r.Context(), user.ID)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_PROJECTS_FAILED")
		return
	}
	allowed := make(map[string]bool, len(memberIDs))
	for _, id := range memberIDs {
		allowed[id.Hex()] = true
	}
	var filtered []models.Project
	for _, p := range projects {
		if allowed[p.ID.Hex()] {
			filtered = append(filtered, p)
		}
	}
	if filtered == nil {
		filtered = []models.Project{}
	}
	middleware.WriteJSON(w, http.StatusOK, maskProjects(filtered))
}

// ListArchived returns all archived projects.
func (h *ProjectHandler) ListArchived(w http.ResponseWriter, r *http.Request) {
	projects, err := h.projectService.ListArchived(r.Context())
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_ARCHIVED_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, maskProjects(projects))
}

// Archive marks a project as archived. Requires owner or super_admin.
func (h *ProjectHandler) Archive(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	user := middleware.GetCurrentUser(r)
	if user == nil {
		middleware.WriteError(w, http.StatusUnauthorized, "not authenticated", "UNAUTHORIZED")
		return
	}

	if user.GlobalRole != models.GlobalRoleSuperAdmin && h.memberService != nil {
		projectObjID, err := h.projectService.GetByID(r.Context(), id)
		if err != nil || projectObjID == nil {
			middleware.WriteError(w, http.StatusNotFound, "project not found", "NOT_FOUND")
			return
		}
		role, err := h.memberService.GetRole(r.Context(), projectObjID.ID, user.ID)
		if err != nil || role != models.ProjectRoleOwner {
			middleware.WriteError(w, http.StatusForbidden, "only project owners can archive projects", "FORBIDDEN")
			return
		}
	}

	if err := h.projectService.Archive(r.Context(), id); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "ARCHIVE_FAILED")
		return
	}
	h.bus.Publish(events.Event{Type: "project.updated", ProjectID: id})
	w.WriteHeader(http.StatusNoContent)
}

// Unarchive restores an archived project.
func (h *ProjectHandler) Unarchive(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.projectService.Unarchive(r.Context(), id); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "UNARCHIVE_FAILED")
		return
	}
	h.bus.Publish(events.Event{Type: "project.updated", ProjectID: id})
	w.WriteHeader(http.StatusNoContent)
}

// Create decodes a CreateProjectRequest, validates it, and creates the project.
// Requires super_admin (enforced by route middleware).
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
	h.bus.Publish(events.Event{Type: "project.created", ProjectID: project.ID.Hex()})
	middleware.WriteJSON(w, http.StatusCreated, project.MaskSecrets())
}

// GetByID retrieves a project by its ObjectID.
func (h *ProjectHandler) GetByID(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	project, err := h.projectService.GetByID(r.Context(), id)
	if err != nil {
		middleware.WriteError(w, http.StatusNotFound, err.Error(), "PROJECT_NOT_FOUND")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, project.MaskSecrets())
}

// GetByCode retrieves a project by its unique code.
func (h *ProjectHandler) GetByCode(w http.ResponseWriter, r *http.Request) {
	code := chi.URLParam(r, "code")
	project, err := h.projectService.GetByCode(r.Context(), code)
	if err != nil {
		middleware.WriteError(w, http.StatusNotFound, err.Error(), "PROJECT_NOT_FOUND")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, project.MaskSecrets())
}

// Update applies partial updates to a project.
func (h *ProjectHandler) Update(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var req models.UpdateProjectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "INVALID_BODY")
		return
	}

	// Validate webhook URLs for SSRF (block private/loopback ranges)
	if req.Webhooks != nil {
		for _, wh := range *req.Webhooks {
			if wh.URL != "" {
				if err := services.ValidateWebhookURL(wh.URL); err != nil {
					middleware.WriteError(w, http.StatusBadRequest, err.Error(), "INVALID_WEBHOOK_URL")
					return
				}
			}
		}
	}

	project, err := h.projectService.Update(r.Context(), id, &req)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "UPDATE_PROJECT_FAILED")
		return
	}

	if h.activityLogService != nil {
		pid := project.ID
		if u := middleware.GetCurrentUser(r); u != nil {
			h.activityLogService.LogAsyncWithUser("settings_change", "Updated settings for project: "+project.Name, &pid, &u.ID, u.DisplayName, "", nil)
		} else {
			h.activityLogService.LogAsync("settings_change", "Updated settings for project: "+project.Name, &pid, "", nil)
		}
	}

	h.bus.Publish(events.Event{Type: "project.updated", ProjectID: project.ID.Hex()})
	middleware.WriteJSON(w, http.StatusOK, project.MaskSecrets())
}

// Delete permanently removes a project and all its associated issues.
// Only super_admin may permanently delete a project.
func (h *ProjectHandler) Delete(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetCurrentUser(r)
	if user == nil || user.GlobalRole != "super_admin" {
		middleware.WriteError(w, http.StatusForbidden, "only super_admin can permanently delete projects", "FORBIDDEN")
		return
	}

	id := chi.URLParam(r, "id")

	// Cascade: delete all issues for this project first.
	if err := h.issueService.DeleteAllByProject(r.Context(), id); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "DELETE_ISSUES_FAILED")
		return
	}

	if err := h.projectService.Delete(r.Context(), id); err != nil {
		middleware.WriteError(w, http.StatusNotFound, err.Error(), "DELETE_PROJECT_FAILED")
		return
	}
	h.bus.Publish(events.Event{Type: "project.deleted", ProjectID: id})
	w.WriteHeader(http.StatusNoContent)
}

// MyRole handles GET /api/v1/projects/{id}/my-role.
// Returns the current user's role for the given project.
func (h *ProjectHandler) MyRole(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetCurrentUser(r)
	if user == nil {
		middleware.WriteError(w, http.StatusUnauthorized, "not authenticated", "UNAUTHORIZED")
		return
	}
	id := chi.URLParam(r, "id")
	pid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid project id", "BAD_REQUEST")
		return
	}
	// Super admins have implicit owner access to all projects.
	if user.GlobalRole == models.GlobalRoleSuperAdmin {
		middleware.WriteJSON(w, http.StatusOK, map[string]string{"role": "owner", "projectId": id})
		return
	}
	role, err := h.memberService.GetRole(r.Context(), pid, user.ID)
	if err != nil {
		// Not a member
		middleware.WriteJSON(w, http.StatusOK, map[string]string{"role": "none", "projectId": id})
		return
	}
	middleware.WriteJSON(w, http.StatusOK, map[string]string{"role": string(role), "projectId": id})
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

	pendingFeedbackCount := 0
	if h.feedbackService != nil {
		pendingFeedbackCount, _ = h.feedbackService.CountPendingByProject(ctx, project.ID)
	}

	summary := models.ProjectSummary{
		Project:              *project,
		OpenIssueCount:       openCount,
		IssuesByPriority:     issuesByPriority,
		IssuesByStatus:       issuesByStatus,
		IssuesByType:         issuesByType,
		LastSession:          lastSession,
		PendingFeedbackCount: pendingFeedbackCount,
	}

	middleware.WriteJSON(w, http.StatusOK, summary)
}
