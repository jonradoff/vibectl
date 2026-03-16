# Changelog

All notable changes to VibeCtl are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
