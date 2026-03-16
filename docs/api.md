# VibeCtl API Documentation

**Base URL**: `http://localhost:4380`
**Version**: 0.8.0
**Auth**: `Authorization: Bearer <token>` (required for admin endpoints when password is set)

All responses are JSON. Error responses have `{ "error": "message", "code": "ERROR_CODE" }`.

---

## Health

### `GET /healthz`
Server health check. Returns uptime, version, MongoDB status, and KPIs.

```json
{
  "status": "healthy",
  "version": "0.8.0",
  "uptime": 3600,
  "dependencies": [{ "name": "mongodb", "status": "healthy" }],
  "kpis": [
    { "name": "projects", "value": 5, "unit": "count" },
    { "name": "open_issues", "value": 12, "unit": "count" }
  ]
}
```

---

## Admin

### `POST /api/v1/admin/login`
Authenticate with admin password. Returns session token. **Public endpoint.**

**Body**: `{ "password": "string" }`
**Response**: `{ "token": "hex64string" }`

### `POST /api/v1/admin/set-password`
Set or change admin password. On first run, `currentPassword` may be empty. **Public endpoint.**

**Body**: `{ "currentPassword": "string", "newPassword": "string" }`
**Response**: `{ "status": "ok", "token": "hex64string" }`

### `POST /api/v1/admin/rebuild` 🔒
Rebuild and restart the server binary. Broadcasts WS event, runs `go build`, then `syscall.Exec`.

**Response**: `{ "status": "restarting" }`

### `GET /api/v1/admin/self-info`
Returns the server's source directory.

---

## Projects

### `GET /api/v1/projects`
List all active projects.

### `POST /api/v1/projects`
Create a project.

**Body**:
```json
{
  "name": "My App",
  "code": "MYAPP",
  "description": "string",
  "links": { "localPath": "/path", "githubUrl": "https://..." },
  "goals": ["Goal 1", "Goal 2"]
}
```

### `GET /api/v1/projects/archived`
List archived projects.

### `GET /api/v1/projects/code/{code}`
Get project by code (e.g. `MYAPP`).

### `GET /api/v1/projects/{id}`
Get project by ObjectID.

### `PUT /api/v1/projects/{id}`
Update project. All fields optional.

**Body**: `{ "name": "...", "description": "...", "links": {...}, "goals": [...], "healthCheck": {...}, "deployment": {...} }`

### `DELETE /api/v1/projects/{id}`
Delete project.

### `POST /api/v1/projects/{id}/archive`
Archive project.

### `POST /api/v1/projects/{id}/unarchive`
Unarchive project.

### `GET /api/v1/projects/{id}/dashboard`
Get project summary: open issue count, issues by priority/status/type.

### `GET /api/v1/projects/{id}/healthcheck`
Run health check for the project's configured endpoints (based on monitorEnv).

### `GET /api/v1/projects/{id}/healthcheck/history`
Get health records for the last 24 hours.

### `POST /api/v1/projects/{id}/vibectl-md/generate`
Regenerate VIBECTL.md and write to the project's localPath.

### `GET /api/v1/projects/{id}/vibectl-md`
Get current VIBECTL.md content.

### `GET /api/v1/projects/{id}/decisions`
Get recent decisions. Query param: `?limit=N` (default 20).

---

## Issues

### `GET /api/v1/projects/{id}/issues`
List issues. Query params: `?priority=P0&status=open&type=bug`

### `POST /api/v1/projects/{id}/issues`
Create issue.

**Body**:
```json
{
  "title": "string",
  "type": "bug|feature|idea",
  "priority": "P0|P1|P2|P3|P4|P5",
  "description": "string",
  "reproSteps": "string",
  "source": "string",
  "createdBy": "string",
  "dueDate": "2026-03-16"
}
```

### `GET /api/v1/issues/{issueKey}`
Get issue by key (e.g. `MYAPP-0042`).

### `PUT /api/v1/issues/{issueKey}`
Update issue fields.

### `PATCH /api/v1/issues/{issueKey}/status`
Transition status. **Body**: `{ "status": "fixed" }`

### `DELETE /api/v1/issues/{issueKey}`
Soft-delete (archive) issue.

### `POST /api/v1/issues/{issueKey}/restore`
Restore archived issue.

### `GET /api/v1/projects/{id}/issues/archived`
List archived issues.

### `GET /api/v1/issues/search`
Full-text search. Query param: `?q=search+text`

---

## Feedback

### `GET /api/v1/feedback`
List feedback. Query params: `?triageStatus=pending&projectId=ID&sourceType=manual`

### `POST /api/v1/feedback`
Submit feedback.

**Body**:
```json
{
  "projectId": "hex",
  "rawContent": "string",
  "sourceType": "manual|github_comment|api",
  "submittedBy": "string",
  "sourceUrl": "string"
}
```

### `POST /api/v1/feedback/batch`
Submit multiple feedback items.

### `GET /api/v1/projects/{id}/feedback`
List feedback for a project.

### `POST /api/v1/projects/{id}/feedback`
Submit feedback for a project.

### `POST /api/v1/feedback/{id}/triage`
Trigger AI triage for one feedback item.

### `POST /api/v1/projects/{id}/feedback/triage-all`
Triage all pending feedback for a project.

### `POST /api/v1/feedback/{id}/review`
Accept or dismiss feedback. **Body**: `{ "status": "accepted|dismissed" }`

---

## Sessions

### `GET /api/v1/projects/{id}/sessions`
List work sessions for a project.

### `POST /api/v1/projects/{id}/sessions`
Create a new session. **Body**: `{ "summary": "string", "issuesWorkedOn": ["KEY-001"] }`

### `GET /api/v1/sessions/{id}`
Get session by ID.

### `PUT /api/v1/sessions/{id}`
Update session.

---

## Prompts

### `GET /api/v1/prompts`
List all global prompts.

### `POST /api/v1/prompts`
Create a global prompt. **Body**: `{ "name": "string", "body": "string" }`

### `GET /api/v1/prompts/{id}`
Get prompt by ID.

### `PUT /api/v1/prompts/{id}`
Update prompt.

### `DELETE /api/v1/prompts/{id}`
Delete prompt.

### `GET /api/v1/projects/{id}/prompts`
List prompts for a project (includes global prompts).

### `POST /api/v1/projects/{id}/prompts`
Create a project-scoped prompt.

---

## Activity Log

### `GET /api/v1/activity-log`
Get recent activity. Query params: `?projectId=ID&limit=50&offset=0`

---

## Dashboard

### `GET /api/v1/dashboard`
Global dashboard: total projects, total open issues, pending feedback, per-project summaries.

---

## WebSockets

### `GET /ws/terminal`
PTY terminal session over WebSocket (xterm.js).

### `GET /ws/chat`
Claude Code stream-json chat session over WebSocket.

---

## Files (Project Filesystem)

### `GET /api/v1/projects/{id}/files/list`
List directory. Query param: `?path=relative/path`

### `GET /api/v1/projects/{id}/files/read`
Read file. Query param: `?path=relative/path`

### `PUT /api/v1/projects/{id}/files/write`
Write file. **Body**: `{ "path": "relative/path", "content": "string" }`

### `POST /api/v1/ensure-dir`
Create directory if not exists.

### `GET /api/v1/check-dir`
Check if directory exists.

---

## Agents

### `POST /api/v1/agents/pm-review/{projectId}`
Run PM review agent for a project.

### `POST /api/v1/agents/architecture/{projectId}`
Run architecture summarization agent.

---

## Chat History

### `GET /api/v1/projects/{id}/chat-history`
List Claude Code chat sessions for a project.

### `GET /api/v1/chat-history/{historyId}`
Get full chat history by ID.
