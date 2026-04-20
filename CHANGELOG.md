# Changelog

All notable changes to VibeCtl are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## v0.12.1 (2026-04-20) — Delegation & Feedback

### Added
- **Delegation model**: Standalone instances can proxy shared data (issues, feedback, intents) to a remote production server while keeping local data (sessions, terminals, chat history) local. Configurable via Settings with test connection, health monitoring, and event relay.
- **View toggle**: "Remote / Local" segmented control in dashboard header when delegation is active. Local view sends `X-Vibectl-View: local` header to bypass the proxy.
- **Export to Remote**: One-click button in project Settings to create a project on the remote server when delegation is enabled.
- **GitHub sweeper remote push**: When delegation is active, feedback collected from GitHub comments is automatically pushed to the remote server. Deduplication via sourceURL prevents duplicates.
- **Feedback detail modal**: Clicking any feedback item opens a full-detail modal with content, metadata, AI analysis, and accept/dismiss actions. Continuous review mode advances to the next pending item.
- **Feedback API**: External products submit end-user feedback via REST with API key auth, XSS protection, LLM injection isolation, metadata support, deduplication, and webhooks.
- **Project code migration**: All project foreign keys migrated from MongoDB ObjectIDs to portable project code strings, enabling cross-instance project sharing.
- **Feedback project attribution**: Feedback list and detail modal now display the project name/code.

### Fixed
- Session cleanup no longer kills resumable sessions on restart (only marks stale active sessions as dead).
- Local path panel shows correctly when path is missing instead of blank screen.
- ~30 `projectId`→`projectCode` migration mismatches across frontend components that broke the production build.
- Feedback sourceURL deduplication in the Create handler (returns 409 on duplicate).

---

## v0.12.0 (2026-04-13) — Intent-Oriented Productivity

### Added
- **Intent extraction**: Chat sessions are automatically analyzed via Haiku when archived, extracting developer intents with title, category (UI/API/infra/data/test/docs/bugfix/refactor), size (S/M/L/XL with point values), delivery status, tech tags, and UX judgment level.
- **Productivity tab (Intent view)**: Summary cards (points delivered, intents completed, avg cycle time, total tokens), sortable intent table with expand-to-detail, category badges, status icons, and a "Raw Deltas" sub-view for the old code delta metrics.
- **Backfill endpoint**: `POST /api/v1/intents/backfill` analyzes historical chat sessions that haven't been processed yet.
- **Insights API**: `GET /api/v1/intents/insights` returns tokens-per-point by category/tech-tag/UX-level and daily points trend.
- **Project tags**: Arbitrary labels on projects via Settings tab with autocomplete from existing tags. Tags shown as clickable filter pills in Projects column and Productivity tab.
- **File-level code deltas**: `CodeDelta` records now include per-file `FileChange` entries (path, lines added/removed) from git numstat, enabling tech stack inference.
- **Plan mode support**: Claude Code plan mode renders inline as markdown, `EnterPlanMode`/`ExitPlanMode` auto-approved via `--allowedTools`.
- **Subscription usage**: Real-time Claude subscription usage from OAuth API (session 5h, weekly 7d, per-model), displayed in Usage tab and via `/usage` slash command.
- **Slash commands**: `/mcp` (list MCP servers), `/reload` (restart + reload MCPs), `/fresh` (new session), `/usage` (subscription usage). Compacting/reload shows spinner with queued message count.
- **Auth error handling**: 401 errors now show login UI instead of auto-restart loop. Credentials read from `~/.claude/.credentials.json`, not macOS keychain.
- **Plans page**: View captured plans with filtering, status tracking, expand/collapse.

---

## [0.11.0] - 2026-04-09

### Added
- **Claude Usage Monitor** — new dashboard card tracks Claude Code token consumption per login identity. Intercepts usage data from stream-json events in real-time and persists to MongoDB (90-day TTL).
- **Usage detail modal** — click any login row to see weekly progress bar, token breakdown (input/output/cache), daily usage bars, per-model and per-project splits.
- **Configurable limits** — set a weekly token cap and alert threshold per login via the modal's Configure panel. Percentage and color-coded warnings (green < 70%, amber 70-90%, red > 90%).
- **`GET /api/v1/claude-usage/summary`** — returns current-week usage summaries for all Claude logins.
- **`PUT /api/v1/claude-usage/config`** — upsert weekly limit, label, and alert threshold per login identity.
- New MongoDB collections: `claude_usage_records` (indexed by tokenHash + recordedAt, 90-day TTL), `claude_usage_configs` (unique on tokenHash).

---

## [0.10.0] - 2026-03-23

### Added
- **Feedback review tab** — new Feedback tab on every project card with three-column review panel (Pending | Accepted | Dismissed). Each item shows source, submitter, AI triage proposal, and linked issue key.
- **Pending feedback badge** — amber badge in the project card header shows count of unreviewed items; clicking it jumps to the Feedback tab.
- **Quick feedback capture** — "+ Add Feedback" button directly in the card tab; modal for ad-hoc feedback entry with source type selector.
- **AI triage per item** — "AI Triage" button on each pending item invokes Claude analysis and surfaces proposed issue title, type, and priority inline.
- **Bulk triage** — "AI Triage All" button processes all pending items in a single batch call.
- **Bulk accept/dismiss** — checkbox selection with "Accept All" / "Dismiss All" bulk actions.
- **Accept → Create Issue** — "✓ + Issue" button accepts feedback and atomically creates an issue using the AI proposal (or raw content as fallback); linked issue key shown on the accepted item.
- **`POST /api/v1/feedback/bulk-review`** — bulk accept/dismiss endpoint.
- **`POST /api/v1/feedback/triage-batch`** — batch AI triage for all pending items.
- **MCP feedback tools** — four new MCP tools: `list_feedback`, `add_feedback`, `triage_feedback`, `accept_feedback`. Agents can now capture, triage, and resolve feedback without leaving Claude Code.
- **Pending Feedback section in VIBECTL.md** — top 3 pending items (with status and date) included in auto-generated VIBECTL.md; regenerated whenever feedback is reviewed.
- **Project script conventions** — documented `deploy.sh` → deployProd and `start.sh` → startDev as standard VibeCtl project file conventions in CLAUDE.md.
- **Project script auto-detection** — during project creation ("Use local path" mode), VibeCtl detects `deploy.sh`, `start.sh`, and `fly.toml` and pre-fills Deployment Settings. Combined endpoint: `GET /detect-project-scripts`.
- **Feedback activity log entries** — `feedback_submitted`, `feedback_accepted`, `feedback_dismissed`, and `feedback_converted` events now appear in the compact activity log with colour coding.

### Changed
- **Triage status** — added `triaged` state (AI analyzed, awaiting human review) distinct from `accepted`/`dismissed`. `reviewed` kept as backward-compat alias.
- **MCP tool count** — expanded from 20 to 24 tools.
- **`FeedbackItem`** — new fields: `triagedAt`, `linkedIssueKey`.
- **`ProjectSummary`** — new field: `pendingFeedbackCount` (populated in `/dashboard` endpoint).
- **`Issue`** — new field: `sourceFeedbackID` (set when an issue is created from feedback).

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
