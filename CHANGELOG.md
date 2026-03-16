# Changelog

All notable changes to VibeCtl are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.9.0] - 2026-03-16

### Security
- **Token hashing** — session tokens are now stored as SHA-256 hashes in MongoDB; a database dump no longer yields a usable bearer token.
- **Global API authentication** — `AdminAuth` middleware applied to the entire `/api/v1` route group. `auth-status`, `login`, and `set-password` remain public. First-run open access preserved when no password is set.
- **`EnsureDir` / `CheckDir` protected** — these filesystem endpoints now require auth (previously unauthenticated and accepted arbitrary absolute paths).
- **Path traversal fix** — `resolveAndValidate` now uses `root + filepath.Separator` prefix check to prevent `/proj2` matching `/proj`.
- **Upload MIME detection** — file type detected from actual bytes via `http.DetectContentType`, not the client-supplied header. Extension allowlist enforced (`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`). Uploaded files served with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.
- **Login rate limiting** — `POST /admin/login` allows max 10 attempts per IP per 5-minute window; returns 429 when exceeded.
- **Webhook SSRF protection** — webhook URLs validated on save; private/loopback ranges (RFC1918, 127.x, ::1, 169.254.x, fc00::/7) rejected.
- **Webhook secret redaction** — `Project.MaskSecrets()` strips secret values from all API responses; `hasSecret: true` flag indicates a secret is configured without exposing the value.
- **XSS fix in ChatView** — HTML entities escaped in the `hljs` fallback path that used `dangerouslySetInnerHTML`; raw user content can no longer inject script tags via unsupported code block languages.
- **Prompt injection mitigation** — external feedback content wrapped in `<user-content>` tags in the triage agent prompt, instructing Claude to treat it as data not instructions.

### Added
- **Issue comments** — `GET/POST /api/v1/issues/{issueKey}/comments` and `DELETE /api/v1/issues/{issueKey}/comments/{commentId}`. MongoDB-backed `CommentService`. Comment thread UI at the bottom of the issue detail page.
- **Bulk issue operations** — checkbox selection on the issue table; bulk toolbar for changing priority (P0–P5) or archiving multiple issues at once.
- **Settings page** — global settings at `/settings` (gear icon in sidebar). VIBECTL.md auto-regen schedule (off / hourly / daily / weekly). `GET/PUT /api/v1/settings`.
- **VIBECTL.md background auto-regen** — server goroutine checks the configured schedule every 5 minutes and regenerates VIBECTL.md for all non-archived projects.
- **Webhooks** — per-project webhook configuration (URL, events, optional HMAC-SHA256 secret). Events: `p0_issue_created`, `health_check_down`, `health_check_up`, `feedback_triaged`. Async delivery with 10-second timeout. `X-Vibectl-Signature: sha256=...` header when a secret is set.
- **Health check alerting** — background recorder compares new results against the previous record and fires `health_check_down` / `health_check_up` webhooks on status transitions.
- **Admin auth gate** — frontend shows a setup screen (CLI instructions) on first run; shows login form when a password exists.
- **Sign-out button** — sidebar footer, visible when a password is configured.
- **30-day token expiry** — tokens rejected after 30 days; `TokenCreatedAt` stored in admin doc.
- **401 auto-redirect** — client dispatches `vibectl:unauthorized` on 401; `AuthContext` resets to login screen.
- **Global search** — debounced header search calls `/api/v1/issues/search`; dropdown with priority color-coding and click-to-navigate.
- **Webhooks UI** — per-project webhook management panel (list, add, remove; URL, events checkboxes, optional secret).
- **API docs updated** — webhooks, issue comments, and settings sections added to `docs/api.md` and `APIDocsPage.tsx`.

### Changed
- **Version** bumped to `0.9.0`.
- **CORS default** tightened from `*` to `http://localhost:4370`.
- **Projects list sorted alphabetically** in the sidebar.
- **Sidebar footer** — © 2026 Metavert LLC (metavert.io) · MIT License.
- **README roadmap** updated to reflect v0.9 feature set.

---

## [0.8.0] - 2026-03-16

### Added
- **Admin authentication** — bcrypt-hashed admin password stored in MongoDB (never in a file). Session tokens generated on login and rotated on each authentication.
- **CLI admin commands** — `vibectl admin login`, `vibectl admin set-password`, `vibectl admin logout`. Token stored at `~/.vibectl/token`.
- **CLI health command** — `vibectl health CODE` and `vibectl health history CODE` for terminal-native health monitoring.
- **CLI sessions command** — `vibectl sessions CODE` lists recent work sessions.
- **CLI prompts command** — `vibectl prompts list` and `vibectl prompts get` for prompt management from the terminal.
- **CLI auth token propagation** — all CLI requests now include `Authorization: Bearer` header from saved token or `VIBECTL_TOKEN` env var.
- **MCP tool: `list_sessions`** — list recent work sessions for a project.
- **MCP tool: `get_latest_session`** — get the most recent session for a project.
- **MCP tool: `get_health_status`** — get 24-hour uptime history for a project's health endpoints.
- **MCP tool: `list_prompts`** — list saved prompts (project + global).
- **MCP tool: `get_prompt`** — retrieve a saved prompt by ID.
- **Frontend health: frontend-only probe** — frontend endpoints now check for 200 response only; no longer marked "degraded" for missing `/healthz`.
- **Help section in sidebar** — links to MCP docs, API docs, CLI docs, and skill.md.
- **Documentation** — `docs/mcp.md`, `docs/api.md`, `docs/cli.md`, rendered HTML pages at `/docs/mcp`, `/docs/api`, `/docs/cli`.
- **MIT License** — `LICENSE` file, © 2026 Metavert LLC.
- **`skill.md`** — MCP skill descriptor for registering vibectl with Claude Code.

### Changed
- **Version** bumped to `0.8.0`.
- **Admin rebuild endpoint** is now auth-protected when an admin password is set.
- **`NewAdminHandler`** signature updated to accept `*services.AdminService`.
- **`NewMCPServer`** signature updated to accept `SessionService`, `HealthRecordService`, `PromptService`.

---

## [0.7.x] — Earlier development

### Added
- Health check timeline UI (side-by-side frontend/backend uptime bars)
- KPI deduplication across endpoints in health check display
- Software name + version display from `/healthz` responses
- `degraded` status for backend endpoints with no `/healthz`
- Rebuild overlay with uptime-based restart detection (handles `syscall.Exec` fast restarts)
- `Front`/`Back` label shortening in health cards

---

## [0.6.x] — Earlier development

### Added
- Background health check recorder (10-minute interval, 7-day TTL)
- VibeCtl Health Check Protocol (`pkg/healthz`) — reusable `/healthz` handler for Go services
- `softwareName` and `version` fields in health check results
- GitHub comment sweeper (15-minute interval)
- Architecture agent and PM review agent

---

## [0.5.x] — Earlier development

### Added
- Activity log service and UI
- Chat session persistence across server restarts
- Claude Code stream-json WebSocket (`/ws/chat`)
- PTY terminal over WebSocket (`/ws/terminal`)
- Project filesystem read/write endpoints

---

## [0.4.x] — Earlier development

### Added
- Feedback queue with AI triage (Claude)
- Recurring theme detection
- Batch feedback ingestion
- Decision audit log

---

## [0.3.x] — Earlier development

### Added
- VIBECTL.md generation service
- Issue status workflow validation by type
- Full-text issue search
- Prompts service (project + global)
- Session tracking

---

## [0.2.x] — Earlier development

### Added
- MCP server (stdio transport) with 15 tools
- CLI (`vibectl`) with projects, issues, feedback, dashboard, decisions commands
- Health check UI (frontend tab, project card widget)

---

## [0.1.0] — Initial release

### Added
- Projects, issues, feedback core data model
- React + TypeScript frontend with Tailwind
- Go + chi backend with MongoDB
- Basic CRUD for projects and issues
