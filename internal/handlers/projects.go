package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"
	"path/filepath"

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
	// RemoteProjectFetcher is set when delegation is active — fetches projects from remote
	RemoteProjectFetcher func(ctx context.Context, apiKey string) ([]models.Project, error)
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
	r.Get("/tags", h.ListAllTags)
	r.Get("/{id}", h.GetByID)
	r.Put("/{id}", h.Update)
	r.Delete("/{id}", h.Delete)
	r.Post("/{id}/archive", h.Archive)
	r.Post("/{id}/unarchive", h.Unarchive)
	r.Post("/{id}/snooze", h.Snooze)
	r.Post("/{id}/unsnooze", h.Unsnooze)
	r.Get("/{id}/dashboard", h.Dashboard)

	// Multi-module unit routes
	r.Get("/{id}/units", h.ListUnits)
	r.With(middleware.RequireSuperAdmin).Post("/{id}/units", h.AddUnit)
	r.With(middleware.RequireSuperAdmin).Post("/{id}/units/attach", h.AttachUnit)
	r.With(middleware.RequireSuperAdmin).Post("/{id}/units/{unitId}/detach", h.DetachUnit)
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
	memberCodes, err := h.memberService.ListProjectCodesForUser(r.Context(), user.ID)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_PROJECTS_FAILED")
		return
	}
	allowed := make(map[string]bool, len(memberCodes))
	for _, code := range memberCodes {
		allowed[code] = true
	}
	var filtered []models.Project
	for _, p := range projects {
		if allowed[p.Code] {
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

	proj, err := h.projectService.GetByID(r.Context(), id)
	if err != nil || proj == nil {
		middleware.WriteError(w, http.StatusNotFound, "project not found", "NOT_FOUND")
		return
	}

	if user.GlobalRole != models.GlobalRoleSuperAdmin && h.memberService != nil {
		role, err := h.memberService.GetRole(r.Context(), proj.Code, user.ID)
		if err != nil || role != models.ProjectRoleOwner {
			middleware.WriteError(w, http.StatusForbidden, "only project owners can archive projects", "FORBIDDEN")
			return
		}
	}

	projName := proj.Name + " (" + proj.Code + ")"

	if err := h.projectService.Archive(r.Context(), id); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "ARCHIVE_FAILED")
		return
	}
	if h.activityLogService != nil {
		h.activityLogService.LogAsyncWithUser("project_archived", "Archived project: "+projName, proj.Code, &user.ID, user.DisplayName, "", nil)
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

// Snooze sets a snooze-until time on a project, hiding it from rounds.
func (h *ProjectHandler) Snooze(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	proj, err := h.projectService.GetByID(r.Context(), id)
	if err != nil || proj == nil {
		middleware.WriteError(w, http.StatusNotFound, "project not found", "NOT_FOUND")
		return
	}
	var req struct {
		Until  string `json:"until"`
		Reason string `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Until == "" {
		middleware.WriteError(w, http.StatusBadRequest, "until is required (RFC3339)", "VALIDATION_ERROR")
		return
	}
	until, err := time.Parse(time.RFC3339, req.Until)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "until must be RFC3339", "VALIDATION_ERROR")
		return
	}
	if err := h.projectService.Snooze(r.Context(), proj.Code, until, req.Reason); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "SNOOZE_FAILED")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Unsnooze clears a project's snooze state.
func (h *ProjectHandler) Unsnooze(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	proj, err := h.projectService.GetByID(r.Context(), id)
	if err != nil || proj == nil {
		middleware.WriteError(w, http.StatusNotFound, "project not found", "NOT_FOUND")
		return
	}
	if err := h.projectService.Unsnooze(r.Context(), proj.Code); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "UNSNOOZE_FAILED")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Create decodes a CreateProjectRequest, validates it, and creates the project.
// For multi-module projects (projectType="multi" with units), creates parent + units.
// Requires super_admin (enforced by route middleware).
func (h *ProjectHandler) Create(w http.ResponseWriter, r *http.Request) {
	var req models.CreateProjectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "INVALID_BODY")
		return
	}

	// Multi-module project creation.
	if req.ProjectType == "multi" && len(req.Units) > 0 {
		parent, units, err := h.projectService.CreateMultiModule(r.Context(), &req)
		if err != nil {
			middleware.WriteError(w, http.StatusBadRequest, err.Error(), "CREATE_PROJECT_FAILED")
			return
		}
			// Scaffold directories and CLAUDE.md files in background.
		if parent.Links.LocalPath != "" {
			go scaffoldMultiModule(parent, units)
		}

		if h.activityLogService != nil {
			user := middleware.GetCurrentUser(r)
			var userID *bson.ObjectID
			userName := ""
			if user != nil { userID = &user.ID; userName = user.DisplayName }
			h.activityLogService.LogAsyncWithUser("project_created", "Created multi-module project: "+parent.Name+" ("+parent.Code+") with "+fmt.Sprintf("%d", len(units))+" units", parent.Code, userID, userName, "", nil)
		}
		middleware.WriteJSON(w, http.StatusCreated, map[string]interface{}{
			"parent": parent.MaskSecrets(),
			"units":  maskProjects(units),
		})
		return
	}

	project, err := h.projectService.Create(r.Context(), &req)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "CREATE_PROJECT_FAILED")
		return
	}
	if h.activityLogService != nil {
		user := middleware.GetCurrentUser(r)
		var userID *bson.ObjectID
		userName := ""
		if user != nil { userID = &user.ID; userName = user.DisplayName }
		h.activityLogService.LogAsyncWithUser("project_created", "Created project: "+project.Name+" ("+project.Code+")", project.Code, userID, userName, "", nil)
	}
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
		if u := middleware.GetCurrentUser(r); u != nil {
			h.activityLogService.LogAsyncWithUser("settings_change", "Updated settings for project: "+project.Name, project.Code, &u.ID, u.DisplayName, "", nil)
		} else {
			h.activityLogService.LogAsync("settings_change", "Updated settings for project: "+project.Name, project.Code, "", nil)
		}
	}

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

	// Look up project name for logging before deleting.
	proj, _ := h.projectService.GetByID(r.Context(), id)
	projName := id
	if proj != nil {
		projName = proj.Name + " (" + proj.Code + ")"
	}

	// Cascade: delete all issues for this project first.
	if err := h.issueService.DeleteAllByProject(r.Context(), id); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "DELETE_ISSUES_FAILED")
		return
	}

	if err := h.projectService.Delete(r.Context(), id); err != nil {
		middleware.WriteError(w, http.StatusNotFound, err.Error(), "DELETE_PROJECT_FAILED")
		return
	}
	if h.activityLogService != nil {
		projCode := ""
		if proj != nil {
			projCode = proj.Code
		}
		h.activityLogService.LogAsyncWithUser("project_deleted", "Permanently deleted project: "+projName, projCode, &user.ID, user.DisplayName, "", nil)
	}
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
	project, err := h.projectService.GetByID(r.Context(), id)
	if err != nil || project == nil {
		middleware.WriteError(w, http.StatusNotFound, "project not found", "PROJECT_NOT_FOUND")
		return
	}
	// Super admins have implicit owner access to all projects.
	if user.GlobalRole == models.GlobalRoleSuperAdmin {
		middleware.WriteJSON(w, http.StatusOK, map[string]string{"role": "owner", "projectId": id})
		return
	}
	role, err := h.memberService.GetRole(r.Context(), project.Code, user.ID)
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

	issuesByStatus, err := h.issueService.CountByProject(ctx, project.Code)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "COUNT_ISSUES_FAILED")
		return
	}

	issuesByPriority, err := h.issueService.CountByPriority(ctx, project.Code)
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
		pendingFeedbackCount, _ = h.feedbackService.CountPendingByProject(ctx, project.Code)
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

// ── Multi-module unit handlers ───────────────────────────────────────────────

// ListUnits returns all units for a multi-module project.
func (h *ProjectHandler) ListUnits(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid project ID", "INVALID_ID")
		return
	}
	units, err := h.projectService.ListUnits(r.Context(), oid)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_UNITS_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, maskProjects(units))
}

// AddUnit creates a new unit under a multi-module project.
func (h *ProjectHandler) AddUnit(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid project ID", "INVALID_ID")
		return
	}
	var unit models.UnitDefinition
	if err := json.NewDecoder(r.Body).Decode(&unit); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "INVALID_BODY")
		return
	}
	project, err := h.projectService.AddUnit(r.Context(), oid, unit)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "ADD_UNIT_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusCreated, project.MaskSecrets())
}

// DetachUnit removes the parent relationship, making the unit an independent project.
func (h *ProjectHandler) DetachUnit(w http.ResponseWriter, r *http.Request) {
	parentId := chi.URLParam(r, "id")
	unitId := chi.URLParam(r, "unitId")
	oid, err := bson.ObjectIDFromHex(unitId)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid unit ID", "INVALID_ID")
		return
	}
	if err := h.projectService.DetachUnit(r.Context(), oid); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "DETACH_UNIT_FAILED")
		return
	}
	// Regenerate CLAUDE.md in background
	go h.regenClaudeMdsForParent(parentId)
	w.WriteHeader(http.StatusNoContent)
}

// AttachUnit attaches an existing project as a unit of a multi-module project.
func (h *ProjectHandler) AttachUnit(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	parentOID, err := bson.ObjectIDFromHex(id)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid project ID", "INVALID_ID")
		return
	}
	var req struct {
		ProjectCode string `json:"projectCode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "INVALID_BODY")
		return
	}
	unitOID, err := bson.ObjectIDFromHex(req.ProjectCode)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid project ID", "INVALID_ID")
		return
	}
	project, err := h.projectService.AttachUnit(r.Context(), parentOID, unitOID)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "ATTACH_UNIT_FAILED")
		return
	}
	// Regenerate CLAUDE.md in background
	go h.regenClaudeMdsForParent(id)
	middleware.WriteJSON(w, http.StatusOK, project.MaskSecrets())
}

// regenClaudeMdsForParent fetches the parent project and its units, then rewrites all CLAUDE.md files.
func (h *ProjectHandler) regenClaudeMdsForParent(parentID string) {
	ctx := context.Background()
	parent, err := h.projectService.GetByID(ctx, parentID)
	if err != nil || parent == nil {
		return
	}
	units, err := h.projectService.ListUnits(ctx, parent.ID)
	if err != nil {
		return
	}
	regenerateClaudeMds(parent, units)
}

// scaffoldMultiModule creates directories and CLAUDE.md files for a new multi-module project.
func scaffoldMultiModule(parent *models.Project, units []models.Project) {
	rootPath := parent.Links.LocalPath

	// Create root directory.
	if err := os.MkdirAll(rootPath, 0o755); err != nil {
		slog.Error("scaffold: create root dir", "path", rootPath, "error", err)
		return
	}

	// Create unit directories.
	for _, u := range units {
		if u.UnitPath != "" {
			unitDir := filepath.Join(rootPath, u.UnitPath)
			if err := os.MkdirAll(unitDir, 0o755); err != nil {
				slog.Error("scaffold: create unit dir", "path", unitDir, "error", err)
			}
		}
	}

	// Generate orchestrator CLAUDE.md.
	orchMd := fmt.Sprintf("# %s — Orchestrator\n\n", parent.Name)
	orchMd += "You are the orchestrator for this multi-module project. Your job is to:\n"
	orchMd += "- Coordinate work across units and ensure coherence\n"
	orchMd += "- Prevent duplication and identify canonical implementations\n"
	orchMd += "- Resolve conflicts between modules\n"
	orchMd += "- Delegate tasks to the appropriate unit agent\n\n"
	orchMd += "## Units\n\n"
	orchMd += "| Unit | Code | Path | Description |\n"
	orchMd += "|------|------|------|-------------|\n"
	for _, u := range units {
		desc := u.Description
		if desc == "" {
			desc = "—"
		}
		orchMd += fmt.Sprintf("| %s | %s | `%s` | %s |\n", u.UnitName, u.Code, u.UnitPath, desc)
	}
	orchMd += "\nEach unit has its own CLAUDE.md with detailed context for that module.\n"

	if err := os.WriteFile(filepath.Join(rootPath, "CLAUDE.md"), []byte(orchMd), 0o644); err != nil {
		slog.Error("scaffold: write orchestrator CLAUDE.md", "error", err)
	}

	// Generate per-unit CLAUDE.md.
	for _, u := range units {
		if u.UnitPath == "" {
			continue
		}
		unitMd := fmt.Sprintf("# %s\n\n", u.UnitName)
		if u.Description != "" {
			unitMd += u.Description + "\n\n"
		}
		unitMd += fmt.Sprintf("This is a unit of the **%s** project.\n\n", parent.Name)
		unitMd += "## Sibling Units\n\n"
		for _, sibling := range units {
			if sibling.Code == u.Code {
				continue
			}
			unitMd += fmt.Sprintf("- **%s** (`%s`) — %s\n", sibling.UnitName, sibling.UnitPath, sibling.Description)
		}
		unitMd += fmt.Sprintf("\nThe orchestrator CLAUDE.md at the project root (`%s/CLAUDE.md`) coordinates cross-unit concerns.\n", rootPath)

		unitDir := filepath.Join(rootPath, u.UnitPath)
		if err := os.WriteFile(filepath.Join(unitDir, "CLAUDE.md"), []byte(unitMd), 0o644); err != nil {
			slog.Error("scaffold: write unit CLAUDE.md", "unit", u.Code, "error", err)
		}
	}

	slog.Info("scaffolded multi-module project", "path", rootPath, "units", len(units))
}

// regenerateClaudeMds rewrites CLAUDE.md files for a multi-module project after unit changes.
func regenerateClaudeMds(parent *models.Project, units []models.Project) {
	rootPath := parent.Links.LocalPath
	if rootPath == "" {
		return
	}

	// Rewrite orchestrator CLAUDE.md
	orchMd := fmt.Sprintf("# %s — Orchestrator\n\n", parent.Name)
	orchMd += "You are the orchestrator for this multi-module project. Your job is to:\n"
	orchMd += "- Coordinate work across units and ensure coherence\n"
	orchMd += "- Prevent duplication and identify canonical implementations\n"
	orchMd += "- Resolve conflicts between modules\n"
	orchMd += "- Delegate tasks to the appropriate unit agent\n\n"
	orchMd += "## Units\n\n"
	orchMd += "| Unit | Code | Path | Description |\n"
	orchMd += "|------|------|------|-------------|\n"
	for _, u := range units {
		desc := u.Description
		if desc == "" {
			desc = "—"
		}
		orchMd += fmt.Sprintf("| %s | %s | `%s` | %s |\n", u.UnitName, u.Code, u.UnitPath, desc)
	}
	orchMd += "\nEach unit has its own CLAUDE.md with detailed context for that module.\n"

	if err := os.WriteFile(filepath.Join(rootPath, "CLAUDE.md"), []byte(orchMd), 0o644); err != nil {
		slog.Error("regen: write orchestrator CLAUDE.md", "error", err)
	}

	// Rewrite per-unit CLAUDE.md
	for _, u := range units {
		if u.UnitPath == "" {
			continue
		}
		unitDir := filepath.Join(rootPath, u.UnitPath)
		os.MkdirAll(unitDir, 0o755)

		unitMd := fmt.Sprintf("# %s\n\n", u.UnitName)
		if u.Description != "" {
			unitMd += u.Description + "\n\n"
		}
		unitMd += fmt.Sprintf("This is a unit of the **%s** project.\n\n", parent.Name)
		unitMd += "## Sibling Units\n\n"
		for _, sibling := range units {
			if sibling.Code == u.Code {
				continue
			}
			unitMd += fmt.Sprintf("- **%s** (`%s`) — %s\n", sibling.UnitName, sibling.UnitPath, sibling.Description)
		}
		unitMd += fmt.Sprintf("\nThe orchestrator CLAUDE.md at the project root (`%s/CLAUDE.md`) coordinates cross-unit concerns.\n", rootPath)

		if err := os.WriteFile(filepath.Join(unitDir, "CLAUDE.md"), []byte(unitMd), 0o644); err != nil {
			slog.Error("regen: write unit CLAUDE.md", "unit", u.Code, "error", err)
		}
	}
	slog.Info("regenerated CLAUDE.md files", "path", rootPath, "units", len(units))
}

// ListStale handles GET /api/v1/projects/stale — returns projects with no recent prompts.
func (h *ProjectHandler) ListStale(w http.ResponseWriter, r *http.Request) {
	daysStr := r.URL.Query().Get("days")
	days := 7
	if daysStr != "" {
		fmt.Sscanf(daysStr, "%d", &days)
	}
	stale, err := h.projectService.ListStale(r.Context(), days, h.activityLogService)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_STALE_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, stale)
}

// SetInactive handles POST /api/v1/projects/{id}/set-inactive.
func (h *ProjectHandler) SetInactive(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	now := time.Now().UTC()
	_, err := h.projectService.Update(r.Context(), id, &models.UpdateProjectRequest{
		Inactive: boolPtr(true),
	})
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "UPDATE_FAILED")
		return
	}
	// Also set inactiveSince directly
	h.projectService.SetField(r.Context(), id, "inactiveSince", now)
	middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// SetActive handles POST /api/v1/projects/{id}/set-active.
func (h *ProjectHandler) SetActive(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	_, err := h.projectService.Update(r.Context(), id, &models.UpdateProjectRequest{
		Inactive: boolPtr(false),
	})
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "UPDATE_FAILED")
		return
	}
	h.projectService.SetField(r.Context(), id, "inactiveSince", nil)
	middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func boolPtr(b bool) *bool { return &b }

// ListAllTags handles GET /api/v1/projects/tags — returns all unique tags.
func (h *ProjectHandler) ListAllTags(w http.ResponseWriter, r *http.Request) {
	tags, err := h.projectService.ListAllTags(r.Context())
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_TAGS_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, tags)
}
