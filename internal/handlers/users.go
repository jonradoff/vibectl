package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/services"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// UserHandler manages user accounts (super_admin only for CRUD; self for profile).
type UserHandler struct {
	userSvc    *services.UserService
	sessionSvc *services.AuthSessionService
}

func NewUserHandler(userSvc *services.UserService, sessionSvc *services.AuthSessionService) *UserHandler {
	return &UserHandler{userSvc: userSvc, sessionSvc: sessionSvc}
}

// Routes returns routes accessible only to super_admins.
func (h *UserHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Use(middleware.RequireSuperAdmin)
	r.Get("/", h.List)
	r.Post("/", h.PreAuthorize)
	r.Post("/email", h.CreateEmailUser)
	r.Get("/{id}", h.GetByID)
	r.Put("/{id}", h.Update)
	r.Post("/{id}/disable", h.Disable)
	r.Post("/{id}/enable", h.Enable)
	r.Post("/{id}/set-password", h.SetPasswordForExistingUser)
	return r
}

// DirectoryRoutes returns routes accessible to any authenticated user (no super_admin required).
func (h *UserHandler) DirectoryRoutes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.List)
	return r
}

// SelfRoutes returns routes for the current user's own profile.
func (h *UserHandler) SelfRoutes() chi.Router {
	r := chi.NewRouter()
	r.Put("/", h.UpdateSelf)
	r.Put("/anthropic-key", h.SetAnthropicKey)
	r.Put("/github-pat", h.SetGitHubPAT)
	r.Put("/password", h.ChangeOwnPassword)
	return r
}

func (h *UserHandler) List(w http.ResponseWriter, r *http.Request) {
	users, err := h.userSvc.List(r.Context())
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_USERS_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, users)
}

func (h *UserHandler) PreAuthorize(w http.ResponseWriter, r *http.Request) {
	var req struct {
		GitHubUsername string              `json:"githubUsername"`
		DisplayName    string              `json:"displayName"`
		GlobalRole     models.GlobalRole   `json:"globalRole"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "INVALID_BODY")
		return
	}
	caller := middleware.GetCurrentUser(r)
	var createdBy *bson.ObjectID
	if caller != nil {
		id := caller.ID
		createdBy = &id
	}
	user, err := h.userSvc.PreAuthorize(r.Context(), req.GitHubUsername, req.DisplayName, req.GlobalRole, createdBy)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "PRE_AUTHORIZE_FAILED")
		return
	}
	callerID := ""
	if caller != nil {
		callerID = caller.ID.Hex()
	}
	slog.Info("user pre-authorized", "githubUsername", req.GitHubUsername, "role", req.GlobalRole, "createdBy", callerID)
	middleware.WriteJSON(w, http.StatusCreated, user)
}

func (h *UserHandler) CreateEmailUser(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email       string            `json:"email"`
		DisplayName string            `json:"displayName"`
		GlobalRole  models.GlobalRole `json:"globalRole"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "INVALID_BODY")
		return
	}
	caller := middleware.GetCurrentUser(r)
	var createdBy *bson.ObjectID
	if caller != nil {
		id := caller.ID
		createdBy = &id
	}
	user, tempPassword, err := h.userSvc.CreateEmailUser(r.Context(), req.Email, req.DisplayName, req.GlobalRole, createdBy)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "CREATE_EMAIL_USER_FAILED")
		return
	}
	slog.Info("email/password user created", "email", req.Email, "role", req.GlobalRole)
	middleware.WriteJSON(w, http.StatusCreated, map[string]interface{}{
		"user":              user,
		"temporaryPassword": tempPassword,
	})
}

func (h *UserHandler) SetPasswordForExistingUser(w http.ResponseWriter, r *http.Request) {
	id, err := bson.ObjectIDFromHex(chi.URLParam(r, "id"))
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid user id", "INVALID_ID")
		return
	}
	var req struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "INVALID_BODY")
		return
	}
	tempPassword, err := h.userSvc.SetEmailPassword(r.Context(), id, req.Email)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "SET_PASSWORD_FAILED")
		return
	}
	slog.Info("password set for existing user", "userId", id.Hex())
	middleware.WriteJSON(w, http.StatusOK, map[string]string{
		"temporaryPassword": tempPassword,
	})
}

func (h *UserHandler) GetByID(w http.ResponseWriter, r *http.Request) {
	user, err := h.userSvc.GetByIDHex(r.Context(), chi.URLParam(r, "id"))
	if err != nil || user == nil {
		middleware.WriteError(w, http.StatusNotFound, "user not found", "USER_NOT_FOUND")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, user)
}

func (h *UserHandler) Update(w http.ResponseWriter, r *http.Request) {
	id, err := bson.ObjectIDFromHex(chi.URLParam(r, "id"))
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid user id", "INVALID_ID")
		return
	}
	var req models.UpdateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "INVALID_BODY")
		return
	}
	user, err := h.userSvc.Update(r.Context(), id, &req)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "UPDATE_USER_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, user)
}


func (h *UserHandler) Disable(w http.ResponseWriter, r *http.Request) {
	h.setDisabled(w, r, true)
}

func (h *UserHandler) Enable(w http.ResponseWriter, r *http.Request) {
	h.setDisabled(w, r, false)
}

func (h *UserHandler) setDisabled(w http.ResponseWriter, r *http.Request, disabled bool) {
	id, err := bson.ObjectIDFromHex(chi.URLParam(r, "id"))
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid user id", "INVALID_ID")
		return
	}
	caller := middleware.GetCurrentUser(r)
	if caller != nil && caller.ID == id {
		middleware.WriteError(w, http.StatusBadRequest, "you cannot disable your own account", "SELF_DISABLE")
		return
	}
	disabled_ := disabled
	if _, err := h.userSvc.Update(r.Context(), id, &models.UpdateUserRequest{Disabled: &disabled_}); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "UPDATE_FAILED")
		return
	}
	if disabled {
		h.sessionSvc.RevokeAllForUser(r.Context(), id)
		caller := middleware.GetCurrentUser(r)
		callerID := ""
		if caller != nil {
			callerID = caller.ID.Hex()
		}
		slog.Info("user disabled", "userId", id.Hex(), "by", callerID)
	}
	w.WriteHeader(http.StatusNoContent)
}

// UpdateSelf lets the current user update their own display name and git identity.
func (h *UserHandler) UpdateSelf(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetCurrentUser(r)
	if user == nil {
		middleware.WriteError(w, http.StatusUnauthorized, "not authenticated", "UNAUTHORIZED")
		return
	}
	var req models.UpdateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "INVALID_BODY")
		return
	}
	// Self-update: do not allow changing role or disabled status
	req.GlobalRole = nil
	req.Disabled = nil
	updated, err := h.userSvc.Update(r.Context(), user.ID, &req)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "UPDATE_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, updated)
}

// SetAnthropicKey stores (or clears) the user's personal Anthropic API key.
func (h *UserHandler) SetAnthropicKey(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetCurrentUser(r)
	if user == nil {
		middleware.WriteError(w, http.StatusUnauthorized, "not authenticated", "UNAUTHORIZED")
		return
	}
	var req struct {
		Key string `json:"key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "INVALID_BODY")
		return
	}
	if err := h.userSvc.SetAnthropicKey(r.Context(), user.ID, req.Key); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "SET_KEY_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, map[string]bool{"hasAnthropicKey": req.Key != ""})
}

// SetGitHubPAT stores (or clears) the user's GitHub Personal Access Token.
func (h *UserHandler) SetGitHubPAT(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetCurrentUser(r)
	if user == nil {
		middleware.WriteError(w, http.StatusUnauthorized, "not authenticated", "UNAUTHORIZED")
		return
	}
	var req struct {
		PAT string `json:"pat"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "INVALID_BODY")
		return
	}
	if err := h.userSvc.SetGitHubPAT(r.Context(), user.ID, req.PAT); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "SET_PAT_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, map[string]bool{"hasGitHubPAT": req.PAT != ""})
}

// ChangeOwnPassword is the endpoint for changing your own password.
// The request body must include currentPassword and newPassword.
func (h *UserHandler) ChangeOwnPassword(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetCurrentUser(r)
	if user == nil {
		middleware.WriteError(w, http.StatusUnauthorized, "not authenticated", "UNAUTHORIZED")
		return
	}
	var req struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "INVALID_BODY")
		return
	}
	if len(req.NewPassword) < 8 {
		middleware.WriteError(w, http.StatusBadRequest, "new password must be at least 8 characters", "WEAK_PASSWORD")
		return
	}
	if err := h.userSvc.ChangePassword(r.Context(), user.ID, req.CurrentPassword, req.NewPassword); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "CHANGE_PASSWORD_FAILED")
		return
	}
	h.sessionSvc.RevokeAllForUser(r.Context(), user.ID)
	token, err := h.sessionSvc.Create(r.Context(), user.ID, r)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, "failed to create session", "SESSION_ERROR")
		return
	}
	updated, _ := h.userSvc.GetByID(r.Context(), user.ID)
	middleware.WriteJSON(w, http.StatusOK, map[string]any{"token": token, "user": updated})
}
