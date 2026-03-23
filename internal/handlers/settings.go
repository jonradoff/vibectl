package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/services"
)

// SettingsHandler handles HTTP requests for application settings.
type SettingsHandler struct {
	settingsService *services.SettingsService
	dbName          string
	dbUser          string
}

// NewSettingsHandler creates a new SettingsHandler.
func NewSettingsHandler(ss *services.SettingsService, dbName, dbUser string) *SettingsHandler {
	return &SettingsHandler{settingsService: ss, dbName: dbName, dbUser: dbUser}
}

// Routes returns the chi.Router for settings endpoints.
// Mounted at /api/v1/settings.
func (h *SettingsHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.GetSettings)
	r.Put("/", h.UpdateSettings)
	return r
}

// GetSettings returns the current application settings plus system info.
func (h *SettingsHandler) GetSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := h.settingsService.Get(r.Context())
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "GET_SETTINGS_FAILED")
		return
	}
	type response struct {
		*models.Settings
		DBName string `json:"dbName"`
		DBUser string `json:"dbUser"`
	}
	middleware.WriteJSON(w, http.StatusOK, response{Settings: settings, DBName: h.dbName, DBUser: h.dbUser})
}

// UpdateSettings updates application settings.
func (h *SettingsHandler) UpdateSettings(w http.ResponseWriter, r *http.Request) {
	var req models.Settings
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "INVALID_BODY")
		return
	}

	if err := h.settingsService.Update(r.Context(), &req); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "UPDATE_SETTINGS_FAILED")
		return
	}

	settings, err := h.settingsService.Get(r.Context())
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "GET_SETTINGS_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, settings)
}
