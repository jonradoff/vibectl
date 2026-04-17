package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/delegation"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/services"
)

type DelegationHandler struct {
	manager         *delegation.Manager
	settingsService *services.SettingsService
}

func NewDelegationHandler(m *delegation.Manager, ss *services.SettingsService) *DelegationHandler {
	return &DelegationHandler{manager: m, settingsService: ss}
}

func (h *DelegationHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Use(middleware.RequireSuperAdmin)
	r.Get("/status", h.Status)
	r.Post("/test", h.Test)
	r.Post("/enable", h.Enable)
	r.Post("/disable", h.Disable)
	return r
}

// Status returns the current delegation state.
func (h *DelegationHandler) Status(w http.ResponseWriter, r *http.Request) {
	middleware.WriteJSON(w, http.StatusOK, h.manager.GetStatus())
}

// Test validates a remote URL and API key without activating delegation.
func (h *DelegationHandler) Test(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL    string `json:"url"`
		APIKey string `json:"apiKey"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.URL == "" || req.APIKey == "" {
		middleware.WriteError(w, http.StatusBadRequest, "url and apiKey are required", "BAD_REQUEST")
		return
	}

	result := delegation.TestConnection(req.URL, req.APIKey)
	middleware.WriteJSON(w, http.StatusOK, result)
}

// Enable activates delegation to the specified remote server.
func (h *DelegationHandler) Enable(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL    string `json:"url"`
		APIKey string `json:"apiKey"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.URL == "" || req.APIKey == "" {
		middleware.WriteError(w, http.StatusBadRequest, "url and apiKey are required", "BAD_REQUEST")
		return
	}

	// Validate first
	result := delegation.TestConnection(req.URL, req.APIKey)
	if !result.Valid {
		middleware.WriteError(w, http.StatusBadRequest, result.Error, "DELEGATION_TEST_FAILED")
		return
	}

	// Activate the proxy
	if err := h.manager.Enable(req.URL, req.APIKey, result.UserName); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "DELEGATION_ENABLE_FAILED")
		return
	}

	// Persist to settings
	ctx := r.Context()
	settings, _ := h.settingsService.Get(ctx)
	settings.DelegationEnabled = true
	settings.DelegationURL = req.URL
	settings.DelegationAPIKey = req.APIKey
	settings.DelegationUser = result.UserName
	if err := h.settingsService.Update(ctx, settings); err != nil {
		// Proxy is running but persistence failed — log but don't fail
		middleware.WriteJSON(w, http.StatusOK, map[string]interface{}{
			"status":  "enabled",
			"warning": "settings persistence failed: " + err.Error(),
		})
		return
	}

	middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "enabled"})
}

// Disable deactivates delegation.
func (h *DelegationHandler) Disable(w http.ResponseWriter, r *http.Request) {
	h.manager.Disable()

	// Clear from settings
	ctx := r.Context()
	settings, _ := h.settingsService.Get(ctx)
	settings.DelegationEnabled = false
	settings.DelegationURL = ""
	settings.DelegationAPIKey = ""
	settings.DelegationUser = ""
	h.settingsService.Update(ctx, settings)

	middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "disabled"})
}
