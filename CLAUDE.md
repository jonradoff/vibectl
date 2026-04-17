Read VIBECTL.md for current project status, deployment details, and issue context before starting work.

# Build & Restart

VibeCtl is a self-hosted tool that may be running its own Claude Code sessions. When you make changes to Go backend code or frontend code that requires a server restart, use the rebuild endpoint:

```
curl -X POST http://localhost:4380/api/v1/admin/rebuild
```

This will:
1. Broadcast a "server_restarting" event to all connected WebSocket clients (the UI shows a rebuild overlay)
2. Rebuild the Go server binary (`go build -o vibectl-server ./cmd/server/`)
3. Replace the running process with the new binary via `syscall.Exec`

**When to trigger a rebuild:**
- After changing any Go source files (`*.go`) in `cmd/`, `internal/`, or `pkg/`
- The frontend uses Vite with HMR, so `.tsx`/`.ts` changes are picked up automatically — no rebuild needed for frontend-only changes

**When NOT to trigger a rebuild:**
- For frontend-only changes (Vite HMR handles these)
- When only editing non-code files like docs or config

**Self-rebuild flow:**
- `syscall.Exec` replaces the process in-place (same PID, no downtime gap)
- If `syscall.Exec` fails, the process exits and `run-server.sh` (the dev wrapper) automatically rebuilds and restarts
- The frontend shows a "VibeCtl is rebuilding" overlay during this process and auto-reconnects when the server is back
- Your Claude Code session state is persisted and will resume after restart

**Important:** The server MUST be started from the compiled binary (via `make dev` or `./run-server.sh`), NOT via `go run`. The `go run` command spawns a child process that `syscall.Exec` cannot replace.

# Docs Maintenance

Keep the following documentation in sync when making changes:

- **`docs/api.md`** and **`frontend/src/pages/docs/APIDocsPage.tsx`** — Update when adding, removing, or changing any API endpoints.
- **`docs/mcp.md`** and **`frontend/src/pages/docs/MCPDocsPage.tsx`** — Update when adding, removing, or changing any MCP tools.
- **`docs/cli.md`** and **`frontend/src/pages/docs/CLIDocsPage.tsx`** — Update when adding, removing, or changing CLI commands.
- **`skill.md`** — Update when MCP tools change (this is the machine-readable descriptor Claude uses to understand the tool).
- **`CHANGELOG.md`** — Add an entry for every release / significant feature.
- **`README.md`** — Keep the feature overview, CLI reference, and MCP examples up to date.

# Project Script Conventions

VibeCtl expects projects to follow these conventions for deployment automation. When these files exist at the root of a project directory, they are automatically detected and used to pre-configure the project's Deployment Settings.

## `deploy.sh`
Automates the full deployment pipeline to production. Typically wraps steps like building, pushing to a registry, and deploying (e.g., `fly deploy`). Mapped to the **deployProd** command.

## `start.sh`
Starts (or restarts) the local development server. Should be idempotent — safe to run repeatedly. Typically kills any running process on the dev port and starts it fresh. Mapped to the **startDev** command.

Both scripts should be executable (`chmod +x`) and live at the repo root. VibeCtl runs them from the project's local path directory.

When a `fly.toml` is also present, the Fly app name is extracted and used to derive `fly apps start`, `fly apps restart`, and `fly logs` commands for **startProd**, **restartProd**, and **viewLogs** respectively.

Auto-detection is run:
- During project creation (for "Use local path" mode, where the directory already exists)
- As a background step immediately after creation in Clone/New modes
- On demand via the "⚡ Examine fly.toml" and "⚡ Detect start.sh" buttons in project Settings

# Claude Code Auth & Session Management

VibeCtl spawns Claude Code processes in stream-json mode (`-p --input-format stream-json --output-format stream-json`). Key rules for auth and sessions:

## Token handling — never override native auth

- **Do NOT pass `CLAUDE_CODE_OAUTH_TOKEN`** from the macOS keychain. Claude Code manages its own token refresh cycle via the keychain. Forcing a snapshot as an env var causes 401s when the token rotates.
- Only set `CLAUDE_CODE_OAUTH_TOKEN` for **explicitly user-provided tokens**: per-project tokens set via `/login`, or tokens stored in the persistent token file (`~/.vibectl/.claude-oauth-token` or `/data/.claude-oauth-token`).
- Reading credentials is fine for **read-only purposes** (e.g., computing a stable hash for usage tracking identity, subscription usage API), but never inject them into the process environment.
- **Credential location changes between Claude Code versions.** Always check both: (1) macOS keychain service `Claude Code-credentials` account `$USER`, and (2) `~/.claude/.credentials.json` → `claudeAiOauth.accessToken`. The `readClaudeTokenFromKeychain()` function handles both.

## Session resume (`--resume`)

- `/compact` and `/reload` kill the Claude process and restart with `--resume <sessionID>`. This preserves conversation context and reloads MCPs (fresh process).
- `/fresh` starts a brand new session with no `--resume` — all prior context is lost. Use when the session is poisoned (e.g., oversized images in context).
- During restart, the WebSocket stays open but there's no active Claude session. Messages sent during this window must be **queued** (via `pendingMessagesRef` / `compactingRef`) and flushed after `restarted` status arrives.

## Auth error handling

- Auth errors (401, `authentication_error`) must show the **login UI** (not auto-restart), because auto-restart with bad credentials loops forever.
- Auth errors can arrive via two paths: `error` type events (from stderr) and `result` type events with `is_error: true`. **Both** must route to the login UI.
- The `isNotLoggedIn` check in the exit error panel must match both "not logged in" strings AND `authentication_error` / `invalid authentication` strings.

## Permission modes

- Default: `--permission-mode acceptEdits` (auto-approves reads/edits, blocks dangerous ops).
- Plan mode tools (`EnterPlanMode`, `ExitPlanMode`) must be in `--allowedTools` — otherwise `acceptEdits` silently denies them and plan mode gets stuck.
- `--dangerously-skip-permissions` is used when the user sets permissions to "auto" via `/permissions auto`.

# UI Conventions

- **No browser dialogs** — Never use `confirm()`, `alert()`, or `prompt()`. Always use a styled React modal instead.
- **Project cards are the primary interface for project settings and operations.** All project-level configuration (name, description, tags, health checks, deployment, etc.) is managed through the Settings tab of the project card (`CompactSettings` component). Other tabs provide views: Claude Code (terminal), Issues, Feedback, Files, Health, Intents, CI, Session History, Activity Log. New project-level features should be added as tabs or settings within the project card, not as standalone pages.
- **Tags are project-level labels** set in the project card Settings tab, used for filtering in Mission Control (Projects tab, Productivity tab). These are distinct from intent-level tech tags which are auto-extracted.

# Feedback API — Collecting End-User Feedback from External Products

External products can submit end-user feedback to VibeCtl via the REST API. Feedback enters the same pipeline as manual and GitHub-sourced feedback: it appears in the project's Feedback tab, can be AI-triaged, reviewed (accepted/dismissed), and converted to issues.

## Authentication

All feedback submissions require an API key. Create one in VibeCtl under your user profile or via `POST /api/v1/api-keys`. The key is prefixed with `vk_` and used as a Bearer token.

## Submitting Feedback

```bash
POST /api/v1/feedback
Authorization: Bearer vk_YOUR_API_KEY
Content-Type: application/json

{
  "projectCode": "MYAPP",
  "rawContent": "The export button doesn't work on Safari",
  "sourceType": "feedback_api",
  "submittedBy": "user@example.com",
  "sourceUrl": "https://myapp.com/support/ticket/4521",
  "metadata": {
    "userId": "usr_abc123",
    "appVersion": "2.4.1",
    "browser": "Safari 17.4",
    "page": "/dashboard/reports",
    "plan": "pro",
    "environment": "production"
  }
}
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `projectCode` | Yes* | Project code (e.g., `"LOFP"`, `"MYAPP"`). Alternative to `projectId`. |
| `projectId` | Yes* | MongoDB ObjectID hex. Use `projectCode` instead for readability. |
| `rawContent` | Yes | The feedback text. HTML tags are stripped for XSS protection. |
| `sourceType` | No | Defaults to `"feedback_api"`. Other values: `"manual"`, `"github"`, `"support"`, or any custom string. |
| `submittedBy` | No | Identity of the end user who gave the feedback (email, username, etc.). |
| `sourceUrl` | No | URL in the originating system (support ticket, forum post, etc.). Used for deduplication. |
| `metadata` | No | Arbitrary JSON object with structured context. Displayed in the feedback detail modal and available to the AI triage agent. |

*One of `projectCode` or `projectId` is required.

### Batch Submission

```bash
POST /api/v1/feedback/batch
Authorization: Bearer vk_YOUR_API_KEY

[
  { "projectCode": "MYAPP", "rawContent": "...", "submittedBy": "user1@example.com" },
  { "projectCode": "MYAPP", "rawContent": "...", "submittedBy": "user2@example.com" }
]
```

## Security

- **Authentication required** — every submission must include a valid API key.
- **HTML stripping** — all `<tags>` are stripped from `rawContent` to prevent XSS.
- **LLM injection protection** — downstream AI triage wraps feedback in `<user-content>` tags to isolate it from system prompts.
- **API key identity recorded** — each feedback item records which API key authorized the submission (`submittedViaKey` field).
- **Deduplication** — if `sourceUrl` is provided, duplicate submissions with the same URL are rejected.

## Webhooks

Configure webhooks in project Settings to receive notifications:
- `feedback_created` — fires when new feedback is submitted
- `feedback_triaged` — fires when AI triage completes

## Feedback Lifecycle

1. **Submitted** → status: `pending`
2. **AI Triaged** → status: `triaged` (proposal attached)
3. **Human Review** → status: `accepted` or `dismissed`
4. **Issue Created** (optional) → linked issue key attached

## Integration Pattern

The recommended pattern for external products:

1. Collect feedback in your product's UI (form, widget, in-app modal)
2. Your product's backend submits to VibeCtl server-to-server with an API key
3. Include `metadata` with user context (who, where, what version)
4. VibeCtl's AI triage analyzes and proposes an issue
5. You review in VibeCtl's Feedback tab and accept/dismiss

# Productivity Measurement System

VibeCtl tracks developer productivity through an **intent-oriented** system, not lines of code.

## Core Concepts

**Intents** are units of developer work extracted automatically from completed chat sessions. When a session is archived, Haiku analyzes the conversation (user prompts, tool calls, files edited, bash commands) and classifies what was accomplished.

Each intent has:
- **Title + description** — what was done
- **Category** — UI, API, infra, data, test, docs, bugfix, refactor
- **Size** — S (1pt), M (3pt), L (5pt), XL (8pt) based on scope
- **Status** — delivered, partial, abandoned, deferred
- **Tech tags** — auto-detected languages/frameworks
- **UX judgment** — low/medium/high (how much visual taste was required)

## Design Principles

1. **Zero manual input for creation** — intents are extracted automatically from chat session data we already capture. The developer never has to log work.

2. **Human review for completion** — Haiku should err on the side of marking intents "partial" rather than "delivered." The developer confirms delivery via "Mark Complete" in the project card Intents tab. This is deliberate: conservative auto-classification ensures nothing falls through.

3. **Points measure scope, not time** — A 5-point intent means it crossed multiple layers (frontend + backend), not that it took 5 hours. Points are relative effort indicators for portfolio-level analysis.

4. **Tokens-per-point is the novel metric** — This measures AI efficiency by category. If UI tasks cost 4x the tokens per point of API tasks, that's actionable signal about where Claude Code adds the most value.

5. **Tags are for portfolio filtering, not intent classification** — Project-level tags (set in Settings) let you slice the dashboard by project groups. Intent-level tech tags are auto-extracted and separate.

## What the Data Shows

- **Points by Category** (donut) — Am I building or maintaining?
- **Investment by Project** (donut) — Where is my effort going?
- **Points Over Time** (stacked area) — Is my output shifting?
- **Tokens per Point** (bar) — Where is AI most/least efficient?
- **Delivery Funnel** — How much work is falling through vs. completing?

## What the Data Cannot Show

- Whether you're working on the *right* things — points say nothing about business value
- Accurate velocity trends — sizing is approximate and auto-generated
- Cross-person comparisons — calibrated for one person's workflow

## Data Flow

1. User sends prompt → chat session captures messages (tool_use blocks, file paths, bash commands)
2. Session ends → archived to `chat_history` collection
3. Archive triggers async Haiku analysis → `intents` collection
4. `code_deltas` capture per-file git diff stats between prompts (enrichment data)
5. Analytics tab aggregates intents by time range, tag, category, project
6. Backfill endpoint processes historical sessions that predate the feature

## Collections

- `intents` — extracted developer intents with sizing, status, tech tags
- `code_deltas` — per-prompt git diff stats with file-level detail
- `chat_history` — archived session transcripts (source data for extraction)
- `claude_usage_records` — per-response token counts (90-day TTL)

## Key Implementation Notes

- Intent extraction uses `claude-haiku-4-5-20251001` via the Anthropic API (`ANTHROPIC_API_KEY` required)
- Messages in `chat_history` are stored as BSON Binary — the extractor scans for the first `{` to find the JSON payload
- Sessions with no extractable user prompts get a skip placeholder (`analysisModel: "skip"`) to prevent re-processing
- Skip placeholders and zero-projectId intents are filtered out of all API queries
- Deleted projects are excluded from productivity aggregation (intents remain but are hidden)
- Backfill processes 3 sessions per batch synchronously to avoid race conditions and API overload

# Delegation Model

VibeCtl instances can operate in two standalone modes:

## Isolated (default)
Everything runs locally against local MongoDB. No remote connection. Current behavior.

## Delegated
Claude Code sessions, chat history, code deltas, terminals stay local. Everything else (projects, issues, feedback, intents, prompts, members, decisions, health, activity log) is proxied to a remote vibectl server via API key.

### How it works
- A chi middleware (`ProxyMiddleware`) sits inside the protected route group
- Routes are classified as "local" or "delegated" by path prefix (`delegation/router.go`)
- Delegated routes are reverse-proxied to the remote, with the local auth header replaced by the stored API key
- The remote enforces access controls — the API key's user determines permissions
- WebSocket routes (`/ws/*`) are always local

### Configuration
- Only `super_admin` can enable/disable delegation (Settings page)
- Stored in the `settings` MongoDB collection: `delegationEnabled`, `delegationUrl`, `delegationApiKey`, `delegationUser`
- API key stored in MongoDB (never sent to frontend via `json:"-"`)
- Survives server restarts (restored from settings on boot)

### What stays local
`/api/v1/auth/*`, `/api/v1/admin/*`, `/api/v1/delegation/*`, `/api/v1/settings`, `/api/v1/chat-session/*`, `/api/v1/chat-history/*`, `/api/v1/claude-usage/*`, `/api/v1/mode`, `/api/v1/api-keys`, file operations, all WebSocket endpoints

### What gets delegated
`/api/v1/projects/*` (except chat-session/chat-history/files sub-routes), `/api/v1/issues/*`, `/api/v1/feedback/*`, `/api/v1/intents/*`, `/api/v1/prompts/*`, `/api/v1/dashboard/*`, `/api/v1/plans/*`, `/api/v1/activity-log/*`, `/api/v1/sessions/*`, `/api/v1/health-check/*`

### Edge cases
- Remote down: 503 `DELEGATION_UNAVAILABLE` on delegated routes; local routes unaffected
- API key revoked: 401 from remote transformed to 502 `DELEGATION_AUTH_FAILED`
- No delegation chains: test connection rejects servers that are themselves delegated
- Existing local data hidden (not deleted) while delegation active; reappears on disconnect

# Tech Stack

- Backend: Go with chi router, MongoDB
- Frontend: React + TypeScript + Vite + Tailwind CSS
- Terminal: xterm.js (PTY mode) and stream-json chat mode
- Build: `make build` (full), `make build-server` (server only), `make check` (type check both)
- Dev: `make dev` (runs `./run-server.sh` — builds + runs binary with auto-restart), `make frontend-dev` (Vite dev server on port 4370)
