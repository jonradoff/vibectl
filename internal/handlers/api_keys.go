package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/services"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// APIKeyHandler manages named API keys for programmatic access.
type APIKeyHandler struct {
	svc *services.APIKeyService
}

func NewAPIKeyHandler(svc *services.APIKeyService) *APIKeyHandler {
	return &APIKeyHandler{svc: svc}
}

// Routes returns routes under /api-keys (scoped to the authenticated user).
func (h *APIKeyHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.List)
	r.Post("/", h.Create)
	r.Delete("/{keyId}", h.Revoke)
	return r
}

// List returns all API keys for the current user.
func (h *APIKeyHandler) List(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetCurrentUser(r)
	if user == nil {
		middleware.WriteError(w, http.StatusUnauthorized, "not authenticated", "UNAUTHORIZED")
		return
	}
	keys, err := h.svc.ListForUser(r.Context(), user.ID)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "INTERNAL")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, keys)
}

// Create generates a new named API key, returning the raw token once.
func (h *APIKeyHandler) Create(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetCurrentUser(r)
	if user == nil {
		middleware.WriteError(w, http.StatusUnauthorized, "not authenticated", "UNAUTHORIZED")
		return
	}

	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" {
		middleware.WriteError(w, http.StatusBadRequest, "name is required", "INVALID_BODY")
		return
	}

	view, rawToken, err := h.svc.Create(r.Context(), user.ID, req.Name)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "INTERNAL")
		return
	}

	middleware.WriteJSON(w, http.StatusCreated, map[string]interface{}{
		"key":   view,
		"token": rawToken,
	})
}

// Revoke deletes an API key owned by the current user.
func (h *APIKeyHandler) Revoke(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetCurrentUser(r)
	if user == nil {
		middleware.WriteError(w, http.StatusUnauthorized, "not authenticated", "UNAUTHORIZED")
		return
	}

	keyIDStr := chi.URLParam(r, "keyId")
	keyID, err := bson.ObjectIDFromHex(keyIDStr)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid key id", "INVALID_ID")
		return
	}

	if err := h.svc.Revoke(r.Context(), keyID, user.ID); err != nil {
		middleware.WriteError(w, http.StatusNotFound, err.Error(), "NOT_FOUND")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
