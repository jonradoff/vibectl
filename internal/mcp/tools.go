package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jonradoff/vibectl/internal/models"
	"github.com/mark3labs/mcp-go/mcp"
)

func (s *MCPServer) registerTools() {
	defer s.registerAdditionalTools()
	// 1. list_projects
	s.server.AddTool(
		mcp.NewTool("list_projects",
			mcp.WithDescription("List all projects in vibectl. Returns project name, code, description, goals, and issue counter."),
			mcp.WithReadOnlyHintAnnotation(true),
		),
		s.handleListProjects,
	)

	// 2. get_project
	s.server.AddTool(
		mcp.NewTool("get_project",
			mcp.WithDescription("Get a project by its unique code (e.g. PROJ, MYAPP)."),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithString("code", mcp.Required(), mcp.Description("Project code (3-5 uppercase letters)")),
		),
		s.handleGetProject,
	)

	// 3. list_issues
	s.server.AddTool(
		mcp.NewTool("list_issues",
			mcp.WithDescription("List issues for a project, optionally filtered by priority, status, or type."),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithString("projectCode", mcp.Required(), mcp.Description("Project code")),
			mcp.WithString("priority", mcp.Description("Filter by priority (P0-P5)")),
			mcp.WithString("status", mcp.Description("Filter by status (open, fixed, closed, etc.)")),
			mcp.WithString("type", mcp.Description("Filter by type (bug, feature, idea)")),
		),
		s.handleListIssues,
	)

	// 4. get_issue
	s.server.AddTool(
		mcp.NewTool("get_issue",
			mcp.WithDescription("Get a single issue by its key (e.g. PROJ-0001)."),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithString("issueKey", mcp.Required(), mcp.Description("Issue key (e.g. PROJ-0001)")),
		),
		s.handleGetIssue,
	)

	// 5. search_issues
	s.server.AddTool(
		mcp.NewTool("search_issues",
			mcp.WithDescription("Full-text search across issue titles and descriptions."),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithString("query", mcp.Required(), mcp.Description("Search query")),
			mcp.WithString("projectCode", mcp.Description("Optionally scope search to a project code")),
		),
		s.handleSearchIssues,
	)

	// 6. create_issue
	s.server.AddTool(
		mcp.NewTool("create_issue",
			mcp.WithDescription("Create a new issue in a project."),
			mcp.WithString("projectCode", mcp.Required(), mcp.Description("Project code")),
			mcp.WithString("title", mcp.Required(), mcp.Description("Issue title")),
			mcp.WithString("description", mcp.Required(), mcp.Description("Issue description")),
			mcp.WithString("type", mcp.Required(), mcp.Description("Issue type: bug, feature, or idea")),
			mcp.WithString("priority", mcp.Required(), mcp.Description("Priority: P0, P1, P2, P3, P4, or P5")),
			mcp.WithString("reproSteps", mcp.Description("Reproduction steps (required for bugs)")),
			mcp.WithString("source", mcp.Description("Source of the issue (e.g. user_report, code_review)")),
			mcp.WithString("createdBy", mcp.Description("Who created the issue")),
			mcp.WithString("dueDate", mcp.Description("Due date (RFC3339 or YYYY-MM-DD format)")),
		),
		s.handleCreateIssue,
	)

	// 7. update_issue_status
	s.server.AddTool(
		mcp.NewTool("update_issue_status",
			mcp.WithDescription("Transition an issue to a new status. Validates allowed status transitions by issue type."),
			mcp.WithString("issueKey", mcp.Required(), mcp.Description("Issue key (e.g. PROJ-0001)")),
			mcp.WithString("newStatus", mcp.Required(), mcp.Description("New status to transition to")),
		),
		s.handleUpdateIssueStatus,
	)

	// 8. update_issue
	s.server.AddTool(
		mcp.NewTool("update_issue",
			mcp.WithDescription("Update mutable fields of an issue (title, description, priority, source, dueDate, reproSteps)."),
			mcp.WithString("issueKey", mcp.Required(), mcp.Description("Issue key (e.g. PROJ-0001)")),
			mcp.WithString("title", mcp.Description("New title")),
			mcp.WithString("description", mcp.Description("New description")),
			mcp.WithString("priority", mcp.Description("New priority (P0-P5)")),
			mcp.WithString("source", mcp.Description("New source")),
			mcp.WithString("dueDate", mcp.Description("New due date (RFC3339 or YYYY-MM-DD, empty string to clear)")),
			mcp.WithString("reproSteps", mcp.Description("New reproduction steps")),
		),
		s.handleUpdateIssue,
	)

	// 9. get_project_dashboard
	s.server.AddTool(
		mcp.NewTool("get_project_dashboard",
			mcp.WithDescription("Get a project dashboard summary: open issue count, issues by priority, issues by status, and issues by type."),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithString("projectCode", mcp.Required(), mcp.Description("Project code")),
		),
		s.handleGetProjectDashboard,
	)

	// 10. get_open_p0_issues
	s.server.AddTool(
		mcp.NewTool("get_open_p0_issues",
			mcp.WithDescription("Get all open P0 (critical) issues, optionally scoped to a project."),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithString("projectCode", mcp.Description("Optionally scope to a project code")),
		),
		s.handleGetOpenP0Issues,
	)

	// 11. get_vibectl_md
	s.server.AddTool(
		mcp.NewTool("get_vibectl_md",
			mcp.WithDescription("Get the VIBECTL.md content for a project. Contains project status, deployment info, decisions, and more."),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithString("projectCode", mcp.Required(), mcp.Description("Project code")),
		),
		s.handleGetVibectlMd,
	)

	// 12. regenerate_vibectl_md
	s.server.AddTool(
		mcp.NewTool("regenerate_vibectl_md",
			mcp.WithDescription("Regenerate the VIBECTL.md file for a project. Writes to the project's local path."),
			mcp.WithString("projectCode", mcp.Required(), mcp.Description("Project code")),
		),
		s.handleRegenerateVibectlMd,
	)

	// 13. get_decisions
	s.server.AddTool(
		mcp.NewTool("get_decisions",
			mcp.WithDescription("Get recent decisions (audit log) for a project."),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithString("projectCode", mcp.Required(), mcp.Description("Project code")),
			mcp.WithNumber("limit", mcp.Description("Number of decisions to return (default 20)")),
		),
		s.handleGetDecisions,
	)

	// 14. record_decision
	s.server.AddTool(
		mcp.NewTool("record_decision",
			mcp.WithDescription("Record a manual decision entry for a project. Use this to log significant decisions made during development."),
			mcp.WithString("projectCode", mcp.Required(), mcp.Description("Project code")),
			mcp.WithString("summary", mcp.Required(), mcp.Description("Human-readable summary of the decision")),
			mcp.WithString("issueKey", mcp.Description("Related issue key (e.g. PROJ-0001)")),
		),
		s.handleRecordDecision,
	)

	// 15. get_deployment_info
	s.server.AddTool(
		mcp.NewTool("get_deployment_info",
			mcp.WithDescription("Get deployment configuration and health status for a project."),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithString("projectCode", mcp.Required(), mcp.Description("Project code")),
		),
		s.handleGetDeploymentInfo,
	)
}

// --- Handlers ---

func (s *MCPServer) handleListProjects(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	projects, err := s.projects.List(ctx)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("failed to list projects: %v", err)), nil
	}
	return jsonResult(projects)
}

func (s *MCPServer) handleGetProject(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	code, err := req.RequireString("code")
	if err != nil {
		return mcp.NewToolResultError("code is required"), nil
	}

	project, err := s.projects.GetByCode(ctx, code)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("failed to get project: %v", err)), nil
	}
	return jsonResult(project)
}

func (s *MCPServer) handleListIssues(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	projectCode, err := req.RequireString("projectCode")
	if err != nil {
		return mcp.NewToolResultError("projectCode is required"), nil
	}

	project, err := s.projects.GetByCode(ctx, projectCode)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("project not found: %v", err)), nil
	}

	filters := map[string]string{}
	if v := req.GetString("priority", ""); v != "" {
		filters["priority"] = v
	}
	if v := req.GetString("status", ""); v != "" {
		filters["status"] = v
	}
	if v := req.GetString("type", ""); v != "" {
		filters["type"] = v
	}

	issues, err := s.issues.ListByProject(ctx, project.ID.Hex(), filters)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("failed to list issues: %v", err)), nil
	}
	return jsonResult(issues)
}

func (s *MCPServer) handleGetIssue(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	issueKey, err := req.RequireString("issueKey")
	if err != nil {
		return mcp.NewToolResultError("issueKey is required"), nil
	}

	issue, err := s.issues.GetByKey(ctx, issueKey)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("failed to get issue: %v", err)), nil
	}
	return jsonResult(issue)
}

func (s *MCPServer) handleSearchIssues(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	query, err := req.RequireString("query")
	if err != nil {
		return mcp.NewToolResultError("query is required"), nil
	}

	var projectID string
	if code := req.GetString("projectCode", ""); code != "" {
		project, err := s.projects.GetByCode(ctx, code)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("project not found: %v", err)), nil
		}
		projectID = project.ID.Hex()
	}

	issues, err := s.issues.Search(ctx, query, projectID)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("search failed: %v", err)), nil
	}
	return jsonResult(issues)
}

func (s *MCPServer) handleCreateIssue(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	projectCode, err := req.RequireString("projectCode")
	if err != nil {
		return mcp.NewToolResultError("projectCode is required"), nil
	}

	project, err := s.projects.GetByCode(ctx, projectCode)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("project not found: %v", err)), nil
	}

	title, err := req.RequireString("title")
	if err != nil {
		return mcp.NewToolResultError("title is required"), nil
	}
	description, err := req.RequireString("description")
	if err != nil {
		return mcp.NewToolResultError("description is required"), nil
	}
	issueType, err := req.RequireString("type")
	if err != nil {
		return mcp.NewToolResultError("type is required"), nil
	}
	priority, err := req.RequireString("priority")
	if err != nil {
		return mcp.NewToolResultError("priority is required"), nil
	}

	createReq := &models.CreateIssueRequest{
		Title:       title,
		Description: description,
		Type:        models.IssueType(issueType),
		Priority:    models.Priority(priority),
		ReproSteps:  req.GetString("reproSteps", ""),
		Source:      req.GetString("source", ""),
		CreatedBy:   req.GetString("createdBy", ""),
		DueDate:     req.GetString("dueDate", ""),
	}

	issue, err := s.issues.Create(ctx, project.ID.Hex(), createReq)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("failed to create issue: %v", err)), nil
	}
	return jsonResult(issue)
}

func (s *MCPServer) handleUpdateIssueStatus(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	issueKey, err := req.RequireString("issueKey")
	if err != nil {
		return mcp.NewToolResultError("issueKey is required"), nil
	}
	newStatus, err := req.RequireString("newStatus")
	if err != nil {
		return mcp.NewToolResultError("newStatus is required"), nil
	}

	issue, err := s.issues.TransitionStatus(ctx, issueKey, newStatus)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("failed to transition status: %v", err)), nil
	}
	return jsonResult(issue)
}

func (s *MCPServer) handleUpdateIssue(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	issueKey, err := req.RequireString("issueKey")
	if err != nil {
		return mcp.NewToolResultError("issueKey is required"), nil
	}

	updateReq := &models.UpdateIssueRequest{}
	hasUpdate := false

	if v := req.GetString("title", ""); v != "" {
		updateReq.Title = &v
		hasUpdate = true
	}
	if v := req.GetString("description", ""); v != "" {
		updateReq.Description = &v
		hasUpdate = true
	}
	if v := req.GetString("priority", ""); v != "" {
		p := models.Priority(v)
		updateReq.Priority = &p
		hasUpdate = true
	}
	if v := req.GetString("source", ""); v != "" {
		updateReq.Source = &v
		hasUpdate = true
	}
	if args := req.GetArguments(); args != nil {
		if _, ok := args["dueDate"]; ok {
			v := req.GetString("dueDate", "")
			updateReq.DueDate = &v
			hasUpdate = true
		}
	}
	if v := req.GetString("reproSteps", ""); v != "" {
		updateReq.ReproSteps = &v
		hasUpdate = true
	}

	if !hasUpdate {
		return mcp.NewToolResultError("no fields to update"), nil
	}

	issue, err := s.issues.Update(ctx, issueKey, updateReq)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("failed to update issue: %v", err)), nil
	}
	return jsonResult(issue)
}

func (s *MCPServer) handleGetProjectDashboard(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	projectCode, err := req.RequireString("projectCode")
	if err != nil {
		return mcp.NewToolResultError("projectCode is required"), nil
	}

	project, err := s.projects.GetByCode(ctx, projectCode)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("project not found: %v", err)), nil
	}

	issuesByStatus, err := s.issues.CountByProject(ctx, project.ID)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("failed to count issues by status: %v", err)), nil
	}

	issuesByPriority, err := s.issues.CountByPriority(ctx, project.ID)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("failed to count issues by priority: %v", err)), nil
	}

	// Compute issues by type from the full issue list.
	issues, err := s.issues.ListByProject(ctx, project.ID.Hex(), nil)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("failed to list issues: %v", err)), nil
	}
	issuesByType := make(map[string]int)
	openCount := 0
	for _, issue := range issues {
		issuesByType[string(issue.Type)]++
		if issue.Status == "open" {
			openCount++
		}
	}

	summary := models.ProjectSummary{
		Project:          *project,
		OpenIssueCount:   openCount,
		IssuesByPriority: issuesByPriority,
		IssuesByStatus:   issuesByStatus,
		IssuesByType:     issuesByType,
	}

	return jsonResult(summary)
}

func (s *MCPServer) handleGetOpenP0Issues(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	projectCode := req.GetString("projectCode", "")

	if projectCode != "" {
		project, err := s.projects.GetByCode(ctx, projectCode)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("project not found: %v", err)), nil
		}

		filters := map[string]string{
			"priority": "P0",
			"status":   "open",
		}
		issues, err := s.issues.ListByProject(ctx, project.ID.Hex(), filters)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("failed to list issues: %v", err)), nil
		}
		return jsonResult(issues)
	}

	// No project specified — collect P0 open issues across all projects.
	projects, err := s.projects.List(ctx)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("failed to list projects: %v", err)), nil
	}

	var allP0Issues []models.Issue
	for _, project := range projects {
		filters := map[string]string{
			"priority": "P0",
			"status":   "open",
		}
		issues, err := s.issues.ListByProject(ctx, project.ID.Hex(), filters)
		if err != nil {
			continue
		}
		allP0Issues = append(allP0Issues, issues...)
	}
	if allP0Issues == nil {
		allP0Issues = []models.Issue{}
	}

	return jsonResult(allP0Issues)
}

func (s *MCPServer) handleGetVibectlMd(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	code, err := req.RequireString("projectCode")
	if err != nil {
		return mcp.NewToolResultError("projectCode is required"), nil
	}
	project, err := s.projects.GetByCode(ctx, code)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("project not found: %v", err)), nil
	}
	content, err := s.vibectlMd.Generate(ctx, project.ID.Hex())
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("failed to generate: %v", err)), nil
	}
	return mcp.NewToolResultText(content), nil
}

func (s *MCPServer) handleRegenerateVibectlMd(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	code, err := req.RequireString("projectCode")
	if err != nil {
		return mcp.NewToolResultError("projectCode is required"), nil
	}
	project, err := s.projects.GetByCode(ctx, code)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("project not found: %v", err)), nil
	}
	if err := s.vibectlMd.WriteToProject(ctx, project.ID.Hex()); err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("failed to write: %v", err)), nil
	}
	return mcp.NewToolResultText("VIBECTL.md regenerated successfully"), nil
}

func (s *MCPServer) handleGetDecisions(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	code, err := req.RequireString("projectCode")
	if err != nil {
		return mcp.NewToolResultError("projectCode is required"), nil
	}
	project, err := s.projects.GetByCode(ctx, code)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("project not found: %v", err)), nil
	}
	limit := 20
	if v := req.GetString("limit", ""); v != "" {
		if n, err := fmt.Sscanf(v, "%d", &limit); err != nil || n == 0 {
			limit = 20
		}
	}
	decisions, err := s.decisions.ListRecent(ctx, project.ID.Hex(), limit)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("failed to list decisions: %v", err)), nil
	}
	return jsonResult(decisions)
}

func (s *MCPServer) handleRecordDecision(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	code, err := req.RequireString("projectCode")
	if err != nil {
		return mcp.NewToolResultError("projectCode is required"), nil
	}
	summary, err := req.RequireString("summary")
	if err != nil {
		return mcp.NewToolResultError("summary is required"), nil
	}
	project, err := s.projects.GetByCode(ctx, code)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("project not found: %v", err)), nil
	}
	issueKey := req.GetString("issueKey", "")
	if err := s.decisions.Record(ctx, project.ID, "manual", summary, issueKey); err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("failed to record: %v", err)), nil
	}
	return mcp.NewToolResultText("Decision recorded"), nil
}

func (s *MCPServer) handleGetDeploymentInfo(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	code, err := req.RequireString("projectCode")
	if err != nil {
		return mcp.NewToolResultError("projectCode is required"), nil
	}
	project, err := s.projects.GetByCode(ctx, code)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("project not found: %v", err)), nil
	}
	info := map[string]interface{}{
		"deployment":  project.Deployment,
		"healthCheck": project.HealthCheck,
	}
	return jsonResult(info)
}

// jsonResult marshals any value to pretty JSON and returns it as tool result text.
func jsonResult(v any) (*mcp.CallToolResult, error) {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("failed to marshal result: %v", err)), nil
	}
	return mcp.NewToolResultText(string(data)), nil
}

// Additional tools registered after the core 15.

func (s *MCPServer) registerAdditionalTools() {
	// 16. list_sessions
	s.server.AddTool(
		mcp.NewTool("list_sessions",
			mcp.WithDescription("List recent work sessions for a project. Each session records what was worked on, when it started/ended, and a summary."),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithString("projectCode", mcp.Required(), mcp.Description("Project code")),
			mcp.WithNumber("limit", mcp.Description("Max sessions to return (default 10)")),
		),
		s.handleListSessions,
	)

	// 17. get_latest_session
	s.server.AddTool(
		mcp.NewTool("get_latest_session",
			mcp.WithDescription("Get the most recent work session for a project."),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithString("projectCode", mcp.Required(), mcp.Description("Project code")),
		),
		s.handleGetLatestSession,
	)

	// 18. get_health_status
	s.server.AddTool(
		mcp.NewTool("get_health_status",
			mcp.WithDescription("Get the uptime history for a project's health check endpoints (last 24 hours)."),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithString("projectCode", mcp.Required(), mcp.Description("Project code")),
		),
		s.handleGetHealthStatus,
	)

	// 19. list_prompts
	s.server.AddTool(
		mcp.NewTool("list_prompts",
			mcp.WithDescription("List saved prompts for a project (includes global prompts shared across all projects)."),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithString("projectCode", mcp.Description("Project code (omit for global prompts only)")),
		),
		s.handleListPrompts,
	)

	// 20. get_prompt
	s.server.AddTool(
		mcp.NewTool("get_prompt",
			mcp.WithDescription("Get a specific saved prompt by its ID."),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithString("promptId", mcp.Required(), mcp.Description("Prompt ID")),
		),
		s.handleGetPrompt,
	)
}

func (s *MCPServer) handleListSessions(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	code, err := req.RequireString("projectCode")
	if err != nil {
		return mcp.NewToolResultError("projectCode is required"), nil
	}
	project, err := s.projects.GetByCode(ctx, code)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("project not found: %v", err)), nil
	}
	sessions, err := s.sessions.ListByProject(ctx, project.ID.Hex())
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("failed to list sessions: %v", err)), nil
	}
	limit := 10
	if n := int(req.GetFloat("limit", 0)); n > 0 {
		limit = n
	}
	if len(sessions) > limit {
		sessions = sessions[:limit]
	}
	return jsonResult(sessions)
}

func (s *MCPServer) handleGetLatestSession(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	code, err := req.RequireString("projectCode")
	if err != nil {
		return mcp.NewToolResultError("projectCode is required"), nil
	}
	project, err := s.projects.GetByCode(ctx, code)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("project not found: %v", err)), nil
	}
	session, err := s.sessions.GetLatest(ctx, project.ID.Hex())
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("failed to get latest session: %v", err)), nil
	}
	if session == nil {
		return mcp.NewToolResultText("No sessions recorded for this project."), nil
	}
	return jsonResult(session)
}

func (s *MCPServer) handleGetHealthStatus(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	code, err := req.RequireString("projectCode")
	if err != nil {
		return mcp.NewToolResultError("projectCode is required"), nil
	}
	project, err := s.projects.GetByCode(ctx, code)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("project not found: %v", err)), nil
	}
	records, err := s.healthRecords.GetHistory(ctx, project.ID.Hex(), 24*time.Hour)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("failed to get health history: %v", err)), nil
	}
	return jsonResult(records)
}

func (s *MCPServer) handleListPrompts(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	code := req.GetString("projectCode", "")
	if code != "" {
		project, err := s.projects.GetByCode(ctx, code)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("project not found: %v", err)), nil
		}
		prompts, err := s.prompts.ListByProject(ctx, project.ID.Hex())
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("failed to list prompts: %v", err)), nil
		}
		return jsonResult(prompts)
	}
	prompts, err := s.prompts.ListAll(ctx)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("failed to list prompts: %v", err)), nil
	}
	return jsonResult(prompts)
}

func (s *MCPServer) handleGetPrompt(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	id, err := req.RequireString("promptId")
	if err != nil {
		return mcp.NewToolResultError("promptId is required"), nil
	}
	prompt, err := s.prompts.GetByID(ctx, id)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("failed to get prompt: %v", err)), nil
	}
	return jsonResult(prompt)
}
