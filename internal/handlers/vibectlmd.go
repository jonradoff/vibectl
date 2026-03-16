package handlers

import (
	"net/http"
	"os"
	"path/filepath"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/services"
)

type VibectlMdHandler struct {
	vibectlMdService *services.VibectlMdService
	decisionService  *services.DecisionService
	projectService   *services.ProjectService
}

func NewVibectlMdHandler(v *services.VibectlMdService, d *services.DecisionService, p *services.ProjectService) *VibectlMdHandler {
	return &VibectlMdHandler{vibectlMdService: v, decisionService: d, projectService: p}
}

// Generate triggers a full VIBECTL.md regeneration for a project.
func (h *VibectlMdHandler) Generate(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")

	if err := h.vibectlMdService.WriteToProject(r.Context(), projectID); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "GENERATE_FAILED")
		return
	}

	middleware.WriteJSON(w, http.StatusOK, map[string]bool{"generated": true})
}

// GetCurrent reads the current VIBECTL.md from the project's local path.
func (h *VibectlMdHandler) GetCurrent(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")

	project, err := h.projectService.GetByID(r.Context(), projectID)
	if err != nil {
		middleware.WriteError(w, http.StatusNotFound, err.Error(), "PROJECT_NOT_FOUND")
		return
	}

	if project.Links.LocalPath == "" {
		middleware.WriteError(w, http.StatusNotFound, "project has no local path configured", "NO_LOCAL_PATH")
		return
	}

	content, err := os.ReadFile(filepath.Join(project.Links.LocalPath, "VIBECTL.md"))
	if err != nil {
		middleware.WriteError(w, http.StatusNotFound, "VIBECTL.md not found", "FILE_NOT_FOUND")
		return
	}

	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	w.Write(content)
}

// Preview generates VIBECTL.md content without writing to disk.
func (h *VibectlMdHandler) Preview(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")

	content, err := h.vibectlMdService.Generate(r.Context(), projectID)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "PREVIEW_FAILED")
		return
	}

	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(content))
}

// ListDecisions returns recent decisions for a project.
func (h *VibectlMdHandler) ListDecisions(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")

	limit := 20
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}

	decisions, err := h.decisionService.ListRecent(r.Context(), projectID, limit)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "DECISIONS_ERROR")
		return
	}

	middleware.WriteJSON(w, http.StatusOK, decisions)
}
