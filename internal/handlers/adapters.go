package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/adapters"
	"github.com/jonradoff/vibectl/internal/middleware"
)

type AdapterHandler struct {
	registry *adapters.Registry
}

func NewAdapterHandler(r *adapters.Registry) *AdapterHandler {
	return &AdapterHandler{registry: r}
}

func (h *AdapterHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/status", h.Status)
	r.Get("/recommended", h.Recommended)
	r.Get("/context-health/{sessionID}", h.ContextHealth)
	r.Get("/waste-findings", h.WasteFindings)
	r.Get("/activity-mode/{sessionID}", h.ActivityMode)
	r.Post("/refresh", h.Refresh)
	return r
}

// Status returns which adapters are detected and available.
func (h *AdapterHandler) Status(w http.ResponseWriter, r *http.Request) {
	middleware.WriteJSON(w, http.StatusOK, map[string]interface{}{
		"adapters": h.registry.DetectedAdapters(),
	})
}

// Recommended returns the list of recommended plugins with install state.
func (h *AdapterHandler) Recommended(w http.ResponseWriter, r *http.Request) {
	middleware.WriteJSON(w, http.StatusOK, adapters.GetRecommendedPlugins())
}

// ContextHealth returns context health data for a session from detected adapters.
func (h *AdapterHandler) ContextHealth(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	health := h.registry.GetContextHealth(sessionID)
	if health == nil {
		middleware.WriteJSON(w, http.StatusOK, nil)
		return
	}
	middleware.WriteJSON(w, http.StatusOK, health)
}

// WasteFindings returns waste patterns from detected adapters.
func (h *AdapterHandler) WasteFindings(w http.ResponseWriter, r *http.Request) {
	findings := h.registry.GetWasteFindings()
	if findings == nil {
		findings = []adapters.WasteFinding{}
	}
	middleware.WriteJSON(w, http.StatusOK, findings)
}

// ActivityMode returns the current activity mode for a session.
func (h *AdapterHandler) ActivityMode(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	mode := h.registry.GetActivityMode(sessionID)
	if mode == nil {
		middleware.WriteJSON(w, http.StatusOK, nil)
		return
	}
	middleware.WriteJSON(w, http.StatusOK, mode)
}

// Refresh re-runs adapter detection (e.g., after installing a plugin).
func (h *AdapterHandler) Refresh(w http.ResponseWriter, r *http.Request) {
	h.registry.Refresh()
	middleware.WriteJSON(w, http.StatusOK, map[string]interface{}{
		"adapters": h.registry.DetectedAdapters(),
	})
}
