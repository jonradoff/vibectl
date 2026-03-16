# VibeCtl MCP Documentation

**Version**: 0.8.0
**Transport**: stdio (local only)
**Server name**: vibectl
**Privacy Policy**: https://www.metavert.io/privacy-policy

VibeCtl provides a Model Context Protocol (MCP) server for AI coding agents (Claude Code, etc.) to manage projects, issues, sessions, health, and decisions directly from their context window.

## Setup

Add to `~/.claude.json` (Claude Code, user scope) or `.mcp.json` (project scope):

```json
{
  "mcpServers": {
    "vibectl": {
      "command": "/path/to/vibectl-mcp",
      "args": [
        "--mongodb-uri", "mongodb://localhost:27017",
        "--database", "vibectl"
      ]
    }
  }
}
```

For MongoDB Atlas:
```json
{
  "mcpServers": {
    "vibectl": {
      "command": "/path/to/vibectl-mcp",
      "args": [
        "--mongodb-uri", "mongodb+srv://user:pass@cluster.mongodb.net",
        "--database", "vibectl"
      ]
    }
  }
}
```

Build the MCP binary: `make build-mcp` or `go build -o vibectl-mcp ./cmd/mcp/`

## Tools Reference

### Projects

#### `list_projects`
List all active projects.
**Returns**: Array of projects with code, name, description, goals, issue counter, deployment config.

#### `get_project`
Get a project by its code.
**Parameters**:
- `code` (required, string): 3–5 uppercase letters (e.g. `LCMS`)

#### `get_project_dashboard`
Get issue counts by priority, status, and type.
**Parameters**:
- `projectCode` (required, string)

### Issues

#### `list_issues`
List issues for a project with optional filters.
**Parameters**:
- `projectCode` (required, string)
- `priority` (string): P0–P5
- `status` (string): open, fixed, closed, cannot_reproduce, approved, backlogged, implemented
- `type` (string): bug, feature, idea

#### `get_issue`
Get a single issue.
**Parameters**:
- `issueKey` (required, string): e.g. `PROJ-0042`

#### `search_issues`
Full-text search.
**Parameters**:
- `query` (required, string)
- `projectCode` (string): optional, scopes to one project

#### `create_issue`
Create a new issue.
**Parameters**:
- `projectCode` (required, string)
- `title` (required, string)
- `description` (required, string)
- `type` (required, string): bug / feature / idea
- `priority` (required, string): P0–P5
- `reproSteps` (string): required for bugs
- `source` (string): e.g. user_report, code_review
- `createdBy` (string)
- `dueDate` (string): RFC3339 or YYYY-MM-DD

#### `update_issue`
Update mutable issue fields.
**Parameters**:
- `issueKey` (required, string)
- Any of: `title`, `description`, `priority`, `source`, `dueDate`, `reproSteps`

#### `update_issue_status`
Transition issue status. Validated by type.
**Parameters**:
- `issueKey` (required, string)
- `newStatus` (required, string)

**Allowed transitions**:
- Bug: open → fixed / cannot_reproduce → closed
- Feature: open → approved / backlogged → implemented → closed
- Idea: open → closed / backlogged

#### `get_open_p0_issues`
Get all open P0 critical issues.
**Parameters**:
- `projectCode` (string): optional, omit for all projects

### Project Context

#### `get_vibectl_md`
Get the VIBECTL.md for a project — full status, goals, deployment, decisions.
**Parameters**:
- `projectCode` (required, string)

#### `regenerate_vibectl_md`
Regenerate and write VIBECTL.md to the project's local path.
**Parameters**:
- `projectCode` (required, string)

#### `get_decisions`
Get recent decisions (audit log).
**Parameters**:
- `projectCode` (required, string)
- `limit` (number): default 20

#### `record_decision`
Record a significant decision.
**Parameters**:
- `projectCode` (required, string)
- `summary` (required, string)
- `issueKey` (string): related issue

#### `get_deployment_info`
Get deployment config and health check settings.
**Parameters**:
- `projectCode` (required, string)

### Health

#### `get_health_status`
Get 24-hour uptime history for a project's endpoints.
**Parameters**:
- `projectCode` (required, string)

### Sessions

#### `list_sessions`
List recent work sessions.
**Parameters**:
- `projectCode` (required, string)
- `limit` (number): default 10

#### `get_latest_session`
Get the most recent session.
**Parameters**:
- `projectCode` (required, string)

### Prompts

#### `list_prompts`
List saved prompts (project + global).
**Parameters**:
- `projectCode` (string): optional

#### `get_prompt`
Get a saved prompt by ID.
**Parameters**:
- `promptId` (required, string)

## Privacy & Data

The VibeCtl MCP server connects directly to your local MongoDB instance. No data is transmitted to external services. The MCP server itself does not make network requests.

Privacy Policy: https://www.metavert.io/privacy-policy

## Notes

- The MCP server bypasses HTTP authentication — it connects directly to MongoDB
- Do NOT expose the admin password change via MCP (use `vibectl admin set-password` instead)
- Issue keys follow `CODE-NNNN` format (e.g. `LCMS-0042`)
- For `create_issue` with `type: "bug"`, `reproSteps` is required by convention
