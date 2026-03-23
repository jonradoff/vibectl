package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/services"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// ProjectMemberHandler manages project-level role assignments.
type ProjectMemberHandler struct {
	memberSvc  *services.ProjectMemberService
	projectSvc *services.ProjectService
}

func NewProjectMemberHandler(memberSvc *services.ProjectMemberService, projectSvc *services.ProjectService) *ProjectMemberHandler {
	return &ProjectMemberHandler{memberSvc: memberSvc, projectSvc: projectSvc}
}

// Routes returns routes nested under /projects/{projectId}/members.
func (h *ProjectMemberHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.List)
	r.Put("/{userId}", h.Upsert)
	r.Delete("/{userId}", h.Remove)
	return r
}

// List returns all members for the project.
// Requires: owner, devops, or super_admin.
func (h *ProjectMemberHandler) List(w http.ResponseWriter, r *http.Request) {
	projectID, err := bson.ObjectIDFromHex(chi.URLParam(r, "id"))
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid project id", "INVALID_ID")
		return
	}

	if !h.requireProjectRole(w, r, projectID, models.ProjectRoleViewer) {
		return
	}

	members, err := h.memberSvc.ListByProject(r.Context(), projectID)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_MEMBERS_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, members)
}

// Upsert adds or updates a member's role. Requires owner or super_admin.
func (h *ProjectMemberHandler) Upsert(w http.ResponseWriter, r *http.Request) {
	projectID, err := bson.ObjectIDFromHex(chi.URLParam(r, "id"))
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid project id", "INVALID_ID")
		return
	}
	if !h.requireProjectRole(w, r, projectID, models.ProjectRoleOwner) {
		return
	}

	userID, err := bson.ObjectIDFromHex(chi.URLParam(r, "userId"))
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid user id", "INVALID_ID")
		return
	}
	var req models.UpsertProjectMemberRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "INVALID_BODY")
		return
	}
	if err := services.ValidateRole(req.Role); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "INVALID_ROLE")
		return
	}
	caller := middleware.GetCurrentUser(r)
	createdBy := caller.ID
	if err := h.memberSvc.Upsert(r.Context(), projectID, userID, createdBy, req.Role); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "UPSERT_MEMBER_FAILED")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Remove removes a member from the project. Requires owner or super_admin.
func (h *ProjectMemberHandler) Remove(w http.ResponseWriter, r *http.Request) {
	projectID, err := bson.ObjectIDFromHex(chi.URLParam(r, "id"))
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid project id", "INVALID_ID")
		return
	}
	if !h.requireProjectRole(w, r, projectID, models.ProjectRoleOwner) {
		return
	}

	userID, err := bson.ObjectIDFromHex(chi.URLParam(r, "userId"))
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid user id", "INVALID_ID")
		return
	}
	if err := h.memberSvc.Remove(r.Context(), projectID, userID); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "REMOVE_MEMBER_FAILED")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// requireProjectRole checks that the current user has at least minRole in the project.
// super_admins always pass. Returns false and writes the error if check fails.
func (h *ProjectMemberHandler) requireProjectRole(w http.ResponseWriter, r *http.Request, projectID bson.ObjectID, minRole models.ProjectRole) bool {
	user := middleware.GetCurrentUser(r)
	if user == nil {
		middleware.WriteError(w, http.StatusUnauthorized, "not authenticated", "UNAUTHORIZED")
		return false
	}
	if user.GlobalRole == models.GlobalRoleSuperAdmin {
		return true
	}
	has, err := h.memberSvc.HasRole(r.Context(), projectID, user.ID, minRole)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "PERMISSION_CHECK_FAILED")
		return false
	}
	if !has {
		middleware.WriteError(w, http.StatusForbidden, "insufficient project permissions", "FORBIDDEN")
		return false
	}
	return true
}
