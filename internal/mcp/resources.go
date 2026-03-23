package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
)

func (s *MCPServer) registerResources() {
	// Static resource: list all projects
	s.server.AddResource(
		mcp.NewResource(
			"vibectl://projects",
			"All Projects",
			mcp.WithResourceDescription("List of all projects in vibectl with their codes, descriptions, and issue counters"),
			mcp.WithMIMEType("application/json"),
		),
		func(ctx context.Context, request mcp.ReadResourceRequest) ([]mcp.ResourceContents, error) {
			projects, err := s.backend.ListProjects(ctx)
			if err != nil {
				return nil, fmt.Errorf("failed to list projects: %w", err)
			}
			data, err := json.MarshalIndent(projects, "", "  ")
			if err != nil {
				return nil, fmt.Errorf("failed to marshal projects: %w", err)
			}
			return []mcp.ResourceContents{
				mcp.TextResourceContents{
					URI:      "vibectl://projects",
					MIMEType: "application/json",
					Text:     string(data),
				},
			}, nil
		},
	)

	// Template resource: single project by code
	s.server.AddResourceTemplate(
		mcp.NewResourceTemplate(
			"vibectl://projects/{code}",
			"Project by code",
			mcp.WithTemplateDescription("Get a single project by its unique code"),
		),
		func(ctx context.Context, request mcp.ReadResourceRequest) ([]mcp.ResourceContents, error) {
			code := extractURIParam(request.Params.URI, "vibectl://projects/", 0)
			if code == "" {
				return nil, fmt.Errorf("missing project code in URI")
			}

			project, err := s.backend.GetProjectByCode(ctx, code)
			if err != nil {
				return nil, fmt.Errorf("failed to get project: %w", err)
			}
			data, err := json.MarshalIndent(project, "", "  ")
			if err != nil {
				return nil, fmt.Errorf("failed to marshal project: %w", err)
			}
			return []mcp.ResourceContents{
				mcp.TextResourceContents{
					URI:      request.Params.URI,
					MIMEType: "application/json",
					Text:     string(data),
				},
			}, nil
		},
	)

	// Template resource: issues for a project
	s.server.AddResourceTemplate(
		mcp.NewResourceTemplate(
			"vibectl://projects/{code}/issues",
			"Project issues",
			mcp.WithTemplateDescription("List all issues for a project by its code"),
		),
		func(ctx context.Context, request mcp.ReadResourceRequest) ([]mcp.ResourceContents, error) {
			// URI: vibectl://projects/{code}/issues
			code := extractMiddleParam(request.Params.URI, "vibectl://projects/", "/issues")
			if code == "" {
				return nil, fmt.Errorf("missing project code in URI")
			}

			project, err := s.backend.GetProjectByCode(ctx, code)
			if err != nil {
				return nil, fmt.Errorf("failed to get project: %w", err)
			}

			issues, err := s.backend.ListIssues(ctx, project.ID.Hex(), nil)
			if err != nil {
				return nil, fmt.Errorf("failed to list issues: %w", err)
			}
			data, err := json.MarshalIndent(issues, "", "  ")
			if err != nil {
				return nil, fmt.Errorf("failed to marshal issues: %w", err)
			}
			return []mcp.ResourceContents{
				mcp.TextResourceContents{
					URI:      request.Params.URI,
					MIMEType: "application/json",
					Text:     string(data),
				},
			}, nil
		},
	)

	// Template resource: single issue by key
	s.server.AddResourceTemplate(
		mcp.NewResourceTemplate(
			"vibectl://issues/{issueKey}",
			"Issue by key",
			mcp.WithTemplateDescription("Get a single issue by its key (e.g. PROJ-0001)"),
		),
		func(ctx context.Context, request mcp.ReadResourceRequest) ([]mcp.ResourceContents, error) {
			issueKey := extractURIParam(request.Params.URI, "vibectl://issues/", 0)
			if issueKey == "" {
				return nil, fmt.Errorf("missing issue key in URI")
			}

			issue, err := s.backend.GetIssueByKey(ctx, issueKey)
			if err != nil {
				return nil, fmt.Errorf("failed to get issue: %w", err)
			}
			data, err := json.MarshalIndent(issue, "", "  ")
			if err != nil {
				return nil, fmt.Errorf("failed to marshal issue: %w", err)
			}
			return []mcp.ResourceContents{
				mcp.TextResourceContents{
					URI:      request.Params.URI,
					MIMEType: "application/json",
					Text:     string(data),
				},
			}, nil
		},
	)
}

// extractURIParam extracts a path segment from a URI after a prefix.
// For "vibectl://projects/PROJ" with prefix "vibectl://projects/", returns "PROJ".
func extractURIParam(uri, prefix string, _ int) string {
	if !strings.HasPrefix(uri, prefix) {
		return ""
	}
	rest := strings.TrimPrefix(uri, prefix)
	// Take everything before the next slash, if any.
	if idx := strings.Index(rest, "/"); idx >= 0 {
		return rest[:idx]
	}
	return rest
}

// extractMiddleParam extracts a path segment between a prefix and suffix.
// For "vibectl://projects/PROJ/issues" with prefix "vibectl://projects/" and suffix "/issues", returns "PROJ".
func extractMiddleParam(uri, prefix, suffix string) string {
	if !strings.HasPrefix(uri, prefix) || !strings.HasSuffix(uri, suffix) {
		return ""
	}
	middle := strings.TrimPrefix(uri, prefix)
	middle = strings.TrimSuffix(middle, suffix)
	return middle
}
