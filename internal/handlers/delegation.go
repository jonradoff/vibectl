package handlers

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/delegation"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/services"
)

type DelegationHandler struct {
	manager         *delegation.Manager
	settingsService *services.SettingsService
	projectService  *services.ProjectService
}

func NewDelegationHandler(m *delegation.Manager, ss *services.SettingsService, ps *services.ProjectService) *DelegationHandler {
	return &DelegationHandler{manager: m, settingsService: ss, projectService: ps}
}

func (h *DelegationHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/status", h.Status)
	r.Post("/test", h.Test)
	r.Post("/enable", h.Enable)
	r.Post("/disable", h.Disable)
	r.Post("/export-project", h.ExportProject)
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

// ExportProject sends a local project to the remote server via the delegation proxy.
func (h *DelegationHandler) ExportProject(w http.ResponseWriter, r *http.Request) {
	if !h.manager.IsEnabled() {
		middleware.WriteError(w, http.StatusBadRequest, "delegation is not active", "DELEGATION_INACTIVE")
		return
	}

	var req struct {
		ProjectCode string `json:"projectCode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ProjectCode == "" {
		middleware.WriteError(w, http.StatusBadRequest, "projectCode is required", "BAD_REQUEST")
		return
	}

	// Look up local project
	project, err := h.projectService.GetByCode(r.Context(), req.ProjectCode)
	if err != nil || project == nil {
		middleware.WriteError(w, http.StatusNotFound, "local project not found", "NOT_FOUND")
		return
	}

	// Create on remote via the delegation proxy
	status := h.manager.GetStatus()
	createBody := map[string]interface{}{
		"name":        project.Name,
		"code":        project.Code,
		"description": project.Description,
		"goals":       project.Goals,
		"links": map[string]interface{}{
			"githubUrl": project.Links.GitHubURL,
		},
	}
	bodyBytes, _ := json.Marshal(createBody)

	remoteReq, _ := http.NewRequestWithContext(r.Context(), "POST", status.URL+"/api/v1/projects", bytes.NewReader(bodyBytes))
	remoteReq.Header.Set("Content-Type", "application/json")
	remoteReq.Header.Set("Authorization", "Bearer "+h.manager.GetAPIKey())

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(remoteReq)
	if err != nil {
		middleware.WriteError(w, http.StatusBadGateway, "failed to reach remote: "+err.Error(), "REMOTE_ERROR")
		return
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == 409 || resp.StatusCode == 400 {
		// Project code likely already exists on remote
		middleware.WriteJSON(w, http.StatusOK, map[string]interface{}{
			"status":  "already_exists",
			"message": "Project with this code already exists on the remote server",
		})
		return
	}
	if resp.StatusCode != 201 && resp.StatusCode != 200 {
		middleware.WriteError(w, resp.StatusCode, string(respBody), "REMOTE_ERROR")
		return
	}

	middleware.WriteJSON(w, http.StatusOK, map[string]interface{}{
		"status":  "exported",
		"message": "Project exported to remote server",
	})
}
