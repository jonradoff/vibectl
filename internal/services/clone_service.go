package services

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/jonradoff/vibectl/internal/models"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// CloneService manages git clone/pull/remove operations for projects.
type CloneService struct {
	projectService *ProjectService
	userService    *UserService
	reposDir       string
	systemToken    string // fallback: GITHUB_TOKEN env var
}

func NewCloneService(ps *ProjectService, us *UserService, reposDir, systemToken string) *CloneService {
	return &CloneService{
		projectService: ps,
		userService:    us,
		reposDir:       reposDir,
		systemToken:    systemToken,
	}
}

// RepoDir returns the directory where a project's repo would be cloned (legacy, uses project code).
func (s *CloneService) RepoDir(code string) string {
	return filepath.Join(s.reposDir, strings.ToLower(code))
}

// RepoDirForURL returns the deterministic clone directory derived from a GitHub URL.
// https://github.com/owner/repo → <reposDir>/owner/repo
func (s *CloneService) RepoDirForURL(githubURL string) string {
	owner, repo := parseGitHubOwnerRepo(githubURL)
	if owner == "" || repo == "" {
		return filepath.Join(s.reposDir, sanitizePath(githubURL))
	}
	return filepath.Join(s.reposDir, owner, repo)
}

// SuggestPath returns the server-side path where a GitHub URL would be cloned.
func (s *CloneService) SuggestPath(githubURL string) string {
	return s.RepoDirForURL(githubURL)
}

// SuggestNewPath returns the path for a brand-new (non-cloned) project directory.
// Convention: <reposDir>/projects/<code_lower>
func (s *CloneService) SuggestNewPath(code string) string {
	return filepath.Join(s.reposDir, "projects", strings.ToLower(code))
}

// parseGitHubOwnerRepo extracts owner and repo name from a GitHub URL.
// Handles https://github.com/owner/repo[.git] and git@github.com:owner/repo[.git]
func parseGitHubOwnerRepo(rawURL string) (owner, repo string) {
	rawURL = strings.TrimSpace(rawURL)
	rawURL = strings.TrimSuffix(rawURL, ".git")
	// SSH format: git@github.com:owner/repo
	if strings.HasPrefix(rawURL, "git@github.com:") {
		parts := strings.SplitN(strings.TrimPrefix(rawURL, "git@github.com:"), "/", 2)
		if len(parts) == 2 && parts[0] != "" && parts[1] != "" {
			return parts[0], parts[1]
		}
		return "", ""
	}
	// HTTPS format
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", ""
	}
	pathParts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(pathParts) >= 2 && pathParts[0] != "" && pathParts[1] != "" {
		return pathParts[0], pathParts[1]
	}
	return "", ""
}

// sanitizePath turns an arbitrary string into a safe directory name.
func sanitizePath(s string) string {
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteRune('-')
		}
	}
	result := b.String()
	if result == "" {
		return "repo"
	}
	return result
}

// CloneProject clones the project's GitHub repo, streaming git output to w.
// It updates cloneStatus in the DB as it runs.
func (s *CloneService) CloneProject(ctx context.Context, projectID string, userID bson.ObjectID, w io.Writer) error {
	project, err := s.projectService.GetByID(ctx, projectID)
	if err != nil || project == nil {
		return fmt.Errorf("project not found")
	}
	repoURL := project.Links.GitHubURL
	if repoURL == "" {
		return fmt.Errorf("project has no GitHub URL configured")
	}

	token, err := s.getToken(ctx, userID)
	if err != nil {
		return fmt.Errorf("getting credentials: %w", err)
	}

	destDir := s.RepoDirForURL(repoURL)

	// Mark as cloning
	s.projectService.UpdateCloneStatus(ctx, projectID, "cloning", "")

	// Remove existing clone if present
	if err := os.RemoveAll(destDir); err != nil {
		return fmt.Errorf("removing existing dir: %w", err)
	}
	if err := os.MkdirAll(s.reposDir, 0755); err != nil {
		return fmt.Errorf("creating repos dir: %w", err)
	}

	cloneURL := injectToken(repoURL, token)

	fmt.Fprintf(w, "Cloning %s...\n", redactToken(cloneURL))

	cmd := exec.CommandContext(ctx, "git", "clone", "--progress", cloneURL, destDir)
	cmd.Stdout = w
	cmd.Stderr = w
	cmd.Env = append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"GCM_INTERACTIVE=never",
	)

	if err := cmd.Run(); err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, "403") || strings.Contains(errMsg, "not found") || strings.Contains(errMsg, "access") {
			s.projectService.UpdateCloneStatus(ctx, projectID, "error", "authentication failed")
			return fmt.Errorf("git clone failed: could not access repository — set a GitHub Personal Access Token (with repo scope) in your Profile")
		}
		s.projectService.UpdateCloneStatus(ctx, projectID, "error", errMsg)
		return fmt.Errorf("git clone failed: %w", err)
	}

	// Update localPath and cloneStatus
	if err := s.projectService.UpdateCloneStatus(ctx, projectID, "cloned", ""); err != nil {
		return err
	}
	proj, _ := s.projectService.GetByID(ctx, projectID)
	if proj != nil {
		links := proj.Links
		links.LocalPath = destDir
		s.projectService.Update(ctx, projectID, &models.UpdateProjectRequest{Links: &links})
	}

	fmt.Fprintf(w, "\nClone complete: %s\n", destDir)
	return nil
}

// PullProject runs git pull in the project's cloned directory, streaming output to w.
func (s *CloneService) PullProject(ctx context.Context, projectID string, userID bson.ObjectID, w io.Writer) error {
	project, err := s.projectService.GetByID(ctx, projectID)
	if err != nil || project == nil {
		return fmt.Errorf("project not found")
	}
	localPath := project.Links.LocalPath
	if localPath == "" {
		return fmt.Errorf("no local path set — use Clone to set up the repo first")
	}

	// Check the directory is actually a git repo before trying to pull
	checkCmd := exec.CommandContext(ctx, "git", "-C", localPath, "rev-parse", "--git-dir")
	checkCmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	if err := checkCmd.Run(); err != nil {
		// Clear the stale localPath so the UI shows Clone instead of Pull
		links := project.Links
		links.LocalPath = ""
		s.projectService.Update(ctx, projectID, &models.UpdateProjectRequest{Links: &links})
		s.projectService.UpdateCloneStatus(ctx, projectID, "", "")
		return fmt.Errorf("directory exists but is not a git repository — use Clone to set it up")
	}

	token, err := s.getToken(ctx, userID)
	if err != nil {
		return fmt.Errorf("getting credentials: %w", err)
	}

	fmt.Fprintf(w, "Pulling latest changes...\n")

	cmd := exec.CommandContext(ctx, "git", "-C", localPath, "pull", "--progress")
	if token != "" {
		// Set credential helper via env to avoid storing credentials
		cmd = exec.CommandContext(ctx, "git", "-C", localPath, "pull", "--progress",
			"--config", fmt.Sprintf("credential.helper=!f() { echo username=oauth2; echo password=%s; }; f", token))
	}
	cmd.Stdout = w
	cmd.Stderr = w
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("git pull failed: %w", err)
	}

	// Update timestamp
	s.projectService.UpdateCloneStatus(ctx, projectID, "cloned", "")
	fmt.Fprintf(w, "\nPull complete.\n")
	return nil
}

// RemoveClone deletes the local clone and clears localPath.
func (s *CloneService) RemoveClone(ctx context.Context, projectID string) error {
	project, err := s.projectService.GetByID(ctx, projectID)
	if err != nil || project == nil {
		return fmt.Errorf("project not found")
	}
	if project.Links.LocalPath != "" {
		os.RemoveAll(project.Links.LocalPath)
	}
	// Clear localPath and reset clone status
	proj, _ := s.projectService.GetByID(ctx, projectID)
	if proj != nil {
		links := proj.Links
		links.LocalPath = ""
		s.projectService.Update(ctx, projectID, &models.UpdateProjectRequest{Links: &links})
	}
	return s.projectService.UpdateCloneStatus(ctx, projectID, "", "")
}

// getToken returns the user's GitHub PAT, or falls back to the system token.
func (s *CloneService) getToken(ctx context.Context, userID bson.ObjectID) (string, error) {
	if !userID.IsZero() {
		pat, err := s.userService.GetGitHubPAT(ctx, userID)
		if err != nil {
			return "", err
		}
		if pat != "" {
			return pat, nil
		}
	}
	return s.systemToken, nil
}

// injectToken inserts a token into a GitHub HTTPS URL.
// https://github.com/... → https://oauth2:{token}@github.com/...
func injectToken(rawURL, token string) string {
	if token == "" {
		return rawURL
	}
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme != "https" {
		return rawURL
	}
	u.User = url.UserPassword("oauth2", token)
	return u.String()
}

// redactToken removes credential info from a URL for display.
func redactToken(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	u.User = nil
	return u.String()
}

// CloneStatusResponse is returned by the GET clone-status endpoint.
type CloneStatusResponse struct {
	CloneStatus string    `json:"cloneStatus"`
	CloneError  string    `json:"cloneError,omitempty"`
	LocalPath   string    `json:"localPath,omitempty"`
	UpdatedAt   time.Time `json:"updatedAt"`
}
