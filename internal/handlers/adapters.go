package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/adapters"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/services"
)

type AdapterHandler struct {
	registry           *adapters.Registry
	chatSessionService *services.ChatSessionService
}

func NewAdapterHandler(r *adapters.Registry, css *services.ChatSessionService) *AdapterHandler {
	return &AdapterHandler{registry: r, chatSessionService: css}
}

func (h *AdapterHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/status", h.Status)
	r.Get("/recommended", h.Recommended)
	r.Get("/context-health/{sessionID}", h.ContextHealth)
	r.Get("/project-health/{projectCode}", h.ProjectHealth)
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

// ProjectHealth resolves a project code to its active Claude session and returns context health.
func (h *AdapterHandler) ProjectHealth(w http.ResponseWriter, r *http.Request) {
	projectCode := chi.URLParam(r, "projectCode")
	if h.chatSessionService == nil {
		middleware.WriteJSON(w, http.StatusOK, nil)
		return
	}
	session, err := h.chatSessionService.GetResumable(r.Context(), projectCode)
	if err != nil || session == nil || session.ClaudeSessionID == "" {
		middleware.WriteJSON(w, http.StatusOK, nil)
		return
	}
	health := h.registry.GetContextHealth(session.ClaudeSessionID)
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
