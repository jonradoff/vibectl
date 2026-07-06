# Changelog

All notable changes to VibeCtl are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## v0.14.9 (2026-07-06) — Script-based AWS Command Auto-Population

### Added
- **Deployment detection recognises AWS wrapper scripts.** If `scripts/deploy-aws.sh`, `scripts/restart-aws.sh`, or `scripts/logs-aws.sh` exist (also accepts `aws-deploy.sh` / `aws-restart.sh` / `aws-logs.sh` / `tail-aws.sh` variants), the corresponding `deployProd`, `restartProd`, and `viewLogs` fields on every detected AWS target are pre-populated as `./scripts/<name> <env>` — where `<env>` is stripped from the target name (`aws-prod` → `prod`). Lets repos ship thin CLI wrappers over their real CI/CD without hand-typing commands into vibectl for each env.
- Docs: added the script convention row to the multi-target detection signals table in CLAUDE.md.

## v0.14.8 (2026-07-06) — AskUserQuestion UI, Create-time Detection Chooser, Sandbox-aware ECS Pairing

### Added
- **`AskUserQuestion` inline UI.** New `AskUserQuestionCard` renders the question(s) + options (radios/checkboxes based on `multiSelect`) with an optional "Other" free-text fallback and a preview column when options carry one. Submitting sends a `tool_result_response` over the WebSocket; the backend serialises it as a user-role `tool_result` block via a new `SendToolResult` helper on `ChatSession`. Once answered, the card collapses to a compact "Answered: …" summary. Works for both single and multi-select. Wire-through: `ChatView.handleQuestionAnswer` → `MessageRenderer` → `ToolCallCard` → `AskUserQuestionCard`.
- **Create-time deployment detection + provider chooser.** When a new project's local path is entered, the ProjectForm now runs `detectDeploymentTargets` alongside `detectProjectScripts`. If multiple providers are detected (fly.toml + AWS), the "🎯 Detected N targets" banner appears with a Preferred Provider chooser (Auto / AWS / Fly.io / …). Selecting AWS auto-fills when it's the only non-legacy provider; otherwise the choice defaults to Auto and can be overridden.
- **`CreateProjectRequest` now accepts `deployments`, `deployment`, and `preferredProvider`** — the create flow can seed the full multi-target config at project birth, not just via the settings screen afterward.
- Docs: new **Multi-target deployment detection** section in CLAUDE.md documenting the signals table, resolution order, and endpoint.

### Fixed
- **Detection no longer misattributes side-concern task-defs to primary envs.** ECS task-def files whose basenames contain any of `sandbox`, `vm`, `microvm`, `lambda`, `sidecar`, or `worker` are now flagged as *secondary* and deprioritised when pairing with `config/<env>.yaml`. Fixes the WING case where all three AWS envs were being paired with `build/ecs/wingman-sandbox.json.liquid` (the MicroVM Lambda) instead of the ECS `wingman.json.liquid`.

## v0.14.7 (2026-07-06) — Multi-target Deployments, Workspace Scoping, Subagent Model Filter

### Multi-target deployments (foundation for AWS + legacy Fly, multi-env)
- **New `Deployments []DeploymentConfig` array on Project** with per-target `name`, `isDefault`, `isLegacy`, plus provider-specific fields for AWS (`awsAccount`, `awsRegion`, `awsCluster`, `awsService`, `taskDef`, `configFile`) and Fly (existing). Legacy `project.deployment` is still read and folded in via `EffectiveDeployments()` — no migration required for existing single-target projects.
- **New `preferredProvider` on Project** — when multiple targets coexist, this picks which one the project card's header actions target. `DefaultDeployment()` honors `IsDefault` first, then `PreferredProvider`, then first-non-legacy.
- **New `GET /api/v1/detect-deployment-targets`** — scans a project dir for fly.toml, ECS task-def JSONs (`build/ecs/*.json*`, `deploy/ecs/*.json*`, `.aws/ecs/*.json*`, or root-level `task-definition*.json`), `config/*.yaml` env files, and `.github/workflows/*.yml` deploy commands. Returns a list of candidate targets — one per env — with the `.github` workflow's `aws ecs update-service` line lifted as `deployProd` when found. Fly is auto-marked `isLegacy` when AWS candidates exist alongside. Local route under delegation.
- **ProjectSettings redesigned** as a list of deployment targets with per-target commands, provider-specific fields, `default`/`legacy` toggles, and a "🔄 Re-detect targets" button that surfaces detected candidates with per-target Add.
- **Preferred Provider dropdown** in the settings panel.

### Fixes
- **Model chip no longer flips to Haiku from subagent runs.** Assistant events with `isSidechain: true` (Task-tool subagent conversations, which run Haiku by default) are now filtered out of the model tracker — the chip stays on the primary agent's model (Opus/Sonnet/Fable).
- **Workspace card no longer pulls unrelated on-disk sessions.** The v0.14.6 disk-recovery path scanned the newest `~/.claude/projects/-Users-<name>/*.jsonl` when a project's DB record was empty — for the Workspace card, whose `localPath` is $HOME, this incorrectly surfaced sessions from ad-hoc `claude` runs across every other project. Recovery is now skipped for `projectCode === "__workspace__"`.
- **`AskUserQuestion` allowlisted** on Claude Code spawn (`--allowedTools AskUserQuestion`). Previously the `acceptEdits` permission mode silently denied it, so the assistant appeared to skip past questions instead of asking them. Inline UI to render/answer is a follow-up.

## v0.14.6 (2026-07-05) — On-Disk Session History, Instant Model Chip Update

### Session history now reads from disk (matches VS Code behavior)
- **Authoritative replay from Claude Code's own JSONL.** On WebSocket attach, the backend now reads `~/.claude/projects/<encodedPath>/<sessionID>.jsonl` — the same file Claude Code uses for `--resume` — and sends the full transcript to the frontend instead of the 500-event in-memory buffer. Reload the browser and the entire conversation comes back, including everything that happened before the buffer wrap. Both the "reconnecting to existing chat session" and "resuming persisted chat session" paths use disk-first with buffer/DB fallback.
- **On-disk recovery when the DB record is dead.** If the chat_sessions record was cleared (e.g. after an unblock-and-restart) but Claude Code's history still exists on disk, vibectl picks the newest `*.jsonl` for the project and resumes that session via `--resume <its-id>` — so continued work stays in the same thread instead of starting empty. New helpers `loadOnDiskHistory` and `latestOnDiskSession` live in `internal/terminal/session_history.go`.
- **Log line for observability.** Each replay logs `source: disk | buffer | db` with `messageCount`, so you can tell at a glance where the transcript came from.

### Model chip flips immediately on picker save
- Both the `/model` picker and the `model_unavailable` picker now call `setCurrentModel(chosen)` + `onModelChange?.(chosen)` at Save & restart, so the chip reflects the new choice the instant you click — no waiting for the React Query cache to refetch or for the next `message_start` event.
- The `configuredModel` sync effect now fires whenever the prop changes to a different value, not only on the initial empty→set transition, so the chip stays in sync with per-project overrides across live edits.

## v0.14.5 (2026-07-04) — Reset in the Error Panel, Ignore `<synthetic>` Model

### Fixed
- **Reset Session button in the exit-error panel.** When `SendMessage` / `SendControlResponse` returned `SESSION_ENDED:` (Claude Code process no longer running), the error panel offered no way out — the top-bar Reset button also skipped this case because its guard checked `disconnected | error | exited`, not the `claude_error` status that `session_ended` sets. Added a dedicated Reset button inside the red panel next to the message, and extended the top-bar guard to include `claude_error`. Replaces the old "Common causes: missing `ANTHROPIC_API_KEY`..." boilerplate that didn't apply to this failure mode.
- **Ignore Claude Code's `<synthetic>` model marker in the active-model chip.** Claude Code emits `<synthetic>` as the `model` field on locally-generated assistant messages — subagent aggregations, tool-result echoes, `/compact` summaries, plan-mode confirmations — which aren't real API calls. The chip now filters out any `<...>` placeholder and keeps the last real model instead of showing `<synthetic>`. `message_start` and `assistant` event handlers both apply the filter.

## v0.14.4 (2026-07-03) — Session Auto-Recovery, Workspace Dir, Model Chip

### Session lifecycle: kill the "no conversation found" foot-gun
- **Auto-recovery for orphaned Claude sessions.** When Claude Code exits with *"no conversation found with session ID: ..."* — typically because a prior spawn (e.g. a model-unavailable error) captured a session ID before Claude Code wrote the conversation file to disk — vibectl now detects the stderr line, clears the orphan from `chat_sessions` via a new `ClearSession` persister method, broadcasts a `session_lost` typed event, and the frontend remounts into a fresh launch. No user intervention, no misleading "Claude exited" panel.
- **Deferred session-ID persistence.** vibectl no longer writes `claudeSessionId` on the Claude Code `init` event. It waits for the first `assistant` message, which is the boundary at which Claude Code commits the on-disk conversation log. Orphans are no longer created in the first place.
- **`SendMessage` / `SendControlResponse` fail fast on a dead session.** Writing to a closed stdin pipe used to surface as *"write |1: file already closed"* — a meaningless error. Both now check `sess.exited` up front and return `SESSION_ENDED:` with a hint to reset. The frontend already handles that gracefully.
- **Redundant `system_error` broadcast suppressed after `session_lost`.** Prevents the stale "Claude exited" panel from flashing over the auto-recovery.
- **`chat_sessions` no longer persists uncommitted spawns on exit.** If Claude never produced an assistant message, the exit path skips the final upsert — reinforcing the deferred-persistence guarantee above.

### Per-user workspace directory (finally wired end-to-end)
- **User → Account → Local Config tab** — a new tab with an absolute-path input for the per-user workspace directory. Live preview shows what "New project" and "Clone" paths will resolve to.
- **`SuggestNewPath` / `SuggestPath` / `RepoDirForURL`** now honor the current user's `workspaceDir`, falling back to the server's `REPOS_DIR` only when unset. Fixes the *"/data/repos is read-only"* dead end on standalone dev.
- **`/api/v1/clone/*` stays local under delegation.** Path suggestions depend on the local user record and the local filesystem — they must not proxy to a remote that has neither. Fixes suggestions returning `/data/repos/...` even after setting workspaceDir.

### Active-model chip + interactive `/model` picker
- **Model chip in the chat status bar** (right of the connection status word). Shows the model Claude is actually using — sourced from `message_start` and `assistant` events. Falls back through `project.model` → `settings.defaultModel` → an italic "set model" affordance so the picker is always one click away.
- **Same chip appears in the project card header** for at-a-glance visibility across cards.
- **Bare `/model` opens an interactive picker overlay** (reusing the `ModelPicker`) with the current model pre-selected. Save & restart writes the per-project override, kills the current spawn, and re-launches — same flow as the `model_unavailable` picker. Power-user escape hatch: `/model <id>` still takes the literal argument.
- **Context-health chip guarded** to hide when there's no grade or a zero score (was rendering a bare "0" on fresh sessions).

## v0.14.3 (2026-06-17) — Claude Model Selection

### Added
- **Default Claude model in Settings.** Settings → Default Claude Model picks a model that every Claude Code spawn uses unless overridden per-project. Empty (default) leaves model selection to Claude Code's own config.
- **Per-project model override** in the project card's Settings tab. Falls back to the server default when empty.
- **`GET /api/v1/models`** queries `api.anthropic.com/v1/models` using the server's `ANTHROPIC_API_KEY` and caches the result for 5 minutes. The picker UI loads the list on mount; `?refresh=1` or the ↻ button bypasses the cache. Local route under delegation (uses the local key, not the remote's).
- **`model_unavailable` typed event** is broadcast over the chat WebSocket when Claude Code rejects the selected model. Detected via stderr ("issue with the selected model") *and* stdout `result` events with `is_error: true` — Claude Code uses both channels depending on when the error fires. ChatView surfaces an inline picker; selecting a model writes the per-project override, sends a `kill` WS message to terminate the broken spawn, then triggers a fresh launch that picks up the new model.

### Resolution order
At spawn time: `project.model` → `settings.defaultModel` → unset (Claude Code uses its own default).

## v0.14.2 (2026-05-27) — Cache-Optimizer Trace Recording

### Added
- **Optional per-spawn Anthropic API trace recording.** When `VIBECTL_RECORD_TRACES=1`, vibectl wraps each Claude Code subprocess with a local recording sidecar (from the cache-optimizer project) and points `ANTHROPIC_BASE_URL` at it. The sidecar transparently proxies traffic to `api.anthropic.com` while writing full request/response JSON traces to `~/.vibectl/traces/<spawnID>.json` in cache-optimizer corpus format (system prompt, tools, messages, assistant response, tool calls, token counts incl. cache read/creation).
- Configuration via env vars: `VIBECTL_RECORDING_PROXY_CMD`, `VIBECTL_RECORDING_PROXY_DIR`, `VIBECTL_TRACE_OUTPUT_DIR`. See README and CLAUDE.md.
- Non-fatal degradation: if the sidecar fails to start, Claude Code launches normally without recording.

## v0.14.1 (2026-05-03) — Token Optimizer Integration

### Added
- **Context health badge**: Claude Code status bar shows quality grade (A 87, C 52, etc.) from token-optimizer when installed. Color-coded green/amber/red. Hover shows compaction count and context loss. Refreshes every 30s.
- **Context health in Rounds**: Each project in the round shows its context quality score. Degraded sessions (>50% context lost to compactions) get a red warning with recommendation to /fresh.
- **Waste findings badge**: Mission Control header shows optimization opportunities detected by token-optimizer (e.g., "2 optimizations"). Hover shows details.
- **Project health endpoint**: `GET /admin/adapters/project-health/{projectCode}` resolves project → session → adapter data in one call.
- **Integrations tab in user profile**: Moved from server Settings to per-user account settings. Shows detected adapters, recommended plugins with feature checklists.

---

## v0.14.0 (2026-05-03) — Plugin Manager & Dynamic Slash Commands

### Added
- **Plugin Manager**: `/plugins` slash command opens a full plugin management modal with three tabs:
  - **Installed**: List installed Claude Code plugins with on/off toggles, version info, commands, skills, and uninstall
  - **Browse**: Search and install from marketplace with popularity rankings (500+ plugins)
  - **Marketplaces**: View and add marketplace sources (GitHub repos)
- **Dynamic slash command autocomplete**: Plugin commands (from `commands/*.md`) and skills (from `skills/*/SKILL.md`) are discovered from installed plugins and merged into the chat autocomplete. Plugin commands show source badge (e.g., `[token-optimizer]`).
- **Restart after changes**: Banner prompts to restart Claude Code after plugin enable/disable/install/uninstall, using existing `/reload` mechanism.
- **Plugin API endpoints**: `GET /admin/plugins`, `GET /admin/plugins/commands`, `GET /admin/plugins/available`, marketplace management, enable/disable/install/uninstall.
- **VIBECTL.md auto-regeneration**: Regenerated on Claude Code session start for fresh project context.
- **VIBECTL.md auto-gitignore**: Automatically added to `.gitignore` on first generation.
- **Project status notes**: Editable status field on project cards (Claude Code header) and in Rounds overlay. Yellow-tinted for "blocked"/"waiting" keywords.
- **JSON tree viewer**: File browser renders JSON files as collapsible/expandable tree with smart default expansion and Expand/Collapse All.
- **Markdown preview**: File browser defaults to rendered markdown preview for `.md` files.
- **Inline issue detail**: Clicking an issue in project card shows detail inline instead of navigating to a new page.
- **Issue form persistence**: New issue form saves draft to sessionStorage, survives tab switches. Repro steps optional.
- **Smart git pull**: Pull checks for uncommitted changes first, offers Commit & Pull, Pull Anyway, or Cancel.
- **Reset Session button**: Appears on disconnected/error/exited Claude Code status for recovering stuck sessions.

### Fixed
- VIBECTL.md uses project code instead of MongoDB ObjectID.
- Multiple ID→code fallback fixes across handlers (filesystem, issues, vibectl-md) for delegation compatibility.
- File editor discard no longer causes blank screen (portal stopPropagation fix).
- Removed dangerous Remove button from Claude Code header; Pull/Remove moved to Files tab.

---

## v0.13.0 (2026-04-29) — Project Rounds

### Added
- **Project Rounds**: Step-through workflow that visits each active project one at a time, showing actionable context (open issues, pending feedback, health status, recent intents) and letting you take action — send a prompt to Claude Code, save a note for next round, snooze the project, or skip. "Start Round" button in Mission Control header.
- **Project notes**: Scratch notes attached to a project that surface during the next round. One note per project, upserted via rounds or API.
- **Project snooze**: Temporarily hide a project from rounds (1 day, 3 days, 1 week, 2 weeks). Snoozed projects reappear automatically when the snooze expires.
- **Round summaries**: Audit trail of completed rounds — projects visited, actions taken (prompts, notes, snoozes, skips), duration.
- **Keyboard-driven flow**: Enter (send/save), S (skip), N (note mode), Z (snooze), Escape (exit). Keyboard hints at the bottom of the overlay.
- **Round context endpoint**: `GET /api/v1/rounds/context` aggregates per-project data for the step-through (issues, feedback, health, intents, notes, snooze status) in parallel.
- **New endpoints**: `POST /api/v1/rounds` (record round), `PUT /api/v1/project-notes/{code}` (upsert note), `DELETE /api/v1/project-notes/{code}`, `POST /api/v1/projects/{id}/snooze`, `POST /api/v1/projects/{id}/unsnooze`.

---

## v0.12.4 (2026-04-23) — Accept with Comments, Chat Loading States & Fixes

### Added
- **Accept with Comments**: Feedback detail modal has a new "Accept with Comments" button. Opens an inline textarea for developer notes (context, clarification, implementation hints) that are saved on the feedback item, displayed in the detail modal, and included as "Developer notes" in generated prompts.
- **Chat session loading indicator**: When a Claude Code tab is loading/replaying a session, shows animated dots with "Loading chat session..." instead of a blank screen. Input is disabled and grayed out until replay completes.

### Fixed
- **Fullscreen WebSocket persistence**: WebSocket connections cached at module level survive fullscreen portal remounts — no more disconnect/reconnect losing streaming output.
- **Feedback prompt visibility**: External prompts dispatched to Claude Code now reliably appear in the chat history. Fixed race condition between replay and message injection by checking replay state before sending.
- **Generate Prompt button visibility**: Button counts accepted-unsubmitted items from full feedback list, not the filtered "Needs Review" view.
- **Feedback project filter**: Dropdown now uses project codes instead of ObjectIDs, fixing filtering in delegated mode.

---

## v0.12.3 (2026-04-23) — Feedback Queue & Fullscreen Fix

### Changed
- **Feedback page defaults to "Needs Review"**: Only shows pending and triaged items by default, acting as an actionable review queue rather than a full history dump. "All Statuses" and individual status filters still available in the dropdown.

### Fixed
- **Fullscreen WebSocket persistence**: Toggling fullscreen no longer kills the Claude Code WebSocket connection. WebSocket connections are cached at module level and reattached on remount, preserving streaming output and session state.
- **Feedback prompt visibility in chat**: Prompts dispatched from the feedback pipeline now reliably appear in the chat message history. Fixed race condition where the message was sent to Claude but not rendered in the UI due to replay timing. External messages now check replay state before sending, and the queue flush path adds messages to the display array.
- **Generate Prompt button with default filter**: Button now counts accepted-unsubmitted items from the full feedback list, not the filtered view, so it appears even when the "Needs Review" filter is active.

---

## v0.12.2 (2026-04-23) — Per-Developer Productivity, Feedback Prompts & Performance

### Added
- **Per-developer attribution**: Intents, code deltas, and chat history now track `userId` and `userName` of the developer who initiated the session. All productivity and analytics data can be sliced by developer.
- **Chat WebSocket auth**: Chat sessions now authenticate via `?token=` query param (same as shell), threading user identity from connection through to intent extraction.
- **Developer filter**: Productivity and Analytics tabs in Mission Control have a developer dropdown that filters all metrics by a specific team member. Only shows when multiple users exist.
- **Feedback-to-prompt pipeline**: "Generate Prompt" button compiles accepted feedback into a structured prompt for Claude Code. Includes safety scanning (regex-based detection of shell injection, credential exfil, prompt injection), editable review modal with standing advisory, and one-click dispatch to a project's Claude Code session with automatic navigation.
- **Project picker for prompt generation**: When viewing all projects, "Generate Prompt" opens a modal listing only projects with accepted-unsubmitted feedback, with counts per project.
- **Feedback pagination**: Feedback page now paginates at 25 items per page with Previous/Next navigation.
- **Prompt batch tracking**: PromptBatch records create an audit trail linking feedback items to the prompts sent to Claude Code. Intent extractor detects batch markers and links extracted intents back to originating feedback.
- **Intent delegation fix**: `/api/v1/intents*` routes are now local in delegation mode. Extracted intents are pushed to the remote server for team aggregation, with deduplication by sessionID.
- **Intent ingest endpoint**: `POST /api/v1/intents/ingest` accepts intents from delegated instances, deduplicating by session IDs.
- **Developer badge on intents**: Individual intent rows in project cards show the developer's name.
- **Progressive dashboard loading**: Dashboard grid renders immediately from a fast project list query while rich summary data (issue counts, sessions, roles) loads progressively in the background.

### Fixed
- Productivity and Analytics tabs now show data correctly in delegated standalone mode (intents were proxied to remote which had no local extraction data).
- Dashboard backend parallelized: per-project queries (issue counts, sessions, roles) now run concurrently via goroutines instead of sequentially, ~3-4x faster for 10+ projects.
- Feedback project filter dropdown now uses project codes (was using ObjectIDs, breaking filtering in delegated mode).
- PromptReviewModal null safety fix for warnings array.

---

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
