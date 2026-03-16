# vibectl MCP Skill

VibeCtl is a command-and-control system for agentic software development. Use its MCP tools to manage projects, issues, feedback, sessions, deployments, and health status across your AI-assisted engineering workflow.

## When to use this skill

- To look up, create, or update issues before or after a coding session
- To log decisions and architectural choices made during development
- To check what's deployed, what's healthy, and what's broken
- To understand the current project status before starting work
- To submit or review product feedback
- To retrieve saved prompts for a project
- To record what you worked on after a session ends

## Available tools

### Projects

**`list_projects`** — List all projects with their codes, goals, and metadata.
No parameters required.

**`get_project`** — Get a single project by its code.
- `code` (required): 3–5 uppercase letters (e.g. `LCMS`, `MYAPP`)

**`get_project_dashboard`** — Get issue counts by priority, status, and type for a project.
- `projectCode` (required)

### Issues

**`list_issues`** — List issues for a project with optional filters.
- `projectCode` (required)
- `priority`: P0–P5
- `status`: open, fixed, closed, etc.
- `type`: bug, feature, idea

**`get_issue`** — Get a single issue by its key (e.g. `PROJ-0042`).
- `issueKey` (required)

**`search_issues`** — Full-text search across issue titles and descriptions.
- `query` (required)
- `projectCode`: optional, scopes to one project

**`create_issue`** — Create a new issue.
- `projectCode`, `title`, `description`, `type`, `priority` (all required)
- `reproSteps`: required for bugs
- `source`, `createdBy`, `dueDate`: optional

**`update_issue`** — Update mutable fields of an issue.
- `issueKey` (required)
- Any of: `title`, `description`, `priority`, `source`, `dueDate`, `reproSteps`

**`update_issue_status`** — Transition an issue to a new status.
- `issueKey`, `newStatus` (both required)
- Status transitions are validated by issue type:
  - Bug: open → fixed / cannot_reproduce → closed
  - Feature: open → approved / backlogged → implemented → closed
  - Idea: open → closed / backlogged

**`get_open_p0_issues`** — Get all open P0 (critical) issues.
- `projectCode`: optional, omit for all projects

### Project context

**`get_vibectl_md`** — Get the VIBECTL.md content for a project — current status, open issues, goals, deployment, decisions.
- `projectCode` (required)

**`regenerate_vibectl_md`** — Regenerate and write the VIBECTL.md to the project's local path.
- `projectCode` (required)

**`get_decisions`** — Get recent decisions for a project (audit log of actions taken).
- `projectCode` (required)
- `limit`: default 20

**`record_decision`** — Record a significant decision made during development.
- `projectCode`, `summary` (both required)
- `issueKey`: optional, links to a related issue

**`get_deployment_info`** — Get deployment config and health check settings for a project.
- `projectCode` (required)

### Health

**`get_health_status`** — Get uptime history (last 24 hours) for a project's health check endpoints.
- `projectCode` (required)

### Sessions

**`list_sessions`** — List recent work sessions for a project.
- `projectCode` (required)
- `limit`: default 10

**`get_latest_session`** — Get the most recent work session for a project.
- `projectCode` (required)

### Prompts

**`list_prompts`** — List saved prompts for a project (includes global prompts).
- `projectCode`: optional

**`get_prompt`** — Get a specific saved prompt by ID.
- `promptId` (required)

## Workflow patterns

### Before starting work on a project

```
1. get_vibectl_md(projectCode) — read full status
2. list_issues(projectCode, status="open", priority="P0") — know the critical issues
3. get_latest_session(projectCode) — understand what was last worked on
```

### After completing a task

```
1. update_issue_status(issueKey, newStatus) — close or advance the issue
2. record_decision(projectCode, summary) — log architectural decisions made
3. regenerate_vibectl_md(projectCode) — update the status file
```

### Tracking a new bug or feature request

```
1. search_issues(query) — check if it's already tracked
2. create_issue(projectCode, title, type, priority) — if not, create it
3. record_decision(projectCode, "Filed issue X-000N: ...") — optional audit trail
```

### Checking system health

```
1. get_deployment_info(projectCode) — see what's configured
2. get_health_status(projectCode) — see 24h uptime history
```

## Notes

- Issue keys follow the pattern `CODE-NNNN` (e.g. `LCMS-0042`, `MYAPP-0001`)
- Priority scale: P0 = critical/blocking, P5 = nice-to-have
- The MCP server connects directly to MongoDB — no HTTP auth required
- Do NOT use this MCP to change the admin password (use `vibectl admin set-password` instead)
