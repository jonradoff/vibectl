package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os/exec"
	"syscall"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/services"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// CIHandler manages CI/CD actions per project.
type CIHandler struct {
	projectSvc  *services.ProjectService
	memberSvc   *services.ProjectMemberService
	githubToken string
}

func NewCIHandler(projectSvc *services.ProjectService, memberSvc *services.ProjectMemberService, githubToken string) *CIHandler {
	return &CIHandler{projectSvc: projectSvc, memberSvc: memberSvc, githubToken: githubToken}
}

// Routes returns routes nested under /projects/{id}/ci.
func (h *CIHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/status", h.Status)
	r.Post("/commit", h.Commit)
	r.Post("/push", h.Push)
	r.Post("/deploy", h.Deploy)
	r.Post("/restart-dev", h.RestartDev)
	r.Get("/restart-dev-stream", h.RestartDevStream)
	r.Post("/restart-prod", h.RestartProd)
	r.Post("/start-prod", h.StartProd)
	r.Post("/deploy-all", h.DeployAll)
	r.Get("/deploy-all-stream", h.DeployAllStream)
	r.Post("/pause", h.TogglePause)
	return r
}

// BulkRoutes returns routes for bulk operations, mounted under /api/v1/ci.
func (h *CIHandler) BulkRoutes() chi.Router {
	r := chi.NewRouter()
	r.Post("/bulk-start-prod", h.BulkStartProd)
	r.Post("/bulk-restart-prod", h.BulkRestartProd)
	r.Get("/bulk-start-prod-stream", h.BulkStartProdStream)
	r.Get("/bulk-restart-prod-stream", h.BulkRestartProdStream)
	return r
}

// sseEmit writes a single SSE data line and flushes.
func sseEmit(w http.ResponseWriter, flusher http.Flusher, msg string) {
	fmt.Fprintf(w, "data: %s\n\n", msg)
	flusher.Flush()
}

// startSSE sets SSE headers and returns a flusher. Returns false if streaming unsupported.
func startSSE(w http.ResponseWriter) (http.Flusher, bool) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	flusher, ok := w.(http.Flusher)
	return flusher, ok
}

// runCmdStream runs a shell command, streaming combined stdout+stderr to w line by line.
// It always cds into dir first.
func (h *CIHandler) runCmdStream(ctx context.Context, cmd, dir string, timeout time.Duration, w io.Writer) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	// Prepend a cd so the command always runs in the project directory
	fullCmd := fmt.Sprintf("cd %q && %s", dir, cmd)
	execCmd := exec.CommandContext(ctx, "sh", "-c", fullCmd)
	execCmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	execCmd.Stdout = w
	execCmd.Stderr = w
	return execCmd.Run()
}

// DeployAllStream streams commit → push → deploy as SSE.
// Query params: commitMessage (optional)
func (h *CIHandler) DeployAllStream(w http.ResponseWriter, r *http.Request) {
	project, ok := h.getProject(w, r)
	if !ok {
		return
	}
	if !h.requireMinRole(w, r, project.ID, models.ProjectRoleDevOps) {
		return
	}

	flusher, ok := startSSE(w)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}
	emit := func(msg string) { sseEmit(w, flusher, msg) }

	repoPath := project.Links.LocalPath
	if repoPath == "" {
		emit("ERROR: no local path configured")
		return
	}

	commitMessage := r.URL.Query().Get("commitMessage")

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Minute)
	defer cancel()

	// lineWriter wraps emit so each line of cmd output arrives as a separate SSE event
	lw := &funcWriter{fn: func(line string) { emit(line) }}

	// Step 1: commit (optional)
	if commitMessage != "" {
		emit("STEP:commit")
		err := h.runCmdStream(ctx, fmt.Sprintf("git add -A && git commit -m %q", commitMessage), repoPath, 30*time.Second, lw)
		if err != nil && !strings.Contains(err.Error(), "nothing to commit") {
			emit("STEP_ERROR:commit")
			emit("DONE")
			return
		}
		emit("STEP_DONE:commit")
	}

	// Step 2: push
	if project.Links.GitHubURL != "" {
		emit("STEP:push")
		err := h.runCmdStream(ctx, "git push", repoPath, 2*time.Minute, lw)
		if err != nil {
			emit("STEP_ERROR:push")
			emit("DONE")
			return
		}
		emit("STEP_DONE:push")
	}

	// Step 3: deploy
	if project.Deployment == nil || project.Deployment.DeployProd == "" {
		emit("ERROR: no deployProd command configured — set it in Settings → Deployment")
		emit("DONE")
		return
	}
	emit("STEP:deploy")
	err := h.runCmdStream(ctx, project.Deployment.DeployProd, repoPath, 10*time.Minute, lw)
	if err != nil {
		emit("STEP_ERROR:deploy")
		emit("DONE")
		return
	}
	emit("STEP_DONE:deploy")
	emit("DONE")
}

// BulkStartProdStream streams start-prod for all unpaused projects as SSE.
func (h *CIHandler) BulkStartProdStream(w http.ResponseWriter, r *http.Request) {
	if !h.requireSuperAdmin(w, r) {
		return
	}
	flusher, ok := startSSE(w)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}
	h.bulkRunStream(r.Context(), w, flusher, func(p *models.Project) string {
		if p.Deployment == nil {
			return ""
		}
		return p.Deployment.StartProd
	})
}

// BulkRestartProdStream streams deployProd for all unpaused projects as SSE.
func (h *CIHandler) BulkRestartProdStream(w http.ResponseWriter, r *http.Request) {
	if !h.requireSuperAdmin(w, r) {
		return
	}
	flusher, ok := startSSE(w)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}
	h.bulkRunStream(r.Context(), w, flusher, func(p *models.Project) string {
		if p.Deployment == nil {
			return ""
		}
		return p.Deployment.DeployProd
	})
}

func (h *CIHandler) bulkRunStream(ctx context.Context, w http.ResponseWriter, flusher http.Flusher, cmdFor func(*models.Project) string) {
	emit := func(msg string) { sseEmit(w, flusher, msg) }

	projects, err := h.projectSvc.List(ctx)
	if err != nil {
		emit("ERROR: failed to list projects: " + err.Error())
		emit("DONE")
		return
	}

	for i := range projects {
		p := &projects[i]
		if p.Paused || p.Archived {
			continue
		}
		cmd := cmdFor(p)
		if cmd == "" || p.Links.LocalPath == "" {
			continue
		}
		emit("PROJECT:" + p.Name)
		lw := &funcWriter{fn: func(line string) { emit(line) }}
		runCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
		err := h.runCmdStream(runCtx, cmd, p.Links.LocalPath, 10*time.Minute, lw)
		cancel()
		if err != nil {
			emit("PROJECT_ERROR:" + p.Name)
		} else {
			emit("PROJECT_DONE:" + p.Name)
		}
	}
	emit("DONE")
}

// funcWriter sends each newline-delimited chunk to fn.
type funcWriter struct {
	fn      func(string)
	partial []byte
}

func (fw *funcWriter) Write(p []byte) (int, error) {
	data := append(fw.partial, p...)
	fw.partial = nil
	for {
		idx := -1
		for i, b := range data {
			if b == '\n' || b == '\r' {
				idx = i
				break
			}
		}
		if idx < 0 {
			fw.partial = data
			break
		}
		line := strings.TrimSpace(string(data[:idx]))
		if line != "" {
			fw.fn(line)
		}
		data = data[idx+1:]
	}
	return len(p), nil
}

// CIStatus is the response from GET /ci/status.
type CIStatus struct {
	LastCommit  *GitCommit  `json:"lastCommit,omitempty"`
	CheckRuns   []CheckRun  `json:"checkRuns,omitempty"`
	FetchedAt   time.Time   `json:"fetchedAt"`
	GitHubError string      `json:"githubError,omitempty"`
}

type GitCommit struct {
	SHA     string    `json:"sha"`
	Message string    `json:"message"`
	Author  string    `json:"author"`
	Date    time.Time `json:"date"`
	URL     string    `json:"url"`
}

type CheckRun struct {
	Name       string `json:"name"`
	Status     string `json:"status"`     // "queued", "in_progress", "completed"
	Conclusion string `json:"conclusion"` // "success", "failure", "neutral", etc.
	URL        string `json:"url"`
}

// Status fetches the last commit and CI check runs from GitHub.
func (h *CIHandler) Status(w http.ResponseWriter, r *http.Request) {
	project, ok := h.getProject(w, r)
	if !ok {
		return
	}

	result := CIStatus{FetchedAt: time.Now().UTC()}

	ghURL := ""
	if project.Links.GitHubURL != "" {
		ghURL = project.Links.GitHubURL
	}

	if ghURL == "" {
		middleware.WriteJSON(w, http.StatusOK, result)
		return
	}
	if h.githubToken == "" {
		result.GitHubError = "GitHub API token not configured on this server (GITHUB_TOKEN env var)"
		middleware.WriteJSON(w, http.StatusOK, result)
		return
	}

	// Parse owner/repo from GitHub URL
	owner, repo, err := parseGitHubURL(ghURL)
	if err != nil {
		result.GitHubError = err.Error()
		middleware.WriteJSON(w, http.StatusOK, result)
		return
	}

	// Fetch latest commit on default branch
	if commit, err := h.fetchLatestCommit(r.Context(), owner, repo); err == nil {
		result.LastCommit = commit
		// Fetch check runs for that commit
		if runs, err := h.fetchCheckRuns(r.Context(), owner, repo, commit.SHA); err == nil {
			result.CheckRuns = runs
		}
	} else {
		result.GitHubError = err.Error()
	}

	middleware.WriteJSON(w, http.StatusOK, result)
}

// Commit runs `git add -A && git commit -m <message>` in the project's local path.
// Requires: developer+ role.
func (h *CIHandler) Commit(w http.ResponseWriter, r *http.Request) {
	project, ok := h.getProject(w, r)
	if !ok {
		return
	}
	if !h.requireMinRole(w, r, project.ID, models.ProjectRoleDeveloper) {
		return
	}

	var req struct {
		Message string `json:"message"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	if req.Message == "" {
		req.Message = "Update " + time.Now().UTC().Format("2006-01-02 15:04:05 UTC")
	}

	user := middleware.GetCurrentUser(r)
	repoPath := project.Links.LocalPath
	if repoPath == "" {
		middleware.WriteError(w, http.StatusBadRequest, "project has no local path configured", "NO_LOCAL_PATH")
		return
	}

	output, err := runGitCommand(repoPath, user, "add", "-A")
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, "git add failed: "+output, "GIT_ERROR")
		return
	}

	commitOutput, err := runGitCommand(repoPath, user, "commit", "-m", req.Message)
	if err != nil {
		if strings.Contains(commitOutput, "nothing to commit") {
			middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "nothing_to_commit", "output": commitOutput})
			return
		}
		middleware.WriteError(w, http.StatusInternalServerError, "git commit failed: "+commitOutput, "GIT_ERROR")
		return
	}

	middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "committed", "output": commitOutput})
}

// Push runs `git push` in the project's local path.
// Requires: devops+ role (push to main is a higher-privilege action than commit).
func (h *CIHandler) Push(w http.ResponseWriter, r *http.Request) {
	project, ok := h.getProject(w, r)
	if !ok {
		return
	}
	if !h.requireMinRole(w, r, project.ID, models.ProjectRoleDevOps) {
		return
	}

	user := middleware.GetCurrentUser(r)
	repoPath := project.Links.LocalPath
	if repoPath == "" {
		middleware.WriteError(w, http.StatusBadRequest, "project has no local path configured", "NO_LOCAL_PATH")
		return
	}

	// Warn if user doesn't have GitHub push access (non-blocking — just informational)
	var githubWarning string
	if user.GitHubUsername != "" && project.Links.GitHubURL != "" {
		owner, repo, err := parseGitHubURL(project.Links.GitHubURL)
		if err == nil {
			perm, err := h.fetchGitHubPermission(r.Context(), owner, repo, user.GitHubUsername)
			if err == nil && perm != "admin" && perm != "write" {
				githubWarning = fmt.Sprintf("GitHub reports your permission on %s/%s is %q — the push may fail", owner, repo, perm)
			}
		}
	}

	output, err := runGitCommand(repoPath, user, "push")
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, "git push failed: "+output, "GIT_ERROR")
		return
	}

	resp := map[string]string{"status": "pushed", "output": output}
	if githubWarning != "" {
		resp["githubWarning"] = githubWarning
	}
	middleware.WriteJSON(w, http.StatusOK, resp)
}

// Deploy runs the project's configured deployProd command.
// Requires: devops+ role.
func (h *CIHandler) Deploy(w http.ResponseWriter, r *http.Request) {
	project, ok := h.getProject(w, r)
	if !ok {
		return
	}
	if !h.requireMinRole(w, r, project.ID, models.ProjectRoleDevOps) {
		return
	}

	if project.Deployment == nil || project.Deployment.DeployProd == "" {
		middleware.WriteError(w, http.StatusBadRequest, "no deployProd command configured for this project", "NO_DEPLOY_CMD")
		return
	}

	cmd := project.Deployment.DeployProd
	repoPath := project.Links.LocalPath

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()

	var execCmd *exec.Cmd
	execCmd = exec.CommandContext(ctx, "sh", "-c", cmd)
	if repoPath != "" {
		execCmd.Dir = repoPath
	}

	out, err := execCmd.CombinedOutput()
	output := string(out)
	if err != nil {
		slog.Error("deploy failed", "project", project.ID, "error", err, "output", output)
		middleware.WriteError(w, http.StatusInternalServerError, "deploy failed: "+output, "DEPLOY_FAILED")
		return
	}

	middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "deployed", "output": output})
}

// RestartDevStream streams the startDev command output as SSE.
func (h *CIHandler) RestartDevStream(w http.ResponseWriter, r *http.Request) {
	project, ok := h.getProject(w, r)
	if !ok {
		return
	}
	if !h.requireMinRole(w, r, project.ID, models.ProjectRoleDevOps) {
		return
	}

	flusher, ok := startSSE(w)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}
	emit := func(msg string) { sseEmit(w, flusher, msg) }

	if project.Deployment == nil || project.Deployment.StartDev == "" {
		emit("ERROR: no startDev command configured — set it in Settings → Deployment")
		emit("DONE")
		return
	}

	lw := &funcWriter{fn: func(line string) { emit(line) }}
	err := h.runCmdStream(r.Context(), project.Deployment.StartDev, project.Links.LocalPath, 5*time.Minute, lw)
	if err != nil {
		emit("ERROR: " + err.Error())
	}
	emit("DONE")
}

// RestartDev runs the project's configured startDev command.
func (h *CIHandler) RestartDev(w http.ResponseWriter, r *http.Request) {
	project, ok := h.getProject(w, r)
	if !ok {
		return
	}
	if !h.requireMinRole(w, r, project.ID, models.ProjectRoleDevOps) {
		return
	}
	if project.Deployment == nil || project.Deployment.StartDev == "" {
		middleware.WriteError(w, http.StatusBadRequest, "no startDev command configured for this project", "NO_START_DEV_CMD")
		return
	}
	output, err := h.runCmd(r.Context(), project.Deployment.StartDev, project.Links.LocalPath, 5*time.Minute)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, "restart dev failed: "+output, "RESTART_DEV_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "restarted", "output": output})
}

// RestartProd runs the project's configured restartProd command.
func (h *CIHandler) RestartProd(w http.ResponseWriter, r *http.Request) {
	project, ok := h.getProject(w, r)
	if !ok {
		return
	}
	if !h.requireMinRole(w, r, project.ID, models.ProjectRoleDevOps) {
		return
	}
	cmd := ""
	if project.Deployment != nil {
		cmd = project.Deployment.RestartProd
		if cmd == "" && project.Deployment.FlyApp != "" {
			cmd = "fly apps restart " + project.Deployment.FlyApp
		}
	}
	if cmd == "" {
		middleware.WriteError(w, http.StatusBadRequest, "no restartProd command configured for this project", "NO_RESTART_PROD_CMD")
		return
	}
	output, err := h.runCmd(r.Context(), cmd, project.Links.LocalPath, 5*time.Minute)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, "restart prod failed: "+output, "RESTART_PROD_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "restarted", "output": output})
}

// DeployAll runs commit (if message provided) → push → deploy in sequence.
func (h *CIHandler) DeployAll(w http.ResponseWriter, r *http.Request) {
	project, ok := h.getProject(w, r)
	if !ok {
		return
	}
	if !h.requireMinRole(w, r, project.ID, models.ProjectRoleDevOps) {
		return
	}

	var req struct {
		CommitMessage string `json:"commitMessage"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	repoPath := project.Links.LocalPath
	if repoPath == "" {
		middleware.WriteError(w, http.StatusBadRequest, "no local path configured", "NO_LOCAL_PATH")
		return
	}

	type stepResult struct {
		Step   string `json:"step"`
		Output string `json:"output"`
	}
	var steps []stepResult
	var combinedErr string

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Minute)
	defer cancel()

	// Step 1: commit (optional — only if message provided)
	if req.CommitMessage != "" {
		out, err := h.runCmd(ctx, fmt.Sprintf("git add -A && git commit -m %q", req.CommitMessage), repoPath, 30*time.Second)
		steps = append(steps, stepResult{"commit", out})
		if err != nil && !strings.Contains(out, "nothing to commit") {
			combinedErr = "commit failed: " + out
			middleware.WriteJSON(w, http.StatusInternalServerError, map[string]any{"error": combinedErr, "steps": steps})
			return
		}
	}

	// Step 2: push
	if project.Links.GitHubURL != "" {
		out, err := h.runCmd(ctx, "git push", repoPath, 2*time.Minute)
		steps = append(steps, stepResult{"push", out})
		if err != nil {
			combinedErr = "push failed: " + out
			middleware.WriteJSON(w, http.StatusInternalServerError, map[string]any{"error": combinedErr, "steps": steps})
			return
		}
	}

	// Step 3: deploy
	if project.Deployment == nil || project.Deployment.DeployProd == "" {
		middleware.WriteError(w, http.StatusBadRequest, "no deployProd command configured", "NO_DEPLOY_CMD")
		return
	}
	out, err := h.runCmd(ctx, project.Deployment.DeployProd, repoPath, 10*time.Minute)
	steps = append(steps, stepResult{"deploy", out})
	if err != nil {
		combinedErr = "deploy failed: " + out
		middleware.WriteJSON(w, http.StatusInternalServerError, map[string]any{"error": combinedErr, "steps": steps})
		return
	}

	middleware.WriteJSON(w, http.StatusOK, map[string]any{"status": "deployed", "steps": steps})
}

// TogglePause flips the paused state on a project.
func (h *CIHandler) TogglePause(w http.ResponseWriter, r *http.Request) {
	project, ok := h.getProject(w, r)
	if !ok {
		return
	}
	if !h.requireMinRole(w, r, project.ID, models.ProjectRoleDevOps) {
		return
	}
	newPaused := !project.Paused
	if err := h.projectSvc.SetPaused(r.Context(), project.ID, newPaused); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "PAUSE_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, map[string]bool{"paused": newPaused})
}

// StartProd runs the project's configured startProd command.
func (h *CIHandler) StartProd(w http.ResponseWriter, r *http.Request) {
	project, ok := h.getProject(w, r)
	if !ok {
		return
	}
	if !h.requireMinRole(w, r, project.ID, models.ProjectRoleDevOps) {
		return
	}
	cmd := ""
	if project.Deployment != nil {
		cmd = project.Deployment.StartProd
		if cmd == "" && project.Deployment.FlyApp != "" {
			cmd = "fly apps start " + project.Deployment.FlyApp
		}
	}
	if cmd == "" {
		middleware.WriteError(w, http.StatusBadRequest, "no startProd command configured for this project", "NO_START_PROD_CMD")
		return
	}
	output, err := h.runCmd(r.Context(), cmd, project.Links.LocalPath, 5*time.Minute)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, "start prod failed: "+output, "START_PROD_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "started", "output": output})
}

// BulkStartProd starts production for all unpaused projects that have a startProd command.
func (h *CIHandler) BulkStartProd(w http.ResponseWriter, r *http.Request) {
	if !h.requireSuperAdmin(w, r) {
		return
	}
	ctx := r.Context()
	projects, err := h.projectSvc.List(ctx)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_FAILED")
		return
	}

	type result struct {
		ProjectID   string `json:"projectId"`
		ProjectName string `json:"projectName"`
		Status      string `json:"status"`
		Output      string `json:"output,omitempty"`
		Error       string `json:"error,omitempty"`
	}

	results := make([]result, 0)
	for _, p := range projects {
		if p.Paused || p.Archived || p.Deployment == nil || p.Deployment.StartProd == "" {
			continue
		}
		out, err := h.runCmd(ctx, p.Deployment.StartProd, p.Links.LocalPath, 5*time.Minute)
		r := result{ProjectID: p.ID.Hex(), ProjectName: p.Name}
		if err != nil {
			r.Status = "error"
			r.Error = out
			slog.Error("bulk start-prod failed", "project", p.Name, "error", err)
		} else {
			r.Status = "started"
			r.Output = out
		}
		results = append(results, r)
	}
	middleware.WriteJSON(w, http.StatusOK, map[string]any{"results": results})
}

// BulkRestartProd redeploys and restarts production for all unpaused projects with a deployProd command.
func (h *CIHandler) BulkRestartProd(w http.ResponseWriter, r *http.Request) {
	if !h.requireSuperAdmin(w, r) {
		return
	}
	ctx := r.Context()
	projects, err := h.projectSvc.List(ctx)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_FAILED")
		return
	}

	type result struct {
		ProjectID   string `json:"projectId"`
		ProjectName string `json:"projectName"`
		Status      string `json:"status"`
		Output      string `json:"output,omitempty"`
		Error       string `json:"error,omitempty"`
	}

	results := make([]result, 0)
	for _, p := range projects {
		if p.Paused || p.Archived || p.Deployment == nil || p.Deployment.DeployProd == "" {
			continue
		}
		out, err := h.runCmd(ctx, p.Deployment.DeployProd, p.Links.LocalPath, 10*time.Minute)
		r := result{ProjectID: p.ID.Hex(), ProjectName: p.Name}
		if err != nil {
			r.Status = "error"
			r.Error = out
			slog.Error("bulk restart-prod failed", "project", p.Name, "error", err)
		} else {
			r.Status = "restarted"
			r.Output = out
		}
		results = append(results, r)
	}
	middleware.WriteJSON(w, http.StatusOK, map[string]any{"results": results})
}

func (h *CIHandler) runCmd(ctx context.Context, cmd, dir string, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	execCmd := exec.CommandContext(ctx, "sh", "-c", cmd)
	execCmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if dir != "" {
		execCmd.Dir = dir
	}
	out, err := execCmd.CombinedOutput()
	return string(out), err
}

// --- helpers ---

func (h *CIHandler) getProject(w http.ResponseWriter, r *http.Request) (*models.Project, bool) {
	id := chi.URLParam(r, "id")
	p, err := h.projectSvc.GetByID(r.Context(), id)
	if err != nil || p == nil {
		middleware.WriteError(w, http.StatusNotFound, "project not found", "PROJECT_NOT_FOUND")
		return nil, false
	}
	return p, true
}

func (h *CIHandler) requireMinRole(w http.ResponseWriter, r *http.Request, projectID bson.ObjectID, minRole models.ProjectRole) bool {
	user := middleware.GetCurrentUser(r)
	if user == nil {
		middleware.WriteError(w, http.StatusUnauthorized, "not authenticated", "UNAUTHORIZED")
		return false
	}
	if user.GlobalRole == models.GlobalRoleSuperAdmin {
		return true
	}
	project, err := h.projectSvc.GetByID(r.Context(), projectID.Hex())
	if err != nil || project == nil {
		middleware.WriteError(w, http.StatusNotFound, "project not found", "PROJECT_NOT_FOUND")
		return false
	}
	has, err := h.memberSvc.HasRole(r.Context(), project.Code, user.ID, minRole)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "PERMISSION_CHECK_FAILED")
		return false
	}
	if !has {
		middleware.WriteError(w, http.StatusForbidden, "insufficient project permissions", "FORBIDDEN")
		return false
	}
	return true
}

func (h *CIHandler) requireSuperAdmin(w http.ResponseWriter, r *http.Request) bool {
	user := middleware.GetCurrentUser(r)
	if user == nil {
		middleware.WriteError(w, http.StatusUnauthorized, "not authenticated", "UNAUTHORIZED")
		return false
	}
	if user.GlobalRole != models.GlobalRoleSuperAdmin {
		middleware.WriteError(w, http.StatusForbidden, "super admin required", "FORBIDDEN")
		return false
	}
	return true
}

// runGitCommand runs a git subcommand in the given directory, setting the user's git identity.
func runGitCommand(dir string, user *models.User, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir

	// Set git identity from user profile
	gitName := user.GitName
	if gitName == "" {
		gitName = user.DisplayName
	}
	gitEmail := user.GitEmail
	if gitEmail == "" && user.Email != "" {
		gitEmail = user.Email
	}
	if gitEmail == "" {
		gitEmail = user.DisplayName + "@vibectl.local"
	}
	cmd.Env = append(cmd.Env,
		"GIT_AUTHOR_NAME="+gitName,
		"GIT_AUTHOR_EMAIL="+gitEmail,
		"GIT_COMMITTER_NAME="+gitName,
		"GIT_COMMITTER_EMAIL="+gitEmail,
		"HOME="+getHomeDir(),
		"PATH=/usr/bin:/bin:/usr/local/bin",
	)

	out, err := cmd.CombinedOutput()
	return string(out), err
}

func getHomeDir() string {
	if h := strings.TrimSpace(runSimpleCommand("sh", "-c", "echo $HOME")); h != "" {
		return h
	}
	return "/root"
}

func runSimpleCommand(name string, args ...string) string {
	out, _ := exec.Command(name, args...).Output()
	return strings.TrimSpace(string(out))
}

func parseGitHubURL(ghURL string) (owner, repo string, err error) {
	// Handle https://github.com/owner/repo or https://github.com/owner/repo.git
	ghURL = strings.TrimSuffix(ghURL, ".git")
	parts := strings.Split(strings.TrimPrefix(ghURL, "https://github.com/"), "/")
	if len(parts) < 2 {
		return "", "", fmt.Errorf("invalid GitHub URL: %s", ghURL)
	}
	return parts[0], parts[1], nil
}

func (h *CIHandler) fetchLatestCommit(ctx context.Context, owner, repo string) (*GitCommit, error) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/%s/commits?per_page=1", owner, repo)
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.Header.Set("Authorization", "Bearer "+h.githubToken)
	req.Header.Set("Accept", "application/vnd.github.v3+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var commits []struct {
		SHA    string `json:"sha"`
		Commit struct {
			Message string `json:"message"`
			Author  struct {
				Name string    `json:"name"`
				Date time.Time `json:"date"`
			} `json:"author"`
		} `json:"commit"`
		HTMLURL string `json:"html_url"`
	}
	if err := json.Unmarshal(body, &commits); err != nil || len(commits) == 0 {
		return nil, fmt.Errorf("no commits found")
	}
	c := commits[0]
	msg := c.Commit.Message
	if idx := strings.Index(msg, "\n"); idx >= 0 {
		msg = msg[:idx]
	}
	return &GitCommit{
		SHA:     c.SHA[:7],
		Message: msg,
		Author:  c.Commit.Author.Name,
		Date:    c.Commit.Author.Date,
		URL:     c.HTMLURL,
	}, nil
}

func (h *CIHandler) fetchCheckRuns(ctx context.Context, owner, repo, sha string) ([]CheckRun, error) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/%s/commits/%s/check-runs", owner, repo, sha)
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.Header.Set("Authorization", "Bearer "+h.githubToken)
	req.Header.Set("Accept", "application/vnd.github.v3+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var result struct {
		CheckRuns []struct {
			Name       string `json:"name"`
			Status     string `json:"status"`
			Conclusion string `json:"conclusion"`
			HTMLURL    string `json:"html_url"`
		} `json:"check_runs"`
	}
	body, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}
	runs := make([]CheckRun, len(result.CheckRuns))
	for i, r := range result.CheckRuns {
		runs[i] = CheckRun{Name: r.Name, Status: r.Status, Conclusion: r.Conclusion, URL: r.HTMLURL}
	}
	return runs, nil
}

func (h *CIHandler) fetchGitHubPermission(ctx context.Context, owner, repo, username string) (string, error) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/%s/collaborators/%s/permission", owner, repo, username)
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.Header.Set("Authorization", "Bearer "+h.githubToken)
	req.Header.Set("Accept", "application/vnd.github.v3+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var result struct {
		Permission string `json:"permission"`
	}
	body, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(body, &result); err != nil {
		return "", err
	}
	return result.Permission, nil
}
