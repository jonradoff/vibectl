package handlers

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/services"
	"github.com/jonradoff/vibectl/pkg/healthz"
)

// HealthCheckHandler performs live health checks against project-configured endpoints.

type HealthCheckHandler struct {
	projectService      *services.ProjectService
	healthRecordService *services.HealthRecordService
	client              *http.Client
}

func NewHealthCheckHandler(ps *services.ProjectService, hrs *services.HealthRecordService) *HealthCheckHandler {
	return &HealthCheckHandler{
		projectService:      ps,
		healthRecordService: hrs,
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// Check performs health checks for a project based on its configured endpoints and monitorEnv.
func (h *HealthCheckHandler) Check(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	project, err := h.projectService.GetByID(r.Context(), id)
	if err != nil {
		middleware.WriteError(w, http.StatusNotFound, err.Error(), "PROJECT_NOT_FOUND")
		return
	}

	if project.HealthCheck == nil || project.HealthCheck.MonitorEnv == "" {
		middleware.WriteJSON(w, http.StatusOK, []models.HealthCheckResult{})
		return
	}

	cfg := project.HealthCheck
	var results []models.HealthCheckResult

	// Determine which URLs to check based on monitorEnv
	var frontendURL, backendURL string
	if cfg.MonitorEnv == "dev" {
		frontendURL = cfg.Frontend.DevURL
		backendURL = cfg.Backend.DevURL
	} else if cfg.MonitorEnv == "prod" {
		frontendURL = cfg.Frontend.ProdURL
		backendURL = cfg.Backend.ProdURL
	}

	if frontendURL != "" {
		results = append(results, h.probeFrontend("Frontend", frontendURL))
	}
	if backendURL != "" {
		results = append(results, h.probe("Backend", backendURL))
	}

	if results == nil {
		results = []models.HealthCheckResult{}
	}

	middleware.WriteJSON(w, http.StatusOK, results)
}

// History returns health check records for the last 24 hours.
func (h *HealthCheckHandler) History(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	records, err := h.healthRecordService.GetHistory(r.Context(), id, 24*time.Hour)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "HISTORY_ERROR")
		return
	}

	middleware.WriteJSON(w, http.StatusOK, records)
}

// Probe checks a backend endpoint (full /healthz probe). Exported for use by the background ticker.
func (h *HealthCheckHandler) Probe(name, url string) models.HealthCheckResult {
	return h.probe(name, url)
}

// ProbeFrontend checks a frontend endpoint — only verifies the URL returns a non-5xx response.
// Frontend apps don't implement /healthz, so marking them degraded for that is misleading.
func (h *HealthCheckHandler) ProbeFrontend(name, url string) models.HealthCheckResult {
	return h.probeFrontend(name, url)
}

// normalizeURL ensures a URL has an http(s) scheme. Bare hostnames get https://.
func normalizeURL(url string) string {
	if url == "" {
		return url
	}
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
		return "https://" + url
	}
	return url
}

func (h *HealthCheckHandler) probe(name, url string) models.HealthCheckResult {
	url = normalizeURL(url)
	// Try /healthz endpoint first if the URL looks like a base URL
	healthzURL := strings.TrimRight(url, "/") + "/healthz"
	if result, ok := h.probeHealthz(name, healthzURL); ok {
		return result
	}

	// Fall back to simple HTTP probe of the base URL
	resp, err := h.client.Get(url)
	if err != nil {
		return models.HealthCheckResult{
			Name:   name,
			URL:    url,
			Status: "down",
			Error:  err.Error(),
		}
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 500 {
		return models.HealthCheckResult{
			Name:   name,
			URL:    url,
			Status: "down",
			Code:   resp.StatusCode,
		}
	}

	// URL responds but no valid /healthz — mark degraded
	return models.HealthCheckResult{
		Name:   name,
		URL:    url,
		Status: "degraded",
		Code:   resp.StatusCode,
		Error:  "/healthz not implemented",
	}
}

// probeFrontend checks that a frontend URL responds with a non-5xx status.
// Frontends don't implement /healthz so we just check reachability.
func (h *HealthCheckHandler) probeFrontend(name, url string) models.HealthCheckResult {
	url = normalizeURL(url)
	resp, err := h.client.Get(url)
	if err != nil {
		return models.HealthCheckResult{
			Name:   name,
			URL:    url,
			Status: "down",
			Error:  err.Error(),
		}
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 500 {
		return models.HealthCheckResult{
			Name:   name,
			URL:    url,
			Status: "down",
			Code:   resp.StatusCode,
		}
	}

	return models.HealthCheckResult{
		Name:   name,
		URL:    url,
		Status: "up",
		Code:   resp.StatusCode,
	}
}

// probeHealthz attempts to fetch and parse a /healthz endpoint.
// Returns the result and true if the endpoint returned a valid healthz response.
func (h *HealthCheckHandler) probeHealthz(name, url string) (models.HealthCheckResult, bool) {
	resp, err := h.client.Get(url)
	if err != nil {
		return models.HealthCheckResult{}, false
	}
	defer resp.Body.Close()

	// Only parse if it looks like JSON
	ct := resp.Header.Get("Content-Type")
	if !strings.Contains(ct, "application/json") {
		return models.HealthCheckResult{}, false
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return models.HealthCheckResult{}, false
	}

	var hr healthz.HealthResponse
	if err := json.Unmarshal(body, &hr); err != nil {
		return models.HealthCheckResult{}, false
	}

	// Must have a valid status field to be considered a healthz response
	if hr.Status != healthz.StatusHealthy && hr.Status != healthz.StatusDegraded && hr.Status != healthz.StatusUnhealthy {
		return models.HealthCheckResult{}, false
	}

	// Map healthz status to our status
	status := "up"
	switch hr.Status {
	case healthz.StatusUnhealthy:
		status = "down"
	case healthz.StatusDegraded:
		status = "degraded"
	}

	// Convert dependencies
	var deps []models.HealthDependency
	for _, d := range hr.Dependencies {
		deps = append(deps, models.HealthDependency{
			Name:    d.Name,
			Status:  string(d.Status),
			Message: d.Message,
		})
	}

	// Convert KPIs
	var kpis []models.HealthKPI
	for _, k := range hr.KPIs {
		kpis = append(kpis, models.HealthKPI{
			Name:  k.Name,
			Value: k.Value,
			Unit:  k.Unit,
		})
	}

	return models.HealthCheckResult{
		Name:         name,
		URL:          url,
		Status:       status,
		Code:         resp.StatusCode,
		SoftwareName: hr.Name,
		Version:      hr.Version,
		Uptime:       hr.Uptime,
		Dependencies: deps,
		KPIs:         kpis,
	}, true
}
