package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/services"
)

// CloneHandler handles project repo clone/pull/remove endpoints.
type CloneHandler struct {
	cloneService   *services.CloneService
	projectService *services.ProjectService
}

func NewCloneHandler(cs *services.CloneService, ps *services.ProjectService) *CloneHandler {
	return &CloneHandler{cloneService: cs, projectService: ps}
}

// Routes returns clone-related sub-routes, mounted under /projects/{id}.
func (h *CloneHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/clone-status", h.Status)
	r.Get("/clone", h.Clone)
	r.Get("/pull", h.Pull)
	r.Get("/git-status", h.GitStatus)
	r.Post("/git-commit", h.GitCommit)
	r.Delete("/clone", h.Remove)
	return r
}

// GlobalRoutes returns routes not scoped to a project, mounted under /api/v1/clone.
func (h *CloneHandler) GlobalRoutes() chi.Router {
	r := chi.NewRouter()
	r.Get("/suggest-path", h.SuggestPath)
	r.Get("/new-path", h.NewPath)
	return r
}

// NewPath returns the suggested server-side path for a brand-new project directory.
func (h *CloneHandler) NewPath(w http.ResponseWriter, r *http.Request) {
	code := r.URL.Query().Get("code")
	if code == "" {
		middleware.WriteError(w, http.StatusBadRequest, "code query param is required", "MISSING_CODE")
		return
	}
	path := h.cloneService.SuggestNewPath(code)
	middleware.WriteJSON(w, http.StatusOK, map[string]string{"path": path})
}

// SuggestPath returns the deterministic server-side path for a given GitHub URL.
func (h *CloneHandler) SuggestPath(w http.ResponseWriter, r *http.Request) {
	githubURL := r.URL.Query().Get("url")
	if githubURL == "" {
		middleware.WriteError(w, http.StatusBadRequest, "url query param is required", "MISSING_URL")
		return
	}
	path := h.cloneService.SuggestPath(githubURL)
	middleware.WriteJSON(w, http.StatusOK, map[string]string{"path": path})
}

// Status returns the current clone status for a project.
func (h *CloneHandler) Status(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	project, err := h.projectService.GetByID(r.Context(), projectID)
	if err != nil || project == nil {
		middleware.WriteError(w, http.StatusNotFound, "project not found", "NOT_FOUND")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, services.CloneStatusResponse{
		CloneStatus: project.CloneStatus,
		CloneError:  project.CloneError,
		LocalPath:   project.Links.LocalPath,
		UpdatedAt:   project.UpdatedAt,
	})
}

// Clone starts a git clone, streaming progress as SSE.
func (h *CloneHandler) Clone(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	user := middleware.GetCurrentUser(r)
	if user == nil {
		middleware.WriteError(w, http.StatusUnauthorized, "not authenticated", "UNAUTHORIZED")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	sw := &sseLineWriter{w: w, flusher: flusher}

	err := h.cloneService.CloneProject(r.Context(), projectID, user.ID, sw)
	if err != nil {
		fmt.Fprintf(w, "data: ERROR: %s\n\n", err.Error())
	} else {
		fmt.Fprintf(w, "data: DONE\n\n")
	}
	flusher.Flush()
}

// Pull runs git pull, streaming progress as SSE.
func (h *CloneHandler) Pull(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	user := middleware.GetCurrentUser(r)
	if user == nil {
		middleware.WriteError(w, http.StatusUnauthorized, "not authenticated", "UNAUTHORIZED")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	sw := &sseLineWriter{w: w, flusher: flusher}

	err := h.cloneService.PullProject(r.Context(), projectID, user.ID, sw)
	if err != nil {
		fmt.Fprintf(w, "data: ERROR: %s\n\n", err.Error())
	} else {
		fmt.Fprintf(w, "data: DONE\n\n")
	}
	flusher.Flush()
}

// Remove deletes the local clone.
func (h *CloneHandler) Remove(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	if err := h.cloneService.RemoveClone(r.Context(), projectID); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "REMOVE_FAILED")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// sseLineWriter wraps a ResponseWriter to emit SSE-formatted lines.
type sseLineWriter struct {
	w       http.ResponseWriter
	flusher http.Flusher
}

func (s *sseLineWriter) Write(p []byte) (int, error) {
	lines := splitLines(p)
	for _, line := range lines {
		if line == "" {
			continue
		}
		fmt.Fprintf(s.w, "data: %s\n\n", line)
	}
	s.flusher.Flush()
	return len(p), nil
}

func splitLines(p []byte) []string {
	var lines []string
	start := 0
	for i, b := range p {
		if b == '\n' || b == '\r' {
			if i > start {
				lines = append(lines, string(p[start:i]))
			}
			start = i + 1
		}
	}
	if start < len(p) {
		lines = append(lines, string(p[start:]))
	}
	return lines
}

// GitStatus checks for uncommitted changes in the project's local repo.
func (h *CloneHandler) GitStatus(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	project, err := h.projectService.GetByID(r.Context(), projectID)
	if err != nil || project == nil {
		project, err = h.projectService.GetByCode(r.Context(), projectID)
	}
	if err != nil || project == nil {
		middleware.WriteError(w, http.StatusNotFound, "project not found", "NOT_FOUND")
		return
	}
	localPath := project.Links.LocalPath
	if localPath == "" {
		middleware.WriteJSON(w, http.StatusOK, map[string]interface{}{"dirty": false, "files": []string{}})
		return
	}

	cmd := exec.CommandContext(r.Context(), "git", "-C", localPath, "status", "--porcelain")
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.Output()
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, "git status failed", "GIT_ERROR")
		return
	}

	output := strings.TrimSpace(string(out))
	var files []string
	if output != "" {
		files = strings.Split(output, "\n")
	}

	middleware.WriteJSON(w, http.StatusOK, map[string]interface{}{
		"dirty": len(files) > 0,
		"files": files,
	})
}

// GitCommit stages all changes and commits with the given message.
func (h *CloneHandler) GitCommit(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	project, err := h.projectService.GetByID(r.Context(), projectID)
	if err != nil || project == nil {
		project, err = h.projectService.GetByCode(r.Context(), projectID)
	}
	if err != nil || project == nil {
		middleware.WriteError(w, http.StatusNotFound, "project not found", "NOT_FOUND")
		return
	}
	localPath := project.Links.LocalPath
	if localPath == "" {
		middleware.WriteError(w, http.StatusBadRequest, "no local path", "NO_LOCAL_PATH")
		return
	}

	var req struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Message == "" {
		middleware.WriteError(w, http.StatusBadRequest, "message is required", "VALIDATION_ERROR")
		return
	}

	// git add -A
	addCmd := exec.CommandContext(r.Context(), "git", "-C", localPath, "add", "-A")
	addCmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	if out, err := addCmd.CombinedOutput(); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("git add failed: %s", string(out)), "GIT_ERROR")
		return
	}

	// git commit
	commitCmd := exec.CommandContext(r.Context(), "git", "-C", localPath, "commit", "-m", req.Message)
	commitCmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	if out, err := commitCmd.CombinedOutput(); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("git commit failed: %s", string(out)), "GIT_ERROR")
		return
	}

	middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "committed"})
}
