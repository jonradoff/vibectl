package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/jonradoff/vibectl/internal/events"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/services"
)

// IssueHandler handles HTTP requests for issue operations.
type IssueHandler struct {
	issueService       *services.IssueService
	decisionService    *services.DecisionService
	vibectlMdService   *services.VibectlMdService
	activityLogService *services.ActivityLogService
	commentService     *services.CommentService
	webhookService     *services.WebhookService
	projectService     *services.ProjectService
	bus                *events.Bus
}

// NewIssueHandler creates a new IssueHandler.
func NewIssueHandler(is *services.IssueService, ds *services.DecisionService, vm *services.VibectlMdService, als *services.ActivityLogService, cs *services.CommentService, ws *services.WebhookService, ps *services.ProjectService, bus *events.Bus) *IssueHandler {
	return &IssueHandler{issueService: is, decisionService: ds, vibectlMdService: vm, activityLogService: als, commentService: cs, webhookService: ws, projectService: ps, bus: bus}
}

// ProjectIssueRoutes returns a chi.Router for project-scoped issue endpoints.
// Mounted under /api/v1/projects/{id}/issues.
func (h *IssueHandler) ProjectIssueRoutes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.ListByProject)
	r.Post("/", h.Create)
	return r
}

// IssueRoutes returns a chi.Router for top-level issue endpoints.
// Mounted at /api/v1/issues.
func (h *IssueHandler) IssueRoutes() chi.Router {
	r := chi.NewRouter()
	r.Get("/search", h.Search)
	r.Get("/{issueKey}", h.GetByKey)
	r.Put("/{issueKey}", h.Update)
	r.Patch("/{issueKey}/status", h.TransitionStatus)
	r.Delete("/{issueKey}", h.Delete)
	r.Post("/{issueKey}/restore", h.Restore)
	r.Delete("/{issueKey}/permanent", h.PermanentDelete)
	r.Get("/{issueKey}/comments", h.ListComments)
	r.Post("/{issueKey}/comments", h.CreateComment)
	r.Delete("/{issueKey}/comments/{commentId}", h.DeleteComment)
	return r
}

// ProjectArchivedIssueRoutes returns routes for listing archived issues per project.
func (h *IssueHandler) ProjectArchivedIssueRoutes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.ListArchived)
	return r
}

// ListByProject returns issues for a project with optional filters.
func (h *IssueHandler) ListByProject(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")

	project, err := h.projectService.GetByID(r.Context(), projectID)
	if err != nil || project == nil {
		project, err = h.projectService.GetByCode(r.Context(), projectID)
	}
	if err != nil || project == nil {
		middleware.WriteError(w, http.StatusNotFound, "project not found", "PROJECT_NOT_FOUND")
		return
	}

	filters := map[string]string{}
	if v := r.URL.Query().Get("type"); v != "" {
		filters["type"] = v
	}
	if v := r.URL.Query().Get("priority"); v != "" {
		filters["priority"] = v
	}
	if v := r.URL.Query().Get("status"); v != "" {
		filters["status"] = v
	}

	issues, err := h.issueService.ListByProject(r.Context(), project.Code, filters)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_FAILED")
		return
	}

	middleware.WriteJSON(w, http.StatusOK, issues)
}

// Create creates a new issue within a project.
func (h *IssueHandler) Create(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")

	// Try by ObjectID first, then by project code (supports delegation where IDs differ)
	project, err := h.projectService.GetByID(r.Context(), projectID)
	if err != nil || project == nil {
		project, err = h.projectService.GetByCode(r.Context(), projectID)
	}
	if err != nil || project == nil {
		middleware.WriteError(w, http.StatusNotFound, "project not found", "PROJECT_NOT_FOUND")
		return
	}

	var req models.CreateIssueRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "INVALID_BODY")
		return
	}

	if req.Title == "" {
		middleware.WriteError(w, http.StatusBadRequest, "title is required", "MISSING_TITLE")
		return
	}
	if !models.ValidIssueType(string(req.Type)) {
		middleware.WriteError(w, http.StatusBadRequest, "invalid issue type", "INVALID_TYPE")
		return
	}
	if !models.ValidPriority(string(req.Priority)) {
		middleware.WriteError(w, http.StatusBadRequest, "invalid priority", "INVALID_PRIORITY")
		return
	}
	issue, err := h.issueService.Create(r.Context(), project.Code, &req)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "CREATE_FAILED")
		return
	}

	actingUser := middleware.GetCurrentUser(r)
	go func() {
		ctx := context.Background()
		h.decisionService.Record(ctx, issue.ProjectCode, "issue_created",
			fmt.Sprintf("Created %s (%s, %s): %s", issue.IssueKey, issue.Type, issue.Priority, issue.Title), issue.IssueKey)
		h.vibectlMdService.UpdateSection(ctx, issue.ProjectCode, "status", "focus")
		if h.activityLogService != nil {
			var uid *bson.ObjectID
			var uname string
			if actingUser != nil {
				uid = &actingUser.ID
				uname = actingUser.DisplayName
			}
			h.activityLogService.LogWithUser(ctx, "issue_created",
				fmt.Sprintf("Created issue %s: %s", issue.IssueKey, issue.Title), issue.ProjectCode, uid, uname, "", nil)
		}
		// Fire webhook for P0 issues
		if issue.Priority == "P0" && h.webhookService != nil {
			if proj, err := h.projectService.GetByCode(ctx, issue.ProjectCode); err == nil && proj != nil {
				h.webhookService.Fire(ctx, proj.ID, models.WebhookEventP0Created, map[string]any{
					"issueKey": issue.IssueKey,
					"title":    issue.Title,
				})
			}
		}
	}()

	h.bus.Publish(events.Event{Type: "issue.created", ProjectCode: issue.ProjectCode})
	middleware.WriteJSON(w, http.StatusCreated, issue)
}

// GetByKey retrieves a single issue by its key.
func (h *IssueHandler) GetByKey(w http.ResponseWriter, r *http.Request) {
	issueKey := chi.URLParam(r, "issueKey")

	issue, err := h.issueService.GetByKey(r.Context(), issueKey)
	if err != nil {
		middleware.WriteError(w, http.StatusNotFound, err.Error(), "NOT_FOUND")
		return
	}

	middleware.WriteJSON(w, http.StatusOK, issue)
}

// Update modifies mutable fields of an issue.
func (h *IssueHandler) Update(w http.ResponseWriter, r *http.Request) {
	issueKey := chi.URLParam(r, "issueKey")

	var req models.UpdateIssueRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "INVALID_BODY")
		return
	}

	issue, err := h.issueService.Update(r.Context(), issueKey, &req)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "UPDATE_FAILED")
		return
	}

	h.bus.Publish(events.Event{Type: "issue.updated", ProjectCode: issue.ProjectCode})
	middleware.WriteJSON(w, http.StatusOK, issue)
}

// TransitionStatus validates and applies a status transition on an issue.
func (h *IssueHandler) TransitionStatus(w http.ResponseWriter, r *http.Request) {
	issueKey := chi.URLParam(r, "issueKey")

	var req models.StatusTransitionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "INVALID_BODY")
		return
	}

	issue, err := h.issueService.TransitionStatus(r.Context(), issueKey, req.Status)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "INVALID_TRANSITION")
		return
	}

	statusUser := middleware.GetCurrentUser(r)
	go func() {
		ctx := context.Background()
		h.decisionService.Record(ctx, issue.ProjectCode, "status_change",
			fmt.Sprintf("Marked %s as %s", issue.IssueKey, issue.Status), issue.IssueKey)
		h.vibectlMdService.UpdateSection(ctx, issue.ProjectCode, "status", "focus", "decisions")
		if h.activityLogService != nil {
			var uid *bson.ObjectID
			var uname string
			if statusUser != nil {
				uid = &statusUser.ID
				uname = statusUser.DisplayName
			}
			h.activityLogService.LogWithUser(ctx, "issue_status",
				fmt.Sprintf("Issue %s status changed to %s", issue.IssueKey, issue.Status), issue.ProjectCode, uid, uname, "", nil)
		}
	}()

	h.bus.Publish(events.Event{Type: "issue.updated", ProjectCode: issue.ProjectCode})
	middleware.WriteJSON(w, http.StatusOK, issue)
}

// Delete removes an issue by its key.
func (h *IssueHandler) Delete(w http.ResponseWriter, r *http.Request) {
	issueKey := chi.URLParam(r, "issueKey")

	// Fetch issue before archiving so we can record the decision
	issue, fetchErr := h.issueService.GetByKey(r.Context(), issueKey)

	if err := h.issueService.Delete(r.Context(), issueKey); err != nil {
		middleware.WriteError(w, http.StatusNotFound, err.Error(), "NOT_FOUND")
		return
	}

	if fetchErr == nil && issue != nil {
		h.bus.Publish(events.Event{Type: "issue.deleted", ProjectCode: issue.ProjectCode})
		go func() {
			ctx := context.Background()
			h.decisionService.Record(ctx, issue.ProjectCode, "issue_archived",
				fmt.Sprintf("Archived %s: %s", issue.IssueKey, issue.Title), issue.IssueKey)
			h.vibectlMdService.UpdateSection(ctx, issue.ProjectCode, "status", "focus", "decisions")
		}()
	}

	w.WriteHeader(http.StatusNoContent)
}

// Restore un-archives a soft-deleted issue.
func (h *IssueHandler) Restore(w http.ResponseWriter, r *http.Request) {
	issueKey := chi.URLParam(r, "issueKey")

	if err := h.issueService.Restore(r.Context(), issueKey); err != nil {
		middleware.WriteError(w, http.StatusNotFound, err.Error(), "NOT_FOUND")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// PermanentDelete permanently removes an archived issue.
func (h *IssueHandler) PermanentDelete(w http.ResponseWriter, r *http.Request) {
	issueKey := chi.URLParam(r, "issueKey")

	if err := h.issueService.PermanentDelete(r.Context(), issueKey); err != nil {
		middleware.WriteError(w, http.StatusNotFound, err.Error(), "NOT_FOUND")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// ListArchived returns archived issues for a project.
func (h *IssueHandler) ListArchived(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")

	project, err := h.projectService.GetByID(r.Context(), projectID)
	if err != nil || project == nil {
		project, err = h.projectService.GetByCode(r.Context(), projectID)
	}
	if err != nil || project == nil {
		middleware.WriteError(w, http.StatusNotFound, "project not found", "PROJECT_NOT_FOUND")
		return
	}

	issues, err := h.issueService.ListArchived(r.Context(), project.Code)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_FAILED")
		return
	}

	middleware.WriteJSON(w, http.StatusOK, issues)
}

// Search finds issues matching a text query, optionally scoped to a project.
func (h *IssueHandler) Search(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("q")
	if query == "" {
		middleware.WriteError(w, http.StatusBadRequest, "query parameter 'q' is required", "MISSING_QUERY")
		return
	}

	var projectCode string
	if projectID := r.URL.Query().Get("projectId"); projectID != "" {
		project, err := h.projectService.GetByID(r.Context(), projectID)
		if err != nil {
			middleware.WriteError(w, http.StatusNotFound, err.Error(), "PROJECT_NOT_FOUND")
			return
		}
		projectCode = project.Code
	}

	issues, err := h.issueService.Search(r.Context(), query, projectCode)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "SEARCH_FAILED")
		return
	}

	middleware.WriteJSON(w, http.StatusOK, issues)
}

// ListComments returns all comments for an issue.
func (h *IssueHandler) ListComments(w http.ResponseWriter, r *http.Request) {
	issueKey := chi.URLParam(r, "issueKey")

	comments, err := h.commentService.ListByIssue(r.Context(), issueKey)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_COMMENTS_FAILED")
		return
	}

	middleware.WriteJSON(w, http.StatusOK, comments)
}

// CreateComment adds a new comment to an issue.
func (h *IssueHandler) CreateComment(w http.ResponseWriter, r *http.Request) {
	issueKey := chi.URLParam(r, "issueKey")

	var req struct {
		Body   string `json:"body"`
		Author string `json:"author"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "INVALID_BODY")
		return
	}
	if req.Body == "" {
		middleware.WriteError(w, http.StatusBadRequest, "body is required", "MISSING_BODY")
		return
	}
	if req.Author == "" {
		req.Author = "admin"
	}

	// Look up the issue to get projectID
	issue, err := h.issueService.GetByKey(r.Context(), issueKey)
	if err != nil {
		middleware.WriteError(w, http.StatusNotFound, err.Error(), "ISSUE_NOT_FOUND")
		return
	}

	comment, err := h.commentService.Create(r.Context(), issueKey, issue.ProjectCode, req.Body, req.Author)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "CREATE_COMMENT_FAILED")
		return
	}

	h.bus.Publish(events.Event{Type: "comment.created", ProjectCode: issue.ProjectCode})
	middleware.WriteJSON(w, http.StatusCreated, comment)
}

// DeleteComment removes a comment by ID.
func (h *IssueHandler) DeleteComment(w http.ResponseWriter, r *http.Request) {
	commentID := chi.URLParam(r, "commentId")

	if err := h.commentService.Delete(r.Context(), commentID); err != nil {
		middleware.WriteError(w, http.StatusNotFound, err.Error(), "COMMENT_NOT_FOUND")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

