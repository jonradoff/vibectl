package agents

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/jonradoff/vibectl/internal/services"
)

// ArchitectureAgent generates architecture summaries by analyzing project directories.
type ArchitectureAgent struct {
	projectService *services.ProjectService
	aiClient       *AIClient
}

func NewArchitectureAgent(ps *services.ProjectService, apiKey string) *ArchitectureAgent {
	return &ArchitectureAgent{
		projectService: ps,
		aiClient:       NewAIClient(apiKey),
	}
}

// Summarize generates an architecture summary for a project by reading its directory structure.
func (a *ArchitectureAgent) Summarize(ctx context.Context, projectID string) (string, error) {
	project, err := a.projectService.GetByID(ctx, projectID)
	if err != nil {
		return "", fmt.Errorf("getting project: %w", err)
	}

	localPath := project.Links.LocalPath
	if localPath == "" {
		return "", fmt.Errorf("no local path configured")
	}

	if _, err := os.Stat(localPath); os.IsNotExist(err) {
		return "", fmt.Errorf("local path not accessible: %s", localPath)
	}

	dirListing := scanDirectory(localPath, 2)

	prompt := fmt.Sprintf(`You are analyzing the technical architecture of the project at "%s".

Look at the directory structure and key files to determine:
- Primary languages and frameworks
- Key directories and what they contain
- Data storage approach
- Deployment model
- Notable patterns or conventions

Keep the summary to 3-5 concise bullet points.

Directory listing:
%s`, localPath, dirListing)

	response, err := a.aiClient.Complete(ctx, prompt)
	if err != nil {
		return "", fmt.Errorf("AI completion: %w", err)
	}

	return strings.TrimSpace(response), nil
}

// scanDirectory lists files and directories up to maxDepth levels, excluding common noise.
func scanDirectory(root string, maxDepth int) string {
	var b strings.Builder
	excluded := map[string]bool{
		"node_modules": true, ".git": true, "vendor": true, ".vite": true,
		"dist": true, "__pycache__": true, ".next": true, ".cache": true,
		"coverage": true, ".mypy_cache": true, "target": true,
	}

	var walk func(path string, depth int)
	walk = func(path string, depth int) {
		if depth > maxDepth {
			return
		}
		entries, err := os.ReadDir(path)
		if err != nil {
			return
		}
		indent := strings.Repeat("  ", depth)
		for _, entry := range entries {
			name := entry.Name()
			if strings.HasPrefix(name, ".") && depth == 0 && name != ".env.example" {
				continue
			}
			if excluded[name] {
				continue
			}
			if entry.IsDir() {
				fmt.Fprintf(&b, "%s%s/\n", indent, name)
				walk(filepath.Join(path, name), depth+1)
			} else {
				fmt.Fprintf(&b, "%s%s\n", indent, name)
			}
		}
	}

	walk(root, 0)
	return b.String()
}
