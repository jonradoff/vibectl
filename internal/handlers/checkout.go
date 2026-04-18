package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/services"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// CheckoutHandler manages the exclusive code-checkout lock per project.
type CheckoutHandler struct {
	checkoutSvc *services.CheckoutService
	memberSvc   *services.ProjectMemberService
	projectSvc  *services.ProjectService
}

func NewCheckoutHandler(checkoutSvc *services.CheckoutService, memberSvc *services.ProjectMemberService, projectSvc *services.ProjectService) *CheckoutHandler {
	return &CheckoutHandler{checkoutSvc: checkoutSvc, memberSvc: memberSvc, projectSvc: projectSvc}
}

// Routes returns routes nested under /projects/{id}/checkout.
func (h *CheckoutHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.GetStatus)
	r.Post("/", h.Acquire)
	r.Delete("/", h.Release)
	r.Post("/reclaim", h.Reclaim)
	return r
}

func (h *CheckoutHandler) GetStatus(w http.ResponseWriter, r *http.Request) {
	projectID, user, ok := h.parseProjectAndUser(w, r)
	if !ok {
		return
	}
	status, err := h.checkoutSvc.GetStatus(r.Context(), projectID, user.ID)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "CHECKOUT_STATUS_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, status)
}

// Acquire tries to check out the project. Requires developer+ or super_admin.
func (h *CheckoutHandler) Acquire(w http.ResponseWriter, r *http.Request) {
	projectID, user, ok := h.parseProjectAndUser(w, r)
	if !ok {
		return
	}
	if !h.requireMinRole(w, r, projectID, user, models.ProjectRoleDeveloper) {
		return
	}
	co, err := h.checkoutSvc.Acquire(r.Context(), projectID, user.ID)
	if err != nil {
		middleware.WriteError(w, http.StatusConflict, err.Error(), "CHECKOUT_CONFLICT")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, co)
}

// Release releases the checkout held by the current user.
func (h *CheckoutHandler) Release(w http.ResponseWriter, r *http.Request) {
	projectID, user, ok := h.parseProjectAndUser(w, r)
	if !ok {
		return
	}
	if err := h.checkoutSvc.Release(r.Context(), projectID, user.ID); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "RELEASE_FAILED")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Reclaim force-releases the checkout. Requires owner or super_admin.
func (h *CheckoutHandler) Reclaim(w http.ResponseWriter, r *http.Request) {
	projectID, user, ok := h.parseProjectAndUser(w, r)
	if !ok {
		return
	}
	if !h.requireMinRole(w, r, projectID, user, models.ProjectRoleOwner) {
		return
	}
	if err := h.checkoutSvc.Reclaim(r.Context(), projectID); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "RECLAIM_FAILED")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *CheckoutHandler) parseProjectAndUser(w http.ResponseWriter, r *http.Request) (bson.ObjectID, *models.User, bool) {
	projectID, err := bson.ObjectIDFromHex(chi.URLParam(r, "id"))
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid project id", "INVALID_ID")
		return bson.ObjectID{}, nil, false
	}
	user := middleware.GetCurrentUser(r)
	if user == nil {
		middleware.WriteError(w, http.StatusUnauthorized, "not authenticated", "UNAUTHORIZED")
		return bson.ObjectID{}, nil, false
	}
	return projectID, user, true
}

func (h *CheckoutHandler) requireMinRole(w http.ResponseWriter, r *http.Request, projectID bson.ObjectID, user *models.User, minRole models.ProjectRole) bool {
	if user.GlobalRole == models.GlobalRoleSuperAdmin {
		return true
	}
	project, err := h.projectSvc.GetByID(r.Context(), projectID.Hex())
	if err != nil || project == nil {
		middleware.WriteError(w, http.StatusNotFound, "project not found", "PROJECT_NOT_FOUND")
		return false
	}
	has, err := h.memberSvc.HasRole(r.Context(), project.Code, user.ID, minRole)
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
